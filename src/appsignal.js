const {Appsignal, setTag, setError, setRootName} = require('@appsignal/nodejs');
const {trace} = require('@opentelemetry/api');
const yaml = require('yamljs');
const os = require('os');

// One AppSignal app for every deployment; ENVIRONMENT picks the environment inside it
// (development, integration, staging, production). The pods set ENVIRONMENT; NODE_ENV stays
// unset there, so the client's own NODE_ENV fallback would label them all "development".
const appName = 'screenshot-service';
const env = process.env.ENVIRONMENT || 'development';
// The push API key is organisation-wide. Environment variable first, then the YAML fallback
// that local runs use.
const key =
  process.env.APPSIGNAL_API_KEY ||
  yaml.load(__dirname + '/../config/appsignal.yml').api_key;

let appsignal;

exports.init = function init() {
  // The client reads the deploy revision from APP_REVISION, which the Dockerfile sets from the
  // build's commit SHA. Passing `revision` here, even as null, would override it.
  appsignal = new Appsignal({
    active: env !== 'test' && Boolean(key),
    name: appName,
    pushApiKey: key,
    environment: env,
  });
};

// The SDK's documented step before the process ends: stops the probes and the agent. A no-op
// until init() has run.
exports.stop = async () => appsignal?.stop();

const getTracerInstance = (() => {
  let tracer;

  return function getTracer() {
    return (tracer = tracer || trace.getTracer(appName));
  };
})();
exports.getTracerInstance = getTracerInstance;

exports.instrument = function instrument(name, tags, work) {
  const tracer = getTracerInstance();

  tracer.startActiveSpan(name, (span) => {
    // The http instrumentation owns the root span and names it after the method alone, which
    // put every request in one action called "GET". This names the trace after the route.
    setRootName(name);
    Object.entries(tags).forEach(([tag, value]) => setTag(tag, value));
    work(() => span.end());
  });
};

exports.addError = function addException(err) {
  setError(err);
};

// The source page's host on the request's trace, set only once the signature has checked out so
// an unsigned request cannot add tag values.
exports.tagSourceHost = (host) => setTag('src_host', host);

// The http instrumentation copies the whole request URL onto the request's root span, and on
// /screenshots the query carries the signature. Called while that span is the active one, before
// instrument() starts its own, this cuts the query off both attributes.
// ponytail: only the attributes of the default (old) semantic conventions; opting in to the stable
// ones with OTEL_SEMCONV_STABILITY_OPT_IN adds url.query, which a span cannot drop once set.
exports.dropQueryFromTrace = () => {
  const span = trace.getActiveSpan();
  ['http.url', 'http.target'].forEach((key) => {
    const value = span?.attributes?.[key];
    if (typeof value === 'string') span.setAttribute(key, value.split('?')[0]);
  });
};

function startSpan(name) {
  const tracer = getTracerInstance();

  return tracer.startSpan(name);
}
exports.startSpan = startSpan;

exports.wrapStreamInSpan = function wrapStreamInSpan(stream, name) {
  let span;
  stream.on('pipe', () => {
    if (!span) span = startSpan(name);
  });
  stream.on('end', () => {
    if (span) span.end();
  });

  return stream;
};

// Custom metrics. Silent until init() has run, so the tests and the CLI helpers emit nothing.
// Names and tags are the contract with the dashboards in docs/operations.md and live only here;
// every metric carries host, the pod name, so occupancy and restarts read per pod.
const metrics = () => appsignal?.metrics();
const tagged = (tags) => ({host: os.hostname(), ...tags});

// Sampled per render rather than set as a gauge: AppSignal keeps one gauge value per minute,
// which reads 0 whenever the minute's last render has finished. Mean and p95 say how full the
// pod is. PLAT-728 adds the slot cap it is compared against.
exports.renderStarted = (occupancy) =>
  metrics()?.addDistributionValue('screenshot_slots_active', occupancy, tagged());

exports.renderFinished = (outcome, durationMs) => {
  if (outcome === 'timeout') {
    metrics()?.incrementCounter('screenshot_render_timeouts', 1, tagged());
  }
  metrics()?.addDistributionValue(
    'screenshot_render_duration',
    durationMs,
    tagged({outcome}),
  );
};

// Why src/browser.js is launching: 'start', 'crash' (the previous one disconnected) or
// 'failed_launch' (the previous attempt rejected).
exports.browserLaunched = (reason) =>
  metrics()?.incrementCounter('screenshot_browser_launches', 1, tagged({reason}));
