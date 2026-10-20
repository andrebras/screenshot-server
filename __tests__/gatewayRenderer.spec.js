const http = require('http');
const {expect} = require('chai');
const supertest = require('supertest');
const {withPage, withIsolatedPage, closeBrowser} = require('../src/browser');
const render = require('../renderer/render');
const server = require('../src/server');
const {generateSignedUrl} = require('./helpers');

const html = `<!doctype html><html><head><style>
body{margin:0;background:#eef;font-family:sans-serif} .page{height:900px;position:relative}
h1{color:#123;padding:24px;margin:0}.card{position:absolute;left:40px;top:140px;width:200px;height:160px;background:linear-gradient(40deg,#f80,#08f);transform:rotate(8deg)}
@media(max-width:500px){h1{font-size:20px}.card{left:12px}}
</style></head><body><div class="page"><h1>Publication preview · مرحبا</h1><div class="card"></div>
<img width="80" height="60" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='60'%3E%3Crect width='80' height='60' fill='green'/%3E%3C/svg%3E"></div></body></html>`;

describe('gateway renderer', function () {
  this.timeout(20000);
  let fixture;
  let src;
  before(async () => {
    fixture = http.createServer((req, res) => {
      if (req.url === '/slow') return;
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/ready') {
        return res.end('<script>window.__publitasScreenshotReady = new Promise(resolve => setTimeout(() => {document.body.style.background="red";resolve()},100))</script>');
      }
      res.end(html);
    });
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    src = `http://127.0.0.1:${fixture.address().port}/dynamic_pages/1/1/at600`;
  });
  after(async () => {
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    await closeBrowser();
  });
  for (const dimensions of [
    {},
    {viewportWidth: 400, viewportHeight: 560},
    {viewportWidth: 600, viewportHeight: 800, maxHeight: 600},
    {x: 20, y: 30, width: 400, height: 300},
  ]) {
    it(`preserves legacy pixels for ${JSON.stringify(dimensions)}`, async () => {
      const legacy = await supertest(server).get('/screenshots' + generateSignedUrl({src, ...dimensions})).expect(200);
      const image = await withIsolatedPage((page) => render(page, {src, ...dimensions, readiness: 'assets'}), new AbortController().signal);
      expect(image.equals(legacy.body)).to.equal(true);
    });
  }
  it('isolates cookies and storage between renders', async () => {
    await withIsolatedPage(async (page) => {
      await page.goto(src);
      await page.evaluate(() => {localStorage.setItem('tenant', 'one'); document.cookie = 'tenant=one'});
    }, new AbortController().signal);
    const state = await withIsolatedPage(async (page) => {
      await page.goto(src);
      return page.evaluate(() => [localStorage.getItem('tenant'), document.cookie]);
    }, new AbortController().signal);
    expect(state).to.deep.equal([null, '']);
  });
  it('honors the explicit application readiness promise', async () => {
    const readySrc = src.replace('/dynamic_pages/1/1/at600', '/ready');
    const color = await withIsolatedPage(async (page) => {
      await render(page, {src: readySrc, readiness: 'assets'});
      return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    }, new AbortController().signal);
    expect(color).to.equal('rgb(255, 0, 0)');
  });
  it('recovers when canceled while browser context creation is stuck', async () => {
    const browser = await withPage((page) => page.browser());
    const method = browser.createBrowserContext ? 'createBrowserContext' : 'createIncognitoBrowserContext';
    const original = browser[method];
    browser[method] = () => new Promise(() => {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    let failed = false;
    try {
      await withIsolatedPage(() => {throw new Error('Unexpected work')}, controller.signal);
    } catch { failed = true; }
    finally {browser[method] = original; clearTimeout(timer);}
    expect(failed).to.equal(true);
    const image = await withIsolatedPage((page) => render(page, {src, readiness: 'assets'}), new AbortController().signal);
    expect(image.length).to.be.greaterThan(100);
  });
  it('closes an abandoned navigation and recovers for the next render', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    let failed = false;
    try {
      await withIsolatedPage((page) => render(page, {src: src.replace('/dynamic_pages/1/1/at600', '/slow'), readiness: 'networkidle0'}), controller.signal);
    } catch { failed = true; }
    clearTimeout(timer);
    expect(failed).to.equal(true);
    const image = await withIsolatedPage((page) => render(page, {src, readiness: 'assets'}), new AbortController().signal);
    expect(image.length).to.be.greaterThan(100);
  });
});
