const {isConnected} = require('./browser');

// Liveness: Kubernetes restarts the container when this fails. It never looks at render slots,
// so a busy pod is not restarted for being busy; taking it out of rotation is /ready's job.
module.exports = (_, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.writeHead(isConnected() ? 200 : 503);
  res.end();
};
