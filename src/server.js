const {instrument, dropQueryFromTrace} = require('./appsignal');

const respondToHealthCheck = require('./respondToHealthCheck');
const respondToLiveness = require('./respondToLiveness');
const serveScreenshot = require('./serveScreenshot');
const respondWithError = require('./respondWithError');

const http = require('http');
const URL = require('url');

const mount = (pathMappings) => (req, res) => {
  const reqUrl = URL.parse(req.url);
  const middleware = pathMappings[reqUrl.pathname];
  // Unknown paths share one action, or every scanner probe would become an action of its own.
  const route = middleware ? reqUrl.pathname : '404';

  dropQueryFromTrace();
  instrument(`${req.method} ${route}`, {}, (done) => {
    res.on('close', done);
    middleware ? middleware(req, res) : respondWithError(res, 404);
  });
};

module.exports = http.createServer(
  mount({
    // Until the ALB health check in the gitops manifest has moved to /ready.
    '/healthcheck': respondToHealthCheck,
    '/live': respondToLiveness,
    // Always 200 until there are render slots for readiness to count.
    '/ready': respondToHealthCheck,
    '/screenshots': serveScreenshot,
  }),
);
