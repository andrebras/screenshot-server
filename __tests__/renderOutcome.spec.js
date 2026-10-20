const {expect} = require('chai');
const renderOutcome = require('../src/renderOutcome');

describe('renderOutcome', () => {
  it('is ok without an error', () => {
    expect(renderOutcome(undefined)).to.equal('ok');
  });

  it('names a Puppeteer navigation timeout', () => {
    const err = new Error('Navigation timeout of 30000 ms exceeded');
    err.name = 'TimeoutError';
    expect(renderOutcome(err)).to.equal('timeout');
  });

  it('blames the page for an error status or an unreachable host', () => {
    expect(renderOutcome(new Error('Error loading page: 503.'))).to.equal('upstream_error');
    expect(
      renderOutcome(new Error('net::ERR_NAME_NOT_RESOLVED at http://nope.example')),
    ).to.equal('upstream_error');
  });

  it('blames the service for anything else', () => {
    expect(
      renderOutcome(new Error('Protocol error (Page.captureScreenshot): Target closed.')),
    ).to.equal('error');
  });
});
