// Outcome tag for the screenshot_render_duration metric, from the error a render ended with.
// Puppeteer names its navigation timeout. A page that answered above 400 (thrown in
// serveScreenshot) or could not be reached (a Chromium net:: code) failed upstream. Anything
// else is this service's fault.
module.exports = (err) =>
  !err
    ? 'ok'
    : err.name === 'TimeoutError'
      ? 'timeout'
      : /^Error loading page|net::ERR_/.test(err.message)
        ? 'upstream_error'
        : 'error';
