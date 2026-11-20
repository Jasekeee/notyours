// Renders card.html to ../social-preview.png and ../../site/assets/social-preview.png (1280x640, the copy the site's
// og:image points to) with a local Chrome. Run: node assets/social-preview/render.mjs
// CHROME_PATH overrides the browser (default: Google Chrome on macOS).
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { copyFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = path.join(here, '..', 'social-preview.png');
const siteCopy = path.join(here, '..', '..', 'site', 'assets', 'social-preview.png');

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 640, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(here, 'card.html')).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, type: 'png', clip: { x: 0, y: 0, width: 1280, height: 640 } });
  copyFileSync(out, siteCopy);
  console.log(`wrote ${out} and ${siteCopy}`);
} finally {
  await browser.close();
}
