const crypto = require('crypto');
const {screenshotServerKey} = require('./config');

module.exports = function generateSignedUrl(params) {
  // Use URLSearchParams for consistent encoding/ordering (matches server verification)
  const urlParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    urlParams.append(key, value);
  });
  const queryString = urlParams.toString();

  const hmac = crypto.createHmac('sha256', screenshotServerKey);
  const signature = hmac.update(queryString).digest('hex');

  return `?${queryString}&s=${signature}`;
};
