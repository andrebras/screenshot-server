const puppeteer = require('puppeteer');
const logger = require('./logger');
const startEgressProxy = require('./startEgressProxy');
const {startSpan, browserLaunched, instrument} = require('./appsignal');
const {hostResolverRules, maxFailedLaunches} = require('./config');

const LAUNCH_OPTIONS = {
  // src/index.js owns SIGTERM. Puppeteer's own handler would SIGKILL Chrome under the renders
  // still in flight and leave Node running.
  handleSIGTERM: false,
  args: [
    '--no-sandbox',
    ...(hostResolverRules ? [`--host-resolver-rules=${hostResolverRules}`] : []),
  ],
};

// Every TCP connection Chrome makes goes through the egress proxy, which refuses internal
// addresses and resolves names itself, so Chrome never does. <-loopback> sends loopback through it
// too, which Chrome would otherwise connect to directly. WebRTC's UDP goes around any proxy.
const egressProxy = startEgressProxy();
const launch = () =>
  egressProxy.then((proxy) =>
    puppeteer.launch({
      ...LAUNCH_OPTIONS,
      args: [...LAUNCH_OPTIONS.args, `--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>'],
    }),
  );

// The pending or settled launch, shared by every concurrent request so one process never runs
// two Chromes. Cleared whenever the browser is no longer usable: a failed launch, a crash, or a
// deliberate shutdown. The next request then launches a fresh one instead of inheriting a dead
// handle, and the launch counter records why.
let launching = null;
let launchReason = 'start';
// A Chrome that keeps failing to start is not going to recover in this container. Shutting down
// through the SIGTERM drain in src/index.js lets the container restart, and a cause that survives
// restarts shows as a crash-looping pod instead of a Running one that answers 502.
let failedLaunches = 0;
// The browser the last successful launch returned, so isConnected() can answer without awaiting
// `launching`. Never cleared: a dead or closed one answers false.
let launched = null;

const forget = (pending, reason) => {
  if (launching !== pending) return;
  launching = null;
  launchReason = reason;
};

const getBrowser = () => {
  if (launching) return launching;

  browserLaunched(launchReason);
  const pending = launch().then((browser) => {
    failedLaunches = 0;
    launched = browser;
    browser.once('disconnected', () => forget(pending, 'crash'));
    return browser;
  });
  // Handled here so a rejection is never unhandled; callers still see it.
  pending.catch(() => {
    forget(pending, 'failed_launch');
    failedLaunches += 1;
    if (failedLaunches >= maxFailedLaunches) {
      logger.error(`Chrome failed to launch ${failedLaunches} times in a row, shutting down`);
      // emit, not kill: without src/index.js's listener (the specs) this does nothing.
      process.emit('SIGTERM');
    }
  });

  launching = pending;
  return pending;
};

// Opening and closing a page never settle if Chrome dies partway through: Puppeteer waits on a
// target that never finishes, with no timeout. The disconnect is the only signal, so the wait
// ends on it. Not covered by the suite: it needs Chrome to die inside that window. Puppeteer's
// once() wraps the handler so off() could not find it, hence on() plus off() here.
const untilDisconnected = (browser, call) => {
  let gone;
  const disconnected = new Promise((_, reject) => {
    gone = () => reject(new Error('Browser disconnected'));
    browser.on('disconnected', gone);
  });
  return Promise.race([call, disconnected]).finally(() => browser.off('disconnected', gone));
};

// Runs work against a fresh page and always closes it. Callers get a page and nothing else:
// launching, reuse, crash recovery and cleanup live in here.
exports.withPage = async (work) => {
  const span = startSpan('open page');
  let page;
  try {
    const browser = await getBrowser();
    page = await untilDisconnected(browser, browser.newPage());
  } finally {
    span.end();
  }

  try {
    return await work(page);
  } finally {
    // Nothing to close once Chrome has gone, or once Chrome's shutdown has closed the page.
    const browser = page.browser();
    if (browser.isConnected() && !page.isClosed()) {
      await untilDisconnected(browser, page.close()).catch((err) => logger.error(err));
    }
  }
};

// A failure here counts towards maxFailedLaunches like any other. No request is running, so the
// launch gets a trace of its own: without one its error never reaches AppSignal, and Puppeteer's
// connection to Chrome shows up as a bare GET. done() follows logger.error because an ended span
// drops the error.
exports.launchBrowser = () => {
  instrument('launch browser', {}, (done) =>
    getBrowser()
      .catch((err) => logger.error(err))
      .finally(done),
  );
};

// Puppeteer answers from its connection's closed flag, without a round trip to Chrome.
exports.isConnected = () => Boolean(launched?.isConnected());

exports.closeBrowser = async () => {
  const pending = launching;
  launching = null;
  launchReason = 'start';
  failedLaunches = 0;
  if (!pending) return;
  // A launch that never succeeded has nothing to close.
  const browser = await pending.catch(() => null);
  if (browser?.isConnected()) await browser.close();
};

exports.withIsolatedPage = async (work, signal) => {
  signal.throwIfAborted();
  const browser = await getBrowser();
  signal.throwIfAborted();
  const createContext = browser.createBrowserContext || browser.createIncognitoBrowserContext;
  let context;
  let closing;
  const close = () => {
    if (!context) {
      browser.process()?.kill('SIGKILL');
      return Promise.resolve();
    }
    if (!closing) {
      const deadline = setTimeout(() => browser.process()?.kill('SIGKILL'), 5000);
      closing = untilDisconnected(browser, context.close())
        .catch((err) => logger.error(err))
        .finally(() => clearTimeout(deadline));
    }
    return closing;
  };
  signal.addEventListener('abort', close, {once: true});
  try {
    signal.throwIfAborted();
    context = await untilDisconnected(browser, createContext.call(browser));
    signal.throwIfAborted();
    const page = await untilDisconnected(browser, context.newPage());
    signal.throwIfAborted();
    return await work(page);
  } finally {
    signal.removeEventListener('abort', close);
    if (browser.isConnected() && context) await close();
  }
};
