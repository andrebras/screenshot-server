module.exports = function respondToHealthCheck(_, res) {
  res.setHeader('Cache-Control', 'no-cache');
  res.writeHead(200);
  res.end();
};
