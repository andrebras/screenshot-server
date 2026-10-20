const yaml = require('yamljs');
const fs = require('fs');
const env = process.env.NODE_ENV || 'development';
const secretsPath = __dirname + '/../config/secrets.yml';
const secrets = fs.existsSync(secretsPath) ? yaml.load(secretsPath)[env] || {} : {};
const serverConfig = yaml.load(__dirname + '/../config/screenshot_server.yml')[env] || {};

const ONE_DAY = 24 * 60 * 60; // in seconds

const screenshotUserAgent = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Publitas-ScreenshotServer',
].join(' ');

// How long a SIGTERM waits for the renders in flight before cutting them off. This plus the
// 5 s src/index.js allows for closing Chrome must stay under the pod's termination grace period
// (30 s unless the deployment says otherwise), after which Kubernetes sends SIGKILL.
const shutdownGraceMs = Number(process.env.SHUTDOWN_GRACE_MS) || 20000;
// The hard stop around closing Chrome on shutdown; see src/index.js.
const browserCloseMs = 5000;
// How often the SIGTERM drain closes keep-alive sockets that have gone idle; see src/index.js.
const idleSweepMs = 500;
// Failed Chrome launches in a row before shutting down; see src/browser.js.
const maxFailedLaunches = 3;
// The longest src /screenshots accepts; see src/sourceRefusal.js.
const maxSrcLength = 2048;
// The largest viewport /screenshots renders, in pixels, and the largest clip by area; see
// src/paramsRefusal.js. Chrome holds the whole area in memory while it renders.
const maxRenderWidth = 4096;
const maxRenderHeight = 10000;
const maxClipArea = maxRenderWidth * maxRenderHeight;
// The longest side a JPEG can have. Past it Chrome answers with an empty image, not an error.
const maxClipSide = 65500;
// How long the egress proxy gives one address to connect before trying the next; see
// src/startEgressProxy.js.
const egressAttemptMs = 10000;

// A comma-separated environment variable wins over the YAML list. An empty YAML key loads as
// null, which a default parameter would let through.
const list = (name, fallback) =>
  process.env[name]
    ? process.env[name].split(',').map((item) => item.trim()).filter(Boolean)
    : fallback || [];

module.exports = {
  env,
  port: serverConfig.port,
  ONE_DAY,
  screenshotUserAgent,
  shutdownGraceMs,
  browserCloseMs,
  idleSweepMs,
  maxFailedLaunches,
  maxSrcLength,
  maxRenderWidth,
  maxRenderHeight,
  maxClipArea,
  maxClipSide,
  egressAttemptMs,

  // Check environment variables first, then fall back to secrets.yml
  screenshotServerKey: process.env.SCREENSHOT_SERVER_KEY || secrets.screenshot_server_key,
  hostResolverRules: process.env.HOST_RESOLVER_RULES,

  // Where a page may make the service connect; see src/resolveEgress.js.
  internalRanges: list('INTERNAL_RANGES', serverConfig.internal_ranges),
  allowedInternalHosts: list('ALLOWED_INTERNAL_HOSTS', serverConfig.allowed_internal_hosts),
  blockedHosts: list('BLOCKED_HOSTS', serverConfig.blocked_hosts),
};
