const {URL} = require('url');
const resolveEgress = require('./resolveEgress');
const {maxSrcLength} = require('./config');

// Why a signed src may not be rendered, or undefined when it may: it must be one http or https
// URL of at most maxSrcLength characters whose host resolveEgress allows. The egress proxy checks
// every TCP connection Chrome makes again, redirects and subresources included; this answers the
// source page itself with a reason. A host that does not resolve passes, and the render fails on
// it as an upstream failure, as before.
module.exports = async (src) => {
  if (typeof src !== 'string') return 'src must be a single URL';
  if (src.length > maxSrcLength) return `src must be at most ${maxSrcLength} characters`;
  const url = URL.parse(src);
  if (!url) return 'src must be a valid URL';
  if (!['http:', 'https:'].includes(url.protocol)) return 'src must be an http or https URL';
  const {refused} = await resolveEgress(url.hostname);
  return refused && `src host ${refused}`;
};
