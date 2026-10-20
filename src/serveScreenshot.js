const parseSignedParams = require('./parseSignedParams');
const sourceRefusal = require('./sourceRefusal');
const paramsRefusal = require('./paramsRefusal');
const respondWithError = require('./respondWithError');
const logger = require('./logger');
const pluckNumbers = require('./pluckNumbers');
const renderOutcome = require('./renderOutcome');
const {
  startSpan,
  renderStarted,
  renderFinished,
  addError,
  tagSourceHost,
} = require('./appsignal');
const {withPage} = require('./browser');
const {randomUUID} = require('crypto');
const {URL} = require('url');
const {
  env,
  screenshotServerKey,
  screenshotUserAgent,
  ONE_DAY,
} = require('./config');

let inFlight = 0;

// One log line per request, so render errors go to AppSignal through addError, not logger.error.
// The source page is logged without its query, which can carry the page's own tokens.
module.exports = async function serveScreenshot(req, res) {
  const startedAt = performance.now();
  const params = parseSignedParams(req.url, screenshotServerKey);
  const src = params.src ? URL.parse(params.src) : null;
  const refusal = params.src && (paramsRefusal(params) || (await sourceRefusal(params.src)));
  // An ALB's trace id when one fronts the service, so a request can be followed from its access
  // log. Traefik adds none, so behind it this is always a fresh UUID.
  const line = {
    request_id: req.headers['x-amzn-trace-id'] || randomUUID(),
    src_host: src?.hostname,
    src_path: src?.pathname,
  };
  if (refusal) {
    // Signed, but not a page this service renders: the caller and the log line get the reason.
    line.refused = refusal;
    res.writeHead(400, {'Content-Type': 'text/plain'});
    res.end(refusal);
  } else if (src) {
    tagSourceHost(src.hostname);
    inFlight += 1;
    renderStarted(inFlight);
    try {
      await withPage(async (page) => {
        const screenshotSpan = startSpan('take screenshot and respond');
        await respondWithScreenShot(page, params, res, line);
        screenshotSpan.end();
      });
    } catch (err) {
      // No page to render on: the launch or newPage failed. respondWithScreenShot answers its
      // own errors, and the browser module has already forgotten a dead browser.
      respondWithError(res, 502);
      addError(err);
      line.failure = 'service';
    } finally {
      inFlight -= 1;
    }
  } else {
    respondWithError(res, 400);
  }
  logger[line.failure ? 'error' : 'info'](`${req.method} /screenshots`, {
    ...line,
    status: res.statusCode,
    duration_ms: Math.round(performance.now() - startedAt),
  });
};

async function respondWithScreenShot(page, params, res, line) {
  const startedAt = performance.now();
  let failure;
  try {
    const maxHeight = params.maxHeight ? parseInt(params.maxHeight, 10) : null;
    const image = await takeScreenshot(
      page,
      params.src,
      maybeViewport(params),
      maybeClip(params),
      maxHeight,
      line,
    );
    setHeaders(res);
    res.write(image);
    res.end();
  } catch (err) {
    failure = err;
    respondWithError(res, 502);
    addError(err);
    line.failure = ['timeout', 'upstream_error'].includes(renderOutcome(err)) ? 'upstream' : 'service';
  } finally {
    renderFinished(renderOutcome(failure), performance.now() - startedAt);
  }
}

async function takeScreenshot(
  page,
  url,
  viewport = null,
  clip = null,
  maxHeight = null,
  line,
) {
  await page.setUserAgent(screenshotUserAgent);
  if (viewport) {
    await page.setViewport(viewport);
  }
  const response = await page.goto(url, {waitUntil: 'networkidle0'});
  const status = response.status();
  line.upstream_status = status;

  if (status > 400) throw new Error(`Error loading page: ${status}.`);

  if (maxHeight && viewport) {
    const contentHeight = await page.evaluate(() => document.body.scrollHeight);
    const actualHeight = Math.min(contentHeight, maxHeight);
    await page.setViewport({
      width: viewport.width,
      height: actualHeight,
    });
  }

  return page.screenshot({type: 'jpeg', quality: 95, clip});
}

function maybeViewport(params) {
  let {viewportWidth, viewportHeight} = pluckNumbers(
    params,
    'viewportWidth',
    'viewportHeight',
  );
  return viewportWidth && viewportHeight
    ? {width: viewportWidth, height: viewportHeight}
    : undefined;
}

function maybeClip(params) {
  let {x, y, width, height} = pluckNumbers(params, 'x', 'y', 'width', 'height');
  x = x || 0;
  y = y || 0;
  return x != null && y != null && width != null && height != null
    ? {x, y, width, height}
    : undefined;
}

function setHeaders(res) {
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public,  max-age=' + ONE_DAY);
}
