const {randomUUID} = require('crypto');
const http = require('http');
const supertest = require('supertest');
const {expect} = require('chai');
const server = require('../src/server');
const {withPage, closeBrowser} = require('../src/browser');
const {generateSignedUrl} = require('./helpers');

// Every JSON log line written to stderr; Puppeteer's own warnings go there too.
const logLines = (output) =>
  output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));

// The request lines for the request sent with ALB trace id `id`. The line of an earlier test's
// request can arrive late.
const requestLines = (output, id) =>
  logLines(output).filter(
    (line) => line.message.endsWith(' /screenshots') && line.request_id === id,
  );

// Everything written to stderr from the start of `run` until the request line for `id`, still
// passed through. The line follows closing the page, so it comes after the response.
const captureStderr = async (id, run) => {
  const write = process.stderr.write;
  let output = '';
  process.stderr.write = (chunk, ...rest) => {
    output += chunk;
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    await run();
    for (let tries = 0; tries < 50 && !requestLines(output, id).length; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    process.stderr.write = write;
  }
  return output;
};

// Pages served from 127.0.0.1, the specs' allowed internal host; `pages(port)` maps a path to
// {status, headers, body}. localhost and other spellings of loopback reach the same server but are
// refused like any internal address, so `requests` (host and path) shows what a render loaded.
const servePages = async (pages) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.headers.host} ${req.url}`);
    const {status = 200, headers = {}, body = ''} = pages(server.address().port)[req.url] || {
      status: 404,
    };
    res.writeHead(status, {'Content-Type': 'text/html', ...headers}).end(body);
  });
  server.on('upgrade', (req, socket) => {
    requests.push(`${req.headers.host} ${req.url}`);
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {server, requests, port: server.address().port};
};

describe('Screenshot Server', () => {
  describe('/healthcheck endpoint', () => {
    it('responds with 200', async () => {
      const response = await supertest(server).get('/healthcheck').expect(200);

      expect(response.headers['cache-control']).to.equal('no-cache');
    });
  });

  describe('/live endpoint', () => {
    it('responds with 503 while the process has no Chrome', async function () {
      this.timeout(10000);
      await closeBrowser();
      const response = await supertest(server).get('/live').expect(503);

      expect(response.headers['cache-control']).to.equal('no-cache');
    });

    it('responds with 200 while Chrome is connected and 503 once it has died', async function () {
      this.timeout(20000);
      const browser = await withPage((page) => page.browser());
      await supertest(server).get('/live').expect(200);

      const died = new Promise((resolve) => browser.once('disconnected', resolve));
      process.kill(browser.process().pid, 'SIGKILL');
      await died;
      await supertest(server).get('/live').expect(503);
    });
  });

  describe('/ready endpoint', () => {
    it('responds with 200: nothing caps the render slots yet', async () => {
      const response = await supertest(server).get('/ready').expect(200);

      expect(response.headers['cache-control']).to.equal('no-cache');
    });
  });

  describe('/live and /ready endpoints', () => {
    it('answer without asking Chrome anything', async function () {
      this.timeout(20000);
      const pid = await withPage((page) => page.browser().process().pid);
      // A stopped Chrome keeps its socket open but answers nothing, so a route that waited on it
      // or opened a page would hang here.
      process.kill(pid, 'SIGSTOP');
      try {
        await supertest(server).get('/live').timeout(2000).expect(200);
        await supertest(server).get('/ready').timeout(2000).expect(200);
      } finally {
        process.kill(pid, 'SIGCONT');
      }
    });
  });

  describe('/screenshots endpoint', () => {
    describe('authentication', () => {
      it('returns 400 when signature is missing', async () => {
        await supertest(server)
          .get('/screenshots?src=https://example.com')
          .expect(400);
      });

      it('returns 400 when signature is invalid', async () => {
        await supertest(server)
          .get('/screenshots?src=https://example.com&s=invalidsignature')
          .expect(400);
      });

      it('returns 400 when src parameter is missing', async () => {
        const url = generateSignedUrl({width: 100, height: 100});
        await supertest(server)
          .get(`/screenshots${url}`)
          .expect(400);
      });
    });

    describe('successful screenshot', () => {
      it('returns a JPEG image with proper headers for valid request', async function() {
        this.timeout(10000); // Puppeteer can take time

        const url = generateSignedUrl({src: 'https://example.com'});
        const response = await supertest(server)
          .get(`/screenshots${url}`)
          .expect(200);

        expect(response.headers['content-type']).to.equal('image/jpeg');
        expect(response.headers['cache-control']).to.include('public');
        expect(response.headers['cache-control']).to.include('max-age');
        expect(response.body).to.be.instanceOf(Buffer);
        expect(response.body.length).to.be.greaterThan(0);
      });
    });

    describe('clipping parameters', () => {
      it('accepts x, y, width, height parameters', async function() {
        this.timeout(10000);

        const url = generateSignedUrl({
          src: 'https://example.com',
          x: 0,
          y: 0,
          width: 800,
          height: 600
        });

        const response = await supertest(server)
          .get(`/screenshots${url}`)
          .expect(200);

        expect(response.headers['content-type']).to.equal('image/jpeg');
        expect(response.body).to.be.instanceOf(Buffer);
      });

      it('refuses clipping params that are incomplete', async () => {
        const url = generateSignedUrl({
          src: 'https://example.com',
          width: 800,
          // missing height
        });

        const response = await supertest(server)
          .get(`/screenshots${url}`)
          .expect(400);

        expect(response.text).to.equal('width and height go together');
      });

      it('refuses invalid number parameters', async () => {
        const url = generateSignedUrl({
          src: 'https://example.com',
          x: 'notanumber',
          y: 'alsoinvalid',
          width: 800,
          height: 600
        });

        const response = await supertest(server)
          .get(`/screenshots${url}`)
          .expect(400);

        expect(response.text).to.equal('x must be a single integer');
      });
    });

    describe('render parameters', () => {
      it('refuses a viewport beyond the largest render with a 400 that says why', async () => {
        const url = generateSignedUrl({src: 'https://example.com', viewportWidth: 100000, viewportHeight: 100000});
        const response = await supertest(server).get(`/screenshots${url}`).expect(400);

        expect(response.headers['content-type']).to.equal('text/plain');
        expect(response.text).to.equal('viewportWidth must be from 1 to 4096');
      });

      it('renders a clip past 10000 tall, as the largest image of a very tall page is', async function () {
        this.timeout(10000);
        const url = generateSignedUrl({src: 'https://example.com', width: 519, height: 11100});
        const response = await supertest(server).get(`/screenshots${url}`).expect(200);

        expect(response.headers['content-type']).to.equal('image/jpeg');
      });
    });

    describe('error handling', () => {
      it('returns 502 when page fails to load', async function() {
        this.timeout(10000);

        const url = generateSignedUrl({src: 'http://this-domain-should-not-exist-12345.com'});
        await supertest(server)
          .get(`/screenshots${url}`)
          .expect(502);
      });
    });

    describe('internal addresses', () => {
      let pages;

      afterEach(() => {
        pages?.server.closeAllConnections();
        pages?.server.close();
        pages = null;
      });

      it('refuses a src at an internal address with a 400 that says why', async () => {
        const url = generateSignedUrl({src: 'http://localhost/latest/meta-data/'});
        const response = await supertest(server).get(`/screenshots${url}`).expect(400);

        expect(response.text).to.equal('src host resolves to an internal address');
      });

      it('refuses a src that is not an http or https URL', async () => {
        const url = generateSignedUrl({src: 'file:///app/.env'});
        const response = await supertest(server).get(`/screenshots${url}`).expect(400);

        expect(response.text).to.equal('src must be an http or https URL');
      });

      it('does not follow a redirect to an internal address', async function () {
        this.timeout(10000);
        pages = await servePages((port) => ({
          '/redirect': {status: 302, headers: {Location: `http://localhost:${port}/secret`}},
          '/secret': {body: '<p>secret</p>'},
        }));
        const url = generateSignedUrl({src: `http://127.0.0.1:${pages.port}/redirect`});
        await supertest(server).get(`/screenshots${url}`).expect(502);

        expect(pages.requests).to.include(`127.0.0.1:${pages.port} /redirect`);
        expect(pages.requests.filter((request) => request.endsWith('/secret'))).to.be.empty;
      });

      it('renders a page without the internal addresses it tries to load, and logs each refusal', async function () {
        this.timeout(10000);
        pages = await servePages((port) => ({
          '/page': {
            body: `
              <img src="http://127.0.0.1:${port}/allowed.png">
              <img src="http://localhost:${port}/image">
              <img src="http://[::ffff:127.0.0.1]:${port}/mapped">
              <iframe src="http://localhost:${port}/frame"></iframe>
              <script>
                fetch('http://localhost:${port}/fetch').catch(() => {});
                new WebSocket('ws://localhost:${port}/socket');
              </script>`,
          },
        }));
        const id = `Root=1-${randomUUID()}`;
        const url = generateSignedUrl({src: `http://127.0.0.1:${pages.port}/page`});
        const output = await captureStderr(id, () =>
          supertest(server).get(`/screenshots${url}`).set('X-Amzn-Trace-Id', id).expect(200),
        );

        expect(pages.requests).to.include(`127.0.0.1:${pages.port} /allowed.png`);
        expect(pages.requests.filter((request) => !request.startsWith('127.0.0.1:'))).to.be.empty;
        const refusals = logLines(output)
          .filter((line) => line.message === 'Egress refused')
          .map(({level, host, port, reason}) => `${level} ${host}:${port} ${reason}`);
        expect(refusals).to.include(`warn localhost:${pages.port} resolves to an internal address`);
      });
    });

    describe('request log line', () => {
      const logged = async (path, status, method = 'get') => {
        const id = `Root=1-${randomUUID()}`;
        const output = await captureStderr(id, () =>
          supertest(server)[method](path).set('X-Amzn-Trace-Id', id).expect(status),
        );
        return {lines: requestLines(output, id), output};
      };

      it('logs one line for a render, with the source page but not the signature', async function () {
        this.timeout(10000);
        const url = generateSignedUrl({src: 'https://example.com/?ref=campaign'});
        const {lines, output} = await logged(`/screenshots${url}`, 200);

        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.include({
          level: 'info',
          status: 200,
          upstream_status: 200,
          src_host: 'example.com',
          src_path: '/',
        });
        expect(lines[0]).to.have.keys(
          'timestamp', 'level', 'message', 'pod', 'request_id', 'status', 'duration_ms',
          'upstream_status', 'src_host', 'src_path',
        );
        expect(output).to.not.include(url.split('&s=')[1]);
        expect(output).to.not.include('campaign');
      });

      it('marks a source page that cannot be reached as an upstream failure', async function () {
        this.timeout(10000);
        const url = generateSignedUrl({src: 'http://this-domain-should-not-exist-12345.com/page?token=secret'});
        const {lines, output} = await logged(`/screenshots${url}`, 502);

        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.include({
          level: 'error',
          status: 502,
          failure: 'upstream',
          src_host: 'this-domain-should-not-exist-12345.com',
          src_path: '/page',
        });
        expect(output).to.not.include('secret');
        expect(output).to.not.include(url.split('&s=')[1]);
      });

      it('marks a render that breaks on our side as a service failure', async function () {
        this.timeout(10000);
        // An SVG document has no body for maxHeight to measure.
        const pages = await servePages(() => ({
          '/': {
            headers: {'Content-Type': 'image/svg+xml'},
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
          },
        }));
        const url = generateSignedUrl({
          src: `http://127.0.0.1:${pages.port}/`,
          viewportWidth: 800,
          viewportHeight: 600,
          maxHeight: 1000,
        });
        const {lines} = await logged(`/screenshots${url}`, 502);
        pages.server.closeAllConnections();
        pages.server.close();

        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.include({level: 'error', status: 502, failure: 'service'});
      });

      it('logs why a signed src was refused, without a failure', async () => {
        const url = generateSignedUrl({src: 'http://localhost/latest/meta-data/'});
        const {lines} = await logged(`/screenshots${url}`, 400);

        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.include({
          level: 'info',
          status: 400,
          src_host: 'localhost',
          refused: 'src host resolves to an internal address',
        });
        expect(lines[0]).to.not.have.any.keys('failure', 'upstream_status');
      });

      it('logs why a signed viewport was refused, without a failure', async () => {
        const url = generateSignedUrl({src: 'https://example.com', viewportWidth: 100000, viewportHeight: 100000});
        const {lines} = await logged(`/screenshots${url}`, 400);

        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.include({level: 'info', status: 400, refused: 'viewportWidth must be from 1 to 4096'});
        expect(lines[0]).to.not.have.any.keys('failure', 'upstream_status');
      });

      it('logs a refused request without a failure or a source page', async () => {
        const {lines} = await logged('/screenshots?src=https://example.com&s=invalidsignature', 400);

        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.include({level: 'info', message: 'GET /screenshots', status: 400});
        expect(lines[0]).to.not.have.any.keys('failure', 'src_host', 'upstream_status');
      });

      it('names the line after the request method', async () => {
        const {lines} = await logged('/screenshots', 400, 'head');

        expect(lines[0]).to.include({message: 'HEAD /screenshots'});
      });
    });

    describe('non-existent routes', () => {
      it('returns 404 for unknown paths', async () => {
        await supertest(server)
          .get('/nonexistent')
          .expect(404);
      });
    });
  });
});
