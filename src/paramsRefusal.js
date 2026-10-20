const pluckNumbers = require('./pluckNumbers');
const {maxRenderWidth, maxRenderHeight, maxClipArea, maxClipSide} = require('./config');

const KEYS = ['viewportWidth', 'viewportHeight', 'maxHeight', 'x', 'y', 'width', 'height'];

// Why the signed viewport, clip and maxHeight may not be rendered, or undefined when they may.
// Each is one integer. The viewport stays within maxRenderWidth × maxRenderHeight and a clip
// starts within it, but the clip itself is capped by area, maxClipArea pixels of any shape up to
// maxClipSide: the readers size page images by area, so the largest image of a very wide or tall
// page is past one side of the viewport cap but not past the area. A clip may lie outside the
// viewport, as Chrome renders past it and the readers' clips rely on that. A parameter that
// would be ignored on its own is refused instead: half a pair, x or y without a clip, maxHeight
// without a viewport.
module.exports = (params) => {
  const given = (key) => params[key] !== undefined;
  // A repeated key parses to an array, which fails the test as well.
  const notInteger = KEYS.find((key) => given(key) && !/^-?\d+$/.test(params[key]));
  if (notInteger) return `${notInteger} must be a single integer`;
  if (given('viewportWidth') !== given('viewportHeight')) {
    return 'viewportWidth and viewportHeight go together';
  }
  if (given('width') !== given('height')) return 'width and height go together';
  if ((given('x') || given('y')) && !given('width')) return 'x and y need width and height';
  if (given('maxHeight') && !given('viewportWidth')) {
    return 'maxHeight needs viewportWidth and viewportHeight';
  }
  const numbers = pluckNumbers(params, ...KEYS);
  const ranges = [
    ['viewportWidth', 1, maxRenderWidth],
    ['viewportHeight', 1, maxRenderHeight],
    ['maxHeight', 1, maxRenderHeight],
    ['x', 0, maxRenderWidth - 1],
    ['y', 0, maxRenderHeight - 1],
    ['width', 1, maxClipSide],
    ['height', 1, maxClipSide],
  ];
  const [key, min, max] =
    ranges.find(([k, lo, hi]) => numbers[k] !== undefined && (numbers[k] < lo || numbers[k] > hi)) || [];
  if (key) return `${key} must be from ${min} to ${max}`;
  if (given('width') && numbers.width * numbers.height > maxClipArea) {
    return `width * height must be at most ${maxClipArea}`;
  }
};
