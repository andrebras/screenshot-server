const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const {spawn} = require('child_process');
const {once} = require('events');
const {performance} = require('perf_hooks');
const telemetry = require('../src/appsignal');
const addError = telemetry.addError;
telemetry.addError = (err) => {console.error('Baseline render failed:', err.message); addError(err)};
const server = require('../src/server');
const {closeBrowser} = require('../src/browser');
const generateSignedUrl = require('../src/generateSignedUrl');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const freePort = async () => {
  const socket = http.createServer();
  const port = await listen(socket);
  await new Promise((resolve) => socket.close(resolve));
  return port;
};
const summary = (samples) => {
  const sorted = samples.slice().sort((a, b) => a - b);
  return {samples: sorted.length, median_ms: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10, p95_ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 10) / 10};
};
const measure = async (url) => {
  const start = performance.now();
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {status: response.status, ms: performance.now() - start, bytes, cache: response.headers.get('x-screenshot-cache')};
};
async function main() {
  let navigations = 0;
  const fixture = http.createServer((req, res) => {
    if (req.url === '/image.svg') {
      res.setHeader('Content-Type', 'image/svg+xml');
      return setTimeout(() => res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="#28a"/></svg>'), 60);
    }
    if (!req.url.startsWith('/dynamic_pages/')) {res.writeHead(204); return res.end();}
    navigations += 1;
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><style>body{margin:0;font-family:sans-serif;background:#eee}h1{margin:0;padding:20px;color:#123}.page{height:900px}.card{background:#fe9;padding:20px}@media(max-width:500px){h1{font-size:20px}}</style></head><body><div class="page"><h1>Publication preview · مرحبا</h1><img src="/image.svg" width="600" height="200"><div class="card">Product card — €12.99</div></div></body></html>`);
  });
  let child;
  try {
    const fixturePort = await listen(fixture);
    const legacyPort = await listen(server);
    const port = await freePort();
    const rendererPort = await freePort();
    child = spawn(process.env.GATEWAY_BINARY || '/usr/local/bin/screenshot-gateway', [], {
      cwd: process.cwd(),
      env: {...process.env, PORT: String(port), RENDERER_PORT: String(rendererPort), RENDER_SLOTS: '2', RENDER_PENDING: '2', TRUSTED_RENDER_HOSTS: '127.0.0.1', RENDER_VERSION: `benchmark-${Date.now()}`},
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    let exited = false;
    child.once('exit', () => {exited = true});
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30000;
    while (true) {
      try {if ((await fetch(base + '/ready')).ok) break;} catch {}
      if (exited || Date.now() > deadline) throw new Error('Gateway failed to become ready');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const src = `http://127.0.0.1:${fixturePort}/dynamic_pages/1/1/at600`;
    const url = (origin, ts) => origin + '/screenshots' + generateSignedUrl({src, viewportWidth: 600, viewportHeight: 800, ts});
    const legacyBase = `http://127.0.0.1:${legacyPort}`;
    const original = await measure(url(legacyBase, 'visual'));
    const replacement = await measure(url(base, 'visual'));
    assert.equal(original.status, 200);
    assert.equal(replacement.status, 200);
    assert(original.bytes.equals(replacement.bytes), 'Replacement pixels differ from baseline');
    const report = {environment: {platform: process.platform, arch: process.arch, node: process.version, cpus: process.env.BENCH_CPUS || 'unrestricted', memory: process.env.BENCH_MEMORY || 'unrestricted', storage: process.env.RESULTS_BUCKET ? 'S3-compatible object storage' : 'disabled'}, visual_bytes_equal: true};
    for (const [name, origin] of [['legacy_fresh', legacyBase], ['gateway_fresh', base]]) {
      const samples = [];
      for (let i = 0; i < 7; i++) {
        const response = await measure(url(origin, `${name}-${i}`));
        assert.equal(response.status, 200);
        samples.push(response.ms);
      }
      report[name] = summary(samples);
    }
    const before = navigations;
    const burst = await Promise.all(Array.from({length: 24}, () => measure(url(base, 'duplicate-burst'))));
    burst.forEach((response) => assert.equal(response.status, 200));
    assert.equal(navigations - before, 1, 'Duplicate requests rendered more than once');
    report.gateway_duplicate_burst = {...summary(burst.map((r) => r.ms)), requests: 24, page_navigations: navigations - before};
    if (process.env.RESULTS_BUCKET) {
      const warm = [];
      const beforeWarm = navigations;
      for (let i = 0; i < 20; i++) {
        const response = await measure(url(base, 'duplicate-burst'));
        assert.equal(response.cache, 'hit');
        assert.equal(response.status, 200);
        assert(response.bytes.equals(replacement.bytes));
        warm.push(response.ms);
      }
      assert.equal(navigations, beforeWarm, 'Stored result navigated the browser');
      report.gateway_stored = {...summary(warm), page_navigations: 0};
    }
    const overload = await Promise.all(Array.from({length: 16}, (_, i) => measure(url(base, `overload-${i}`))));
    report.gateway_unique_burst = {requests: 16, completed: overload.filter((r) => r.status === 200).length, rejected: overload.filter((r) => r.status === 503).length, rejection_latency: summary(overload.filter((r) => r.status === 503).map((r) => r.ms))};
    assert(report.gateway_unique_burst.rejected > 0, 'Capacity limit was not enforced');
    assert(overload.every((r) => [200, 503].includes(r.status)));
    report.gateway_metrics = await (await fetch(base + '/metrics')).text();
    const output = JSON.stringify(report, null, 2);
    if (process.env.BENCH_OUTPUT) fs.writeFileSync(process.env.BENCH_OUTPUT, output + '\n');
    console.log(output);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 27000);
      const [code] = await stopped;
      clearTimeout(timeout);
      assert.equal(code, 0, 'Gateway did not shut down cleanly');
    }
    server.closeAllConnections();
    fixture.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => fixture.close(resolve)), closeBrowser()]);
  }
}
main().catch((err) => {console.error(err); process.exitCode = 1});
