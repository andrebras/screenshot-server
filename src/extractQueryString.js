const URL = require('url');
module.exports = (urlOrString) =>
  (URL.parse(urlOrString).search || '').slice(1);
