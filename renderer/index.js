const http = require('http');
const {timingSafeEqual} = require('crypto');
require('../src/appsignal').init();
const {instrument, renderStarted, renderFinished, addError, stop} = require('../src/appsignal');
const {launchBrowser, closeBrowser, isConnected, withIsolatedPage} = require('../src/browser');
const sourceRefusal = require('../src/sourceRefusal');
const paramsRefusal = require('../src/paramsRefusal');
const renderOutcome = require('../src/renderOutcome');
const logger = require('../src/logger');
const render = require('./render');

const token = process.env.RENDERER_TOKEN;
if (!token) throw new Error('RENDERER_TOKEN is required');
const capacity = Number(process.env.RENDER_SLOTS || 2);
if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid RENDER_SLOTS');
let active = 0;
let draining = false;
const authorized = (req) => {
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};
const respond = (res, code, body = '') => {
  if (!res.destroyed && !res.writableEnded) res.writeHead(code, {'Cache-Control': 'no-store'}).end(body);
};
const withAbort = async (promise, signal) => {
  signal.throwIfAborted();
  let reject;
  const aborted = new Promise((_, no) => {reject = no});
  const abort = () => reject(signal.reason);
  signal.addEventListener('abort', abort, {once: true});
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', abort); }
};
const server = http.createServer((req, res) => {
  if (!authorized(req)) return respond(res, 401);
  if (req.url === '/live') {
    const connected = isConnected();
    if (!connected && !draining) launchBrowser();
    return respond(res, connected && !draining ? 200 : 503);
  }
  if (req.url !== '/render' || req.method !== 'POST') return respond(res, 404);
  if (draining || active >= capacity) return respond(res, 503);
  active += 1;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 35000);
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', abort);
  req.on('aborted', abort);
  const started = performance.now();
  instrument('render screenshot', {}, (done) => {
    renderStarted(active);
    (async () => {
      let failure;
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 16384) return respond(res, 400);
        }
        let spec;
        try { spec = JSON.parse(body); } catch { return respond(res, 400); }
        if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.src !== 'string') return respond(res, 400);
        const refusal = paramsRefusal(spec) || (await withAbort(sourceRefusal(spec.src), controller.signal));
        if (refusal || !['assets', 'networkidle0'].includes(spec.readiness)) return respond(res, 400);
        controller.signal.throwIfAborted();
        const image = await withIsolatedPage((page) => render(page, spec), controller.signal);
        if (image.length > 32 * 1024 * 1024) throw new Error('Rendered image exceeds limit');
        if (!res.destroyed) res.writeHead(200, {'Content-Type': 'image/jpeg'}).end(image);
      } catch (err) {
        failure = err;
        addError(err);
        respond(res, controller.signal.aborted ? 504 : 502);
      } finally {
        clearTimeout(deadline);
        res.off('close', abort);
        req.off('aborted', abort);
        active -= 1;
        renderFinished(renderOutcome(failure), performance.now() - started);
        done();
      }
    })();
  });
});
server.headersTimeout = 5000;
server.requestTimeout = 40000;
server.listen(Number(process.env.RENDERER_PORT || 3002), '127.0.0.1', launchBrowser);
process.on('SIGTERM', () => {
  if (draining) return;
  draining = true;
  const hardStop = setTimeout(() => process.exit(1), 25000);
  server.close(async () => {
    await closeBrowser().catch((err) => logger.error(err));
    await stop().catch((err) => logger.error(err));
    clearTimeout(hardStop);
    process.exit(0);
  });
});
