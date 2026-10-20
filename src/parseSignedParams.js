const verifySignature = require('./verifySignature');
const extractQueryString = require('./extractQueryString');
const query = require('querystring');

module.exports = function parseSignedParams(urlOrString, key) {
  const queryString = extractQueryString(urlOrString);
  return queryString && verifySignature(queryString, key)
    ? query.parse(queryString)
    : {};
};
