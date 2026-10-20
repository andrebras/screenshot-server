const yaml = require('yamljs');
const env = process.env.NODE_ENV || 'development';
const config = yaml.load(__dirname + '/../config/screenshot_server.yml')[env];
const PORT = config.port;

require('./appsignal').init();

const logger = require('./logger');
const server = require('./server');
const {closeBrowser, launchBrowser} = require('./browser');
const {shutdownGraceMs, browserCloseMs, idleSweepMs} = require('./config');
const {stop: stopAppsignal} = require('./appsignal');

server.listen(PORT, () => {
  logger.info(`Screenshot server started on port ${PORT}`, {port: PORT});
  // Chrome starts with the process rather than with the first render: /live reports whether it
  // is connected, and a pod that has had no traffic yet must not fail that.
  launchBrowser();
  if (process.send) {
    process.send('ready');
  }
});

// Kubernetes stops a pod with SIGTERM and follows up with SIGKILL after its termination grace
// period: stop accepting, let the renders in flight finish, close Chrome, exit. A repeated
// SIGTERM changes nothing; SIGKILL is the way to hurry it.
let draining = false;
process.on('SIGTERM', () => {
  if (draining) return;
  draining = true;
  logger.info(`SIGTERM received, draining for up to ${shutdownGraceMs} ms`);
  // Requests still arriving on open keep-alive sockets are served and told not to reuse the
  // socket. Prepended, because the health check writes its head before a later listener runs.
  server.prependListener('request', (req, res) => res.setHeader('Connection', 'close'));
  // close() refuses new connections and drops the keep-alive sockets idle at that moment, but
  // never revisits one that is busy now and idle later, so sweep until the last one has gone.
  const sweep = setInterval(() => server.closeIdleConnections(), idleSweepMs);
  const deadline = setTimeout(() => server.closeAllConnections(), shutdownGraceMs);
  server.close(async () => {
    clearInterval(sweep);
    clearTimeout(deadline);
    // A wedged Chrome never answers Browser.close; Puppeteer's exit hook kills it on the way out.
    // A healthy one takes about 3 s to exit on macOS with a navigation still running, 60 ms on Linux.
    setTimeout(() => {
      logger.warn('Shutdown did not finish in time, exiting anyway');
      process.exit(1);
    }, browserCloseMs).unref();
    await closeBrowser().then(
      () => logger.info('Browser closed, exiting'),
      (err) => logger.error(err),
    );
    await stopAppsignal().catch((err) => logger.error(err));
    process.exit(0);
  });
});
