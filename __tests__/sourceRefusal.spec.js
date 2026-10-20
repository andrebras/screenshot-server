const {expect} = require('chai');
const sourceRefusal = require('../src/sourceRefusal');

// Runs with config/screenshot_server.yml's test section: 127.0.0.1 is the one allowed internal
// host, and *.blocked.example is blocked.
describe('sourceRefusal', () => {
  const refusals = (srcs) => Promise.all(srcs.map(sourceRefusal));

  it('accepts a public http or https page', async () => {
    expect(await refusals(['https://example.com/', 'http://example.com/a?b=c'])).to.deep.equal([
      undefined,
      undefined,
    ]);
  });

  it('accepts an allowed internal host', async () => {
    expect(await sourceRefusal('http://127.0.0.1:8080/page')).to.equal(undefined);
  });

  it('refuses anything but one http or https URL of at most 2048 characters', async () => {
    expect(await sourceRefusal(['https://example.com/', 'http://127.0.0.1/'])).to.equal(
      'src must be a single URL',
    );
    expect(await sourceRefusal(`https://example.com/${'a'.repeat(2029)}`)).to.equal(
      'src must be at most 2048 characters',
    );
    expect(await refusals(['not a url', 'http://256.0.0.1/', 'http://[fe80::1%25eth0]/'])).to.deep.equal(
      Array(3).fill('src must be a valid URL'),
    );
    const schemes = [
      'file:///app/.env',
      'view-source:https://example.com/',
      'about:blank',
      'data:text/html,<h1>hi</h1>',
      'javascript:alert(1)',
      'ftp://example.com/',
      'ws://example.com/',
      'chrome://version',
    ];
    expect(await refusals(schemes)).to.deep.equal(
      Array(schemes.length).fill('src must be an http or https URL'),
    );
  });

  it('accepts exactly 2048 characters', async () => {
    expect(await sourceRefusal(`https://example.com/${'a'.repeat(2028)}`)).to.equal(undefined);
  });

  it('refuses internal addresses, however they are written', async () => {
    const internal = [
      // The cloud metadata service: dotted, octal, hex, decimal, IPv4-mapped IPv6, userinfo
      // in front, percent-encoded, and the IPv6 endpoint.
      'http://169.254.169.254/latest/meta-data/',
      'http://0251.0376.0251.0376/',
      'http://0xa9fea9fe/',
      'http://2852039166/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:a9fe:a9fe]/',
      'http://example.com@169.254.169.254/',
      'http://%31%36%39.254.169.254/',
      'http://[fd00:ec2::254]/',
      // Private, carrier-grade NAT and this-network ranges.
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://100.64.0.1/',
      'http://0/',
      'http://0.0.0.0:3001/',
      // Loopback other than the specs' allowed 127.0.0.1, by name and in IPv6, unspecified,
      // IPv4-compatible, NAT64 and 6to4 forms.
      'http://127.0.0.2/',
      'http://localhost:3001/',
      'http://LOCALHOST./',
      'http://[::1]/',
      'http://[::]/',
      'http://[::127.0.0.1]/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://[2002:a9fe:a9fe::]/',
      'http://[fe80::1]/',
    ];
    expect(await refusals(internal)).to.deep.equal(
      Array(internal.length).fill('src host resolves to an internal address'),
    );
  });

  it('refuses configured internal ranges', async () => {
    expect(await refusals(['http://198.51.100.10/', 'https://203.0.113.10/'])).to.deep.equal(
      Array(2).fill('src host resolves to an internal address'),
    );
  });

  it('refuses a blocked host before resolving it, trailing dots or not', async () => {
    expect(await refusals(['https://www.blocked.example/', 'https://www.blocked.example../'])).to.deep.equal(
      Array(2).fill('src host is blocked'),
    );
    // *.blocked.example covers the hosts under blocked.example, not every name ending in it.
    expect(await sourceRefusal('https://notblocked.example/')).to.equal(undefined);
  });

  it('lets a host that does not resolve through, for the render to fail on', async () => {
    expect(await sourceRefusal('http://this-domain-should-not-exist-12345.com/')).to.equal(undefined);
  });
});
