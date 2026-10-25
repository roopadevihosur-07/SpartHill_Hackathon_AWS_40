// Background tabs must not hog the browser's connection pool.   npm run test:streams:browser
//
//   npm install --no-save puppeteer-core     (once)
//   npm start                                (another terminal)
//
// A browser allows 6 connections per address, shared by all tabs. Each console or driver tab holds one
// live stream; when all 6 are used, a caller's chat message waits in the browser and never reaches the
// server. This checks that hidden tabs release their stream, get it back (with data) when shown, and do
// not retry in a loop while hidden. It also reproduces the starvation itself, so the problem stays visible.
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = [];
const check = (label, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  ' + extra}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Count live streams by watching fetch() calls to /stream URLs and whether their signal was aborted.
const INSTRUMENT = () => {
  window.__streams = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (String(url).includes('/stream')) window.__streams.push({ url: String(url), signal: opts?.signal ?? null, at: performance.now() });
    return realFetch(url, opts);
  };
  let hidden = false;
  Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
  window.__setHidden = (h) => { hidden = h; document.dispatchEvent(new Event('visibilitychange')); };
  window.__live = () => window.__streams.filter((s) => s.signal && !s.signal.aborted).length;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
try {
  for (const [name, path, marker] of [
    ['console', '/console.html', '#kpis .kpi'],
    ['driver', '/driver.html?driver=v1', '#jobs .card'],
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluateOnNewDocument(INSTRUMENT);
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(marker, { timeout: 10000 });
    await sleep(500);

    check(`${name}: one live stream while the tab is showing`, (await page.evaluate(() => window.__live())) === 1);

    await page.evaluate(() => window.__setHidden(true));
    await sleep(600);
    check(`${name}: hidden tab LETS GO of its connection`, (await page.evaluate(() => window.__live())) === 0);

    const callsWhileHidden = await page.evaluate(() => window.__streams.length);
    await sleep(2500); // a retry loop would open several new streams in this time
    check(`${name}: hidden tab does not retry in a loop`, (await page.evaluate(() => window.__streams.length)) === callsWhileHidden, `${callsWhileHidden} -> ${await page.evaluate(() => window.__streams.length)}`);

    await page.evaluate(() => window.__setHidden(false));
    await sleep(1200);
    check(`${name}: shown again, it reconnects`, (await page.evaluate(() => window.__live())) === 1);
    if (name === 'console') {
      const live = await page.$eval('#conn', (e) => e.textContent);
      check(`${name}: and reports live (${live})`, live === 'live', live);
    }

    // flapping hidden/shown quickly must not leak connections
    for (let i = 0; i < 6; i++) { await page.evaluate(() => window.__setHidden(true)); await page.evaluate(() => window.__setHidden(false)); }
    await sleep(1500);
    check(`${name}: rapid hide/show leaves exactly one live stream`, (await page.evaluate(() => window.__live())) === 1, String(await page.evaluate(() => window.__live())));
    check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
    await page.close();
  }

  // The failure this prevents: with all 6 slots held by streams, a chat request never leaves the browser.
  const page = await browser.newPage();
  await page.goto(BASE + '/caller.html', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const s = await (await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"language":"en"}' })).json();
    const streams = Array.from({ length: 6 }, () => new EventSource(`/api/events/${s.sessionId}`));
    await new Promise((r) => setTimeout(r, 1200));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    let starved = false;
    try { await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: s.sessionId, message: '', clientMsgId: 'starve' }), signal: ctl.signal }); } catch { starved = true; }
    clearTimeout(timer);
    streams.forEach((x) => x.close());
    return starved;
  });
  check('reference: 6 held streams really do starve a chat request (this is the bug being prevented)', result === true);
  await page.close();
} catch (e) {
  out.push('FAIL  test crashed: ' + e.message);
}
await browser.close();
console.log(out.join('\n'));
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${failed ? `${failed} FAILED` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
