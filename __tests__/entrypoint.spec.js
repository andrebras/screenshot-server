const {spawn, execFileSync} = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {expect} = require('chai');
const {generateSignedUrl} = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const childPids = (pid) => {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], {encoding: 'utf8'})
      .trim()
      .split('\n')
      .map(Number);
  } catch (err) {
    if (err.status === 1) return []; // pgrep: nothing matched
    throw err;
  }
};

// One connection per request unless an agent is given: the default agent would reuse the
// render's keep-alive socket and never see a refusal.
const get = (port, urlPath, agent = false) =>
  new Promise((resolve, reject) =>
    http
      .get({host: '127.0.0.1', port, path: urlPath, agent}, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      })
      .on('error', reject),
  );

describe('src/index.js as a process', () => {
  let child;
  let log;
  let exited;

  // Polls read() until it returns something. A child that dies first fails the test with its
  // log instead of a bare timeout.
  const until = async (read) => {
    while (child.exitCode === null && child.signalCode === null) {
      const value = read();
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`server exited with ${child.exitCode ?? child.signalCode}:\n${log}`);
  };

  // Starts the entrypoint the way the container does and resolves with its port.
  const start = async (env = {}) => {
    child = spawn(process.execPath, ['src/index.js'], {
      cwd: path.join(__dirname, '..'),
      env: {...process.env, NODE_ENV: 'test', ENVIRONMENT: 'test', ...env},
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    log = '';
    child.stderr.on('data', (chunk) => (log += chunk));
    exited = new Promise((resolve) => child.on('exit', resolve));
    return Number(await until(() => /started on port (\d+)/.exec(log)?.[1]));
  };

  // Chrome's main process. src/index.js starts it at boot, so it says nothing about a render:
  // the page server receiving Chrome's request is what shows a render is in flight.
  const chromeStarted = () => until(() => childPids(child.pid)[0]);

  afterEach(() => {
    // Chrome is detached from Node, so kill it first; pgrep finds nothing once Node is gone.
    childPids(child.pid).forEach((pid) => process.kill(pid, 'SIGKILL'));
    child.kill('SIGKILL');
  });

  it('on SIGTERM finishes the render in flight, refuses new connections, closes Chrome and exits 0', async function () {
    this.timeout(30000);
    // A page served only once the drain has begun, so the render is in flight across the SIGTERM.
    let serve;
    const draining = new Promise((resolve) => (serve = resolve));
    const page = http.createServer((req, res) => draining.then(() => res.end('<p>ok</p>')));
    const requested = new Promise((resolve) => page.once('request', resolve));
    await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
    const src = `http://127.0.0.1:${page.address().port}/`;
    const port = await start();
    // A keep-alive socket, as the ingress uses: it stays open after the response unless swept.
    const keepAlive = new http.Agent({keepAlive: true});
    const render = get(port, `/screenshots${generateSignedUrl({src})}`, keepAlive);
    const chromePid = await chromeStarted();
    // A render that fails before it navigates answers instead; the assertions below report it.
    await Promise.race([requested, render]);
    child.kill('SIGTERM');
    await until(() => log.includes('SIGTERM received'));
    serve();

    const response = await render;
    const respondedAt = Date.now();
    expect(response.statusCode).to.equal(200);
    expect(response.headers['content-type']).to.equal('image/jpeg');
    await get(port, '/live').then(
      () => expect.fail('still accepting connections'),
      (err) => expect(err.code).to.equal('ECONNREFUSED'),
    );
    expect(await exited, log).to.equal(0);
    expect(Date.now() - respondedAt, 'waited for the idle keep-alive socket').to.be.below(5000);
    keepAlive.destroy();
    expect(() => process.kill(chromePid, 0)).to.throw(/ESRCH/);
    // Logged only when closeBrowser() resolved; Puppeteer's exit hook would kill Chrome anyway.
    expect(log).to.include('Browser closed, exiting');
    expect(log).to.not.include('"level":"error"');
    page.close();
  });

  it('on SIGTERM cuts off a render that outlives the grace period and still exits 0', async function () {
    this.timeout(30000);
    // A page that never finishes loading: networkidle0 waits on a request that is never answered.
    const stuck = http.createServer(() => {});
    const requested = new Promise((resolve) => stuck.once('request', resolve));
    await new Promise((resolve) => stuck.listen(0, '127.0.0.1', resolve));
    const src = `http://127.0.0.1:${stuck.address().port}/`;
    const port = await start({SHUTDOWN_GRACE_MS: '1000'});
    const render = get(port, `/screenshots${generateSignedUrl({src})}`);
    const chromePid = await chromeStarted();
    await Promise.race([requested, render]);
    child.kill('SIGTERM');

    await render.then(
      () => expect.fail('the stuck render was answered'),
      (err) => expect(err.code).to.equal('ECONNRESET'),
    );
    expect(await exited, log).to.equal(0);
    expect(() => process.kill(chromePid, 0)).to.throw(/ESRCH/);
    stuck.closeAllConnections();
    stuck.close();
  });

  it('starts Chrome with the process, so /live answers 200 before any render', async function () {
    this.timeout(20000);
    const port = await start();
    await chromeStarted();
    // Puppeteer connects to Chrome a moment after its process appears.
    let status;
    for (let tries = 0; tries < 50 && status !== 200; tries += 1) {
      await sleep(100);
      status = (await get(port, '/live')).statusCode;
    }
    expect(status).to.equal(200);
  });

  it('answers 502 when Chrome cannot launch, and exits 0 after the third failure in a row', async function () {
    this.timeout(30000);
    const port = await start({PUPPETEER_EXECUTABLE_PATH: '/usr/bin/false'});
    // The launch at startup is the first failure. The pod is not live, but still answers.
    await until(() => log.includes('Failed to launch the browser process'));
    expect((await get(port, '/live')).statusCode).to.equal(503);
    expect((await get(port, '/ready')).statusCode).to.equal(200);

    const url = `/screenshots${generateSignedUrl({src: 'https://example.com'})}`;
    expect((await get(port, url)).statusCode).to.equal(502);
    expect(child.exitCode, 'exited after two failures').to.equal(null);
    expect((await get(port, url)).statusCode).to.equal(502);
    expect(await exited, log).to.equal(0);
    expect(log).to.include('Chrome failed to launch 3 times in a row, shutting down');
  });

  it('keeps the query string, signature included, out of the spans AppSignal is handed', async function () {
    this.timeout(20000);
    // AppSignal's test mode writes each finished span to a file instead of to the agent; the
    // dummy key keeps anything else from reaching an AppSignal app.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spans-'));
    const spans = path.join(dir, 'spans.jsonl');
    const port = await start({
      ENVIRONMENT: 'spec',
      APPSIGNAL_API_KEY: 'dummy',
      _APPSIGNAL_TEST_MODE: 'true',
      _APPSIGNAL_TEST_MODE_FILE_PATH: spans,
    });
    // Nothing listens on port 1, so the render fails fast.
    const signed = generateSignedUrl({src: 'http://127.0.0.1:1/'});
    expect((await get(port, `/screenshots${signed}`)).statusCode).to.equal(502);
    expect((await get(port, '/screenshots?src=https://example.com&s=deadbeef')).statusCode).to.equal(400);
    child.kill('SIGTERM');
    expect(await exited, log).to.equal(0);

    const written = fs.readFileSync(spans, 'utf8');
    fs.rmSync(dir, {recursive: true, force: true});
    expect(written).to.include('"http.target":"/screenshots"');
    expect(written).to.include('"appsignal.tag.src_host":"127.0.0.1"');
    expect(written).to.not.include(signed.split('&s=')[1]);
    expect(written).to.not.include('deadbeef');
  });

  it('takes HOST_RESOLVER_RULES and BLOCKED_HOSTS from the environment, and connects a mapped host only where its rule points', async function () {
    this.timeout(20000);
    const page = http.createServer((req, res) => res.end('<p>ok</p>'));
    await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
    // page.rebind.test resolves only through the rule. Looking the name up again in DNS, the
    // window DNS rebinding uses, would find nothing and fail the render.
    const port = await start({
      HOST_RESOLVER_RULES: 'MAP *.rebind.test 127.0.0.1',
      BLOCKED_HOSTS: '*.evil.example',
    });
    const mapped = generateSignedUrl({src: `http://page.rebind.test:${page.address().port}/`});
    expect((await get(port, `/screenshots${mapped}`)).statusCode, log).to.equal(200);
    const blocked = generateSignedUrl({src: 'https://www.evil.example/'});
    expect((await get(port, `/screenshots${blocked}`)).statusCode, log).to.equal(400);
    page.closeAllConnections();
    page.close();
  });
});
