const {execFile} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {promisify} = require('util');
const {expect} = require('chai');
const puppeteer = require('puppeteer');
const {withPage, closeBrowser} = require('../src/browser');

const browserPid = () => withPage((page) => page.browser().process().pid);

describe('browser', () => {
  // Chrome can take about 3 s to exit on macOS, past Mocha's 2 s default.
  after(async function () {
    this.timeout(10000);
    await closeBrowser();
  });

  it('launches one Chrome for concurrent callers', async function () {
    this.timeout(20000);
    await closeBrowser(); // start cold, whatever an earlier spec left running
    const pids = await Promise.all([1, 2, 3, 4, 5].map(browserPid));
    expect(new Set(pids).size).to.equal(1);
  });

  it('launches a new Chrome after the running one dies', async function () {
    this.timeout(20000);
    const browser = await withPage((page) => page.browser());
    const died = new Promise((resolve) => browser.once('disconnected', resolve));
    process.kill(browser.process().pid, 'SIGKILL');
    await died;
    expect(await browserPid()).to.not.equal(browser.process().pid);
  });

  it('closes the page after the work, also when the work throws', async function () {
    this.timeout(20000);
    const openPages = () =>
      withPage((page) => page.browser().pages().then((pages) => pages.length));
    const before = await openPages();
    await withPage(() => Promise.reject(new Error('render failed'))).catch(() => {});
    expect(await openPages()).to.equal(before);
  });

  it('does not cache a failed launch', async function () {
    this.timeout(20000);
    // Chrome fails its first start and runs normally afterwards, so the second call can only
    // succeed if the first rejection was forgotten. In a child process: the executable path is
    // read once per process.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-chromium-'));
    const chromium = path.join(dir, 'chromium');
    fs.writeFileSync(
      chromium,
      [
        '#!/bin/sh',
        `if [ ! -f "${dir}/failed-once" ]; then touch "${dir}/failed-once"; exit 1; fi`,
        `exec "${puppeteer.executablePath()}" "$@"`,
      ].join('\n'),
      {mode: 0o755},
    );
    const launchTwice = `
      const {withPage, closeBrowser} = require('./src/browser');
      const attempt = () => withPage(() => 'ok').catch((err) => err.message.split('\\n')[0]);
      (async () => {
        console.log(JSON.stringify([await attempt(), await attempt()]));
        await closeBrowser();
      })();
    `;
    try {
      const {stdout} = await promisify(execFile)(process.execPath, ['-e', launchTwice], {
        cwd: path.join(__dirname, '..'),
        env: {...process.env, PUPPETEER_EXECUTABLE_PATH: chromium},
        timeout: 15000, // a hung child must not outlive the test; its Chrome may
        killSignal: 'SIGKILL',
      });
      const [first, second] = JSON.parse(stdout.trim().split('\n').pop());
      expect(first).to.include('Failed to launch the browser process');
      expect(second).to.equal('ok');
    } finally {
      fs.rmSync(dir, {recursive: true});
    }
  });
});
