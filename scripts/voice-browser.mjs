// In-browser regression test for the voice experience (the caller page).
//
//   npm install --no-save puppeteer-core     (once; it uses your installed Chrome, no download)
//   npm start                                (in another terminal)
//   npm run test:voice:browser
//
// A headless browser has no microphone, so this swaps in a fake speech recognizer and a fake voice
// engine that copy Chrome's awkward behaviour (a stopped recognizer can still deliver a last result,
// a cancelled utterance reports late). Model replies are canned, so it needs no AWS credentials.
// It checks: no doubled words, no answering Lifeline's own voice, the microphone stays closed while
// Lifeline talks, and the preferred female voice is chosen.
import puppeteer from 'puppeteer-core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = [];
const check = (label, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  ' + extra}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // ---- fakes that behave like Chrome, including its awkward parts
  await page.evaluateOnNewDocument(() => {
    window.__speaking = false;
    window.__spoken = []; // {text, voice, pitch, rate, lang, at}
    window.__speechEnds = []; // times when speech finished
    window.__recStarts = []; // {at, whileSpeaking}
    window.__recs = [];

    const VOICES = [
      { name: 'Daniel', lang: 'en-GB' }, { name: 'Alex', lang: 'en-US' }, { name: 'Bad News', lang: 'en-US' },
      { name: 'Samantha', lang: 'en-US' }, { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
      { name: 'Paulina', lang: 'es-MX' }, { name: 'Jorge', lang: 'es-ES' }, { name: 'Linh', lang: 'vi-VN' },
    ];
    class Utt { constructor(text) { this.text = text; this.rate = 1; this.pitch = 1; this.volume = 1; } }
    window.SpeechSynthesisUtterance = Utt;
    let current = null;
    const synth = {
      get speaking() { return window.__speaking; },
      getVoices: () => VOICES,
      addEventListener() {},
      speak(u) {
        window.__speaking = true;
        current = u;
        window.__spoken.push({ text: u.text, voice: u.voice?.name ?? null, pitch: u.pitch, rate: u.rate, lang: u.lang, at: performance.now() });
        setTimeout(() => {
          if (current !== u) return; // was cancelled
          window.__speaking = false; current = null;
          window.__speechEnds.push(performance.now());
          if (u.onend) u.onend({});
        }, 400);
      },
      cancel() {
        const u = current; current = null;
        window.__speaking = false;
        // Chrome reports a cancelled utterance asynchronously, as an error event.
        if (u) setTimeout(() => u.onerror && u.onerror({ error: 'interrupted' }), 5);
      },
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });

    class FakeSR {
      constructor() { this.running = false; this.aborted = false; this.stopped = false; window.__recs.push(this); }
      start() { this.running = true; window.__recStarts.push({ at: performance.now(), whileSpeaking: window.__speaking }); }
      stop() { this.running = false; this.stopped = true; }
      abort() { this.running = false; this.aborted = true; }
    }
    window.SpeechRecognition = FakeSR;
    window.webkitSpeechRecognition = FakeSR;
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });

    // Deliver a recognition event to whichever recognizer is running, like Chrome would.
    window.__hear = (finalText, interimText) => {
      const r = [...window.__recs].reverse().find((x) => x.running);
      if (!r || typeof r.onresult !== 'function') return false;
      const results = [];
      if (finalText) { const a = [{ transcript: finalText }]; a.isFinal = true; results.push(a); }
      if (interimText) { const a = [{ transcript: interimText }]; a.isFinal = false; results.push(a); }
      r.onresult({ resultIndex: 0, results });
      return true;
    };
  });

  // ---- canned replies instead of Bedrock, so the test is deterministic
  const chat = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/chat')) {
      const body = JSON.parse(req.postData() ?? '{}');
      chat.push({ at: Date.now(), message: body.message });
      const reply = chat.length === 1
        ? 'Which medicine do you need, for example insulin, blood pressure pills, or an inhaler?'
        : 'Okay, I can help with that.';
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [{ id: `canned-${chat.length}`, role: 'assistant', text: reply }], cards: { confirmation: { state: 'none' } } }) });
    } else req.continue();
  });

  await page.goto(`${BASE}/caller.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 8000 });

  // ---- voice choice
  const opts = await page.$$eval('#voice option', (o) => o.map((x) => x.textContent));
  const selected = await page.$eval('#voice', (s) => s.value);
  check('voice list excludes novelty voices', !opts.some((o) => /Bad News/.test(o)), opts.join(', '));
  check('default voice is the natural female one (Aria), not Daniel or Alex', /Aria/.test(selected), selected);
  check('male voices are ranked last', opts.findIndex((o) => /Aria|Samantha/.test(o)) < opts.findIndex((o) => /Daniel|Alex/.test(o)), opts.join(', '));
  await page.select('#language', 'es');
  const esOpts = await page.$$eval('#voice option', (o) => o.map((x) => x.textContent));
  check('Spanish list shows Paulina first', esOpts[0] === 'Paulina', esOpts.join(', '));
  await page.select('#language', 'en');

  // ---- start the call
  await page.click('#start');
  await page.waitForFunction(() => document.querySelectorAll('.bubble.assistant').length >= 1, { timeout: 10000 });
  await page.waitForFunction(() => window.__speechEnds.length >= 1, { timeout: 8000 });
  const greetEnd = await page.evaluate(() => window.__speechEnds[0]);
  const spoken0 = await page.evaluate(() => window.__spoken[0]);
  check('greeting spoken with Aria at the gentle settings', /Aria/.test(spoken0.voice ?? '') && spoken0.pitch === 1.08 && spoken0.rate === 0.96, JSON.stringify(spoken0));

  await page.waitForFunction(() => window.__recStarts.length >= 1, { timeout: 8000 });
  const firstStart = await page.evaluate(() => window.__recStarts[0]);
  check('microphone did not open while Lifeline was speaking', firstStart.whileSpeaking === false);
  check(`microphone waited after speech ended (${Math.round(firstStart.at - greetEnd)} ms, needs >= 850)`, firstStart.at - greetEnd >= 850, `${firstStart.at - greetEnd}`);

  // ---- bug 1: words doubled. Chrome shows interim text, then the same words as final.
  check('recognizer was listening', await page.evaluate(() => window.__hear('', 'I need insulin for my blood sugar')));
  await sleep(300);
  await page.evaluate(() => window.__hear('I need insulin for my blood sugar', ''));
  const t0 = Date.now();
  while (chat.length < 1 && Date.now() - t0 < 4000) await sleep(100);
  check('utterance sent once', chat.length === 1, `requests=${chat.length}`);
  check('text is NOT doubled', chat[0]?.message === 'I need insulin for my blood sugar', JSON.stringify(chat[0]?.message));

  // ---- bug 2a: a recognizer we closed must not be able to send anything late
  const stale = await page.evaluate(() => {
    const closed = window.__recs.filter((r) => !r.running);
    return closed.length > 0 && closed.every((r) => r.onresult === null && r.onend === null && (r.aborted || r.stopped));
  });
  check('closed recognizers are detached and aborted (cannot deliver a late result)', stale);

  // ---- wait for the canned reply to be spoken, then for the guard period to pass
  await page.waitForFunction(() => window.__spoken.length >= 2 && window.__speechEnds.length >= 2, { timeout: 8000 });
  await page.waitForFunction(() => window.__recStarts.length >= 2, { timeout: 8000 });
  const violations = await page.evaluate(() => window.__recStarts.filter((s) => s.whileSpeaking).length);
  check('microphone never opened while Lifeline was speaking (whole call)', violations === 0, `${violations} violations`);

  // ---- bug 2b: the microphone hears Lifeline's own voice. It must be dropped.
  await page.evaluate(() => window.__hear('which medicine do you need for example insulin blood pressure pills or an inhaler', ''));
  await sleep(2300);
  check("echo of Lifeline's own sentence is NOT sent", chat.length === 1, `requests=${chat.length}`);

  // ---- a real answer that reuses a few of the same words must still go through
  await page.evaluate(() => window.__hear('insulin please', ''));
  const t1 = Date.now();
  while (chat.length < 2 && Date.now() - t1 < 4000) await sleep(100);
  check('a genuine short answer ("insulin please") is still sent', chat[1]?.message === 'insulin please', JSON.stringify(chat[1]?.message));

  check('no console errors', errors.length === 0, errors.join(' | '));
  await page.screenshot({ path: join(tmpdir(), 'lifeline-caller-voice.png') });
} catch (e) {
  out.push('FAIL  test crashed: ' + e.message);
}
await browser.close();
console.log(out.join('\n'));
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${failed ? `${failed} FAILED` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
