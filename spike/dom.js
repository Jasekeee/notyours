// Attach to a running Chrome over CDP (alongside Kane) and inspect pages.
// Usage: node dom.js <browserURL> <needle> [--listen <seconds>]
//   default: print each page URL and whether body.innerText contains <needle>
//   --listen: also log every network response on all current and new pages for N seconds
const puppeteer = require('puppeteer-core');

async function main() {
  const [browserURL, needle, flag, secs] = process.argv.slice(2);
  if (!browserURL || !needle) {
    console.error('usage: node dom.js <browserURL> <needle> [--listen <seconds>]');
    process.exit(2);
  }
  // defaultViewport:null so we never resize Kane's window.
  const browser = await puppeteer.connect({ browserURL, defaultViewport: null });

  const report = async (label) => {
    for (const page of await browser.pages()) {
      let found = 'n/a';
      try {
        found = await page.evaluate((n) => document.body ? document.body.innerText.includes(n) : false, needle);
      } catch (e) { found = `error: ${e.message}`; }
      console.log(`[${label}] ${page.url()} contains(${JSON.stringify(needle)})=${found}`);
    }
  };

  await report('dom');

  if (flag === '--listen') {
    let n = 0;
    const watch = (page) => page.on('response', (r) => {
      n++;
      console.log(`[net] ${r.status()} ${r.request().method()} ${r.url()}`);
    });
    for (const p of await browser.pages()) watch(p);
    browser.on('targetcreated', async (t) => {
      if (t.type() !== 'page') return;
      const p = await t.page().catch(() => null);
      if (p) { console.log(`[target] new page ${t.url()}`); watch(p); }
    });
    await new Promise((r) => setTimeout(r, Number(secs || 60) * 1000));
    console.log(`[net] total responses captured: ${n}`);
    await report('dom-after');
  }

  browser.disconnect(); // leave Chrome running for Kane
}

main().catch((e) => { console.error(e); process.exit(1); });
