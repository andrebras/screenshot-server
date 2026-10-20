const logger = require('./logger');

module.exports = function respondWithError(res, code, err) {
  if (err) {
    logger.error(`HTTP Error ${code}`, {
      statusCode: code,
      error: String(err)
    });
  }
  res.writeHead(code);
  res.end();
};
