const querystring = require('querystring');
const {expect} = require('chai');
const paramsRefusal = require('../src/paramsRefusal');

// Parsed the way a signed query is, so every value arrives as a string, or an array when repeated.
const refusal = (params) => paramsRefusal(querystring.parse(new URLSearchParams(params).toString()));
const refusals = (list) => list.map(refusal);

describe('paramsRefusal', () => {
  it('accepts what the readers send, up to the largest render', () => {
    const accepted = [
      {},
      // The readers' widest and tallest clips, with no viewport: Chrome captures past its
      // 800×600 default.
      {width: 3666, height: 4884},
      {width: 346, height: 7400},
      {viewportWidth: 1280, viewportHeight: 2000, maxHeight: 4000},
      {width: 507, height: 710, ts: '2026-03-06 11:52:44 +0100', gId: 'g', pId: '1'},
      {viewportWidth: 4096, viewportHeight: 10000, maxHeight: 10000},
      {x: 0, y: 0, width: 4096, height: 10000},
    ];
    expect(refusals(accepted)).to.deep.equal(Array(accepted.length).fill(undefined));
  });

  it('refuses a size below 1 or past the largest render', () => {
    expect(
      refusals([
        {viewportWidth: -1920, viewportHeight: 0},
        {viewportWidth: 1920, viewportHeight: 10001},
        {viewportWidth: 1920, viewportHeight: 1080, maxHeight: 999999999},
        {viewportWidth: 1920, viewportHeight: 1080, maxHeight: 0},
        {width: 0, height: 600},
        {width: 800, height: -1},
      ]),
    ).to.deep.equal([
      'viewportWidth must be from 1 to 4096',
      'viewportHeight must be from 1 to 10000',
      'maxHeight must be from 1 to 10000',
      'maxHeight must be from 1 to 10000',
      'width must be from 1 to 65500',
      'height must be from 1 to 65500',
    ]);
  });

  it('caps a clip by its area, whatever its shape', () => {
    // The readers size page images by area, so the largest image of a very tall or very wide
    // page is past 10000 tall or 4096 wide, not past 4096 × 10000 in area.
    const accepted = [
      {width: 519, height: 11100},
      {width: 5258, height: 1095},
      {width: 16384, height: 2500},
      {width: 4096, height: 10000},
    ];
    expect(refusals(accepted)).to.deep.equal(Array(accepted.length).fill(undefined));
    expect(refusals([{width: 4097, height: 10000}, {width: 60000, height: 1000}])).to.deep.equal(
      Array(2).fill('width * height must be at most 40960000'),
    );
    // Past 65500 a side, Chrome answers with an empty JPEG rather than an error.
    expect(refusals([{width: 65500, height: 625}, {width: 65501, height: 625}, {width: 625, height: 65501}]))
      .to.deep.equal([undefined, 'width must be from 1 to 65500', 'height must be from 1 to 65500']);
  });

  it('refuses a clip that starts before the page or past the largest viewport', () => {
    // Outside the viewport is fine: Chrome renders it. Starting past the largest viewport is not.
    expect(
      refusals([
        {x: 4095, y: 9999, width: 1, height: 1},
        {viewportWidth: 1920, viewportHeight: 1080, x: 3000, y: 2000, width: 1000, height: 1000},
      ]),
    ).to.deep.equal([undefined, undefined]);
    expect(
      refusals([
        {viewportWidth: 1920, viewportHeight: 1080, x: 5000, y: 5000, width: 1000, height: 1000},
        {x: -100, width: 800, height: 600},
        {y: -1, width: 800, height: 600},
      ]),
    ).to.deep.equal(['x must be from 0 to 4095', 'x must be from 0 to 4095', 'y must be from 0 to 9999']);
  });

  it('refuses a value that is not one integer, rather than ignoring it', () => {
    const values = ['notanumber', '', '1.5', '1e3', '0x10', ' 800', '800px'];
    expect(refusals(values.map((x) => ({x, width: 800, height: 600})))).to.deep.equal(
      Array(values.length).fill('x must be a single integer'),
    );
    expect(refusal([['width', '800'], ['width', '900'], ['height', '600']])).to.equal(
      'width must be a single integer',
    );
  });

  it('refuses a parameter that would be ignored without its partner', () => {
    expect(
      refusals([
        {viewportWidth: 1920},
        {viewportHeight: 1080},
        {width: 800},
        {x: 100, height: 600},
        {x: 10, y: 10},
        {y: 10},
        {maxHeight: 4000},
        {width: 800, height: 600, maxHeight: 4000},
      ]),
    ).to.deep.equal([
      'viewportWidth and viewportHeight go together',
      'viewportWidth and viewportHeight go together',
      'width and height go together',
      'width and height go together',
      'x and y need width and height',
      'x and y need width and height',
      'maxHeight needs viewportWidth and viewportHeight',
      'maxHeight needs viewportWidth and viewportHeight',
    ]);
  });
});
