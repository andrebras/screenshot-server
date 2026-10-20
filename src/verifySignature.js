const crypto = require('crypto');

function encodeQueryString(urlString) {
  const params = new URLSearchParams(urlString);
  return params.toString();
}

module.exports = function verifySignature(signedQueryString, key) {
  const [queryString, signature] = signedQueryString.split('&s=');
  const hmac = crypto.createHmac('sha256', key);
  const computedSignature = hmac
    .update(encodeQueryString(queryString))
    .digest('hex');
  return computedSignature === signature;
};
