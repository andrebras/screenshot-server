const {screenshotUserAgent} = require('../src/config');

module.exports = async function render(page, spec) {
  await page.setUserAgent(screenshotUserAgent);
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(30000);
  if (spec.viewportWidth && spec.viewportHeight) {
    await page.setViewport({width: spec.viewportWidth, height: spec.viewportHeight});
  }
  const response = await page.goto(spec.src, {
    waitUntil: spec.readiness === 'assets' ? 'load' : 'networkidle0',
  });
  if (!response || response.status() >= 400) {
    throw new Error(`Error loading page: ${response?.status()}`);
  }
  if (spec.readiness === 'assets') await ready(page);
  if (spec.maxHeight && spec.viewportWidth) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewport({width: spec.viewportWidth, height: Math.max(1, Math.min(height, spec.maxHeight))});
    if (spec.readiness === 'assets') {
      await ready(page);
    }
  }
  const clip = spec.width && spec.height
    ? {x: spec.x || 0, y: spec.y || 0, width: spec.width, height: spec.height}
    : undefined;
  return Buffer.from(await page.screenshot({type: 'jpeg', quality: 95, clip}));
};

async function ready(page) {
  await page.evaluate(async () => {
    await window.__publitasScreenshotReady;
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
