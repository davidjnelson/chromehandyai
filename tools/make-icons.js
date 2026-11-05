// Renders icons/icon.svg to the PNG sizes the manifest needs.
// Usage: node tools/make-icons.js
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'icons', 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(__dirname, '..', 'icons', `icon${size}.png`), omitBackground: true });
    await page.close();
  }
  await browser.close();
  console.log('icons written');
})();
