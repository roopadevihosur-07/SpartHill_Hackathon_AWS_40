import { el, clear, api } from './common.js';
import { pickVoice, voicesFor, isEcho, PROSODY, SAMPLE } from './voice.js';

const $ = (id) => document.getElementById(id);

const SPEECH_LANG = { en: 'en-US', es: 'es-US', vi: 'vi-VN' };
const FILLER = {
  en: 'One moment, checking that for you.',
  es: 'Un momento, lo estoy revisando.',
  vi: 'Xin chờ một chút, tôi đang kiểm tra.',
};
const SILENCE_MS = 1500; // end of utterance
const REQUEST_TIMEOUT_MS = 15000; // show an error + retry after this long
const FILLER_AFTER_MS = 1800;
// After Lifeline stops talking, keep the microphone closed this long so the end of its own voice
// and the room echo are not transcribed as the caller.
const ECHO_GUARD_MS = 900;
const VOICE_KEY = 'lifeline.voice';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;

const S = {
  config: null,
  sessionId: null,
  language: 'en',
  events: null,
  recognition: null,
  state: 'idle', // idle | listening | thinking | speaking | ended
  micAllowed: false,
  shown: new Set(),
  speakQueue: [],
  busy: false,
  lastTurn: null,
  fillerTimer: null,
  fillerSpoken: false,
  silenceTimer: null,
  finalBuf: '',
  interimBuf: '',
  residentSource: null,
  speaking: false, // true from the moment Lifeline starts talking until its last sentence ends
  speechGen: 0, // bumped on cancel so a cancelled utterance cannot start the next one
  cancelledAt: 0,
  listenBlockedUntil: 0,
  resumeTimer: null,
  spokenRecent: [], // what Lifeline said lately, for echo detection
};

const baseLang = (lang) => lang.split('-')[0];
const savedVoices = () => { try { return JSON.parse(localStorage.getItem(VOICE_KEY) ?? '{}'); } catch { return {}; } };
const currentVoice = (lang) => pickVoice(synth?.getVoices?.() ?? [], lang, savedVoices()[baseLang(lang)]);

// ------------------------------------------------------------------ ui helpers

function setState(state, text) {
  S.state = state;
  $('dot').className = `dot ${['listening', 'thinking', 'speaking'].includes(state) ? state : ''}`;
  $('status-text').textContent = text ?? {
    idle: 'Ready', listening: 'Listening… speak now', thinking: 'Working on it…', speaking: 'Lifeline is speaking…', ended: 'Call ended',
  }[state];
}

function banner(kind, text, actions = []) {
  const box = el('div', { class: `banner ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, el('span', { text }), ...actions);
  $('banners').append(box);
  return box;
}
const clearBanners = () => clear($('banners'));

function addBubble(role, text, extra = '') {
  const b = el('div', { class: `bubble ${role} ${extra}`.trim(), text });
  $('transcript').append(b);
  $('transcript').scrollTop = $('transcript').scrollHeight;
  return b;
}

function renderMessages(messages = [], { speak = true } = {}) {
  for (const m of messages) {
    if (S.shown.has(m.id)) continue;
    S.shown.add(m.id);
    addBubble('assistant', m.text, m.redFlag ? 'alert' : '');
    if (speak) enqueueSpeech(m.text);
  }
}

function renderCards(cards) {
  const root = clear($('cards'));
  const c = cards?.confirmation;
  if (!c || c.state === 'none') return;
  if (c.state === 'pending_approval' || c.state === 'replanning' || c.state === 'failed') {
    root.append(el('div', { class: `card conf ${c.state === 'pending_approval' ? 'pending' : c.state}` },
      el('h2', { text: { pending_approval: 'Waiting for approval', replanning: 'Updating your plan', failed: 'We need a person to help' }[c.state] }),
      el('p', { text: c.message })));
    return;
  }
  const rows = [['Where', `${c.site.name}`], ['Address', c.site.address], ['Hours', c.site.hours], ['Item', c.item], ['Hold number', c.holdId]];
  if (c.driver) rows.push(['Driver', `${c.driver.name} (${c.driver.vehicle})`], ['Arrives in about', `${c.etaMin} min`]);
  root.append(el('div', { class: 'card conf', role: 'group', 'aria-label': 'Confirmation' },
    el('h2', { text: c.state === 'dispatched' ? 'Help is on the way' : 'Your hold is confirmed' }),
    el('dl', {}, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
    el('div', { class: 'sms' }, el('div', { class: 'from', text: 'Text message sent to you (demo)' }), el('div', { text: c.sms }))));
}

// ------------------------------------------------------------------ speech output

function enqueueSpeech(text) {
  if (!synth || S.state === 'ended') return;
  S.spokenRecent.push(text);
  if (S.spokenRecent.length > 4) S.spokenRecent.shift();
  S.speakQueue.push(text);
  if (!S.speaking) speakNext();
}

function speakNext() {
  const text = S.speakQueue.shift();
  if (text === undefined) { endSpeaking(); return; }
  stopListening(); // never listen while talking
  S.speaking = true;
  setState('speaking');
  const gen = S.speechGen;
  const lang = SPEECH_LANG[S.language];
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  const voice = currentVoice(lang);
  if (voice) u.voice = voice;
  Object.assign(u, PROSODY);
  const next = () => { if (gen === S.speechGen) speakNext(); };
  u.onend = next;
  u.onerror = next;
  // Chrome can drop a speak() issued right after cancel(), so leave it a moment.
  const wait = Math.max(0, S.cancelledAt + 90 - Date.now());
  if (wait) setTimeout(() => { if (gen === S.speechGen) synth.speak(u); }, wait);
  else synth.speak(u);
}

function endSpeaking() {
  S.speaking = false;
  S.listenBlockedUntil = Date.now() + ECHO_GUARD_MS;
  clearTimeout(S.resumeTimer);
  S.resumeTimer = setTimeout(resumeListening, ECHO_GUARD_MS + 50);
}

/** Open the microphone again if nothing is happening. Safe to call at any time. */
function resumeListening() {
  if (S.state === 'ended' || !S.sessionId || S.busy || S.speaking || S.speakQueue.length) return;
  if (S.micAllowed) startListening();
  else setState('idle', 'Type your message below');
}

function cancelSpeech() {
  S.speechGen++; // anything cancelled here must not start the next utterance
  S.speakQueue = [];
  S.speaking = false;
  S.cancelledAt = Date.now();
  synth?.cancel();
}

// ------------------------------------------------------------------ voice picker

function populateVoices() {
  const sel = $('voice');
  if (!sel || !synth) return;
  const lang = SPEECH_LANG[$('language').value] ?? 'en-US';
  const voices = voicesFor(synth.getVoices(), lang);
  clear(sel);
  $('voice-row').classList.toggle('hidden', voices.length === 0);
  for (const v of voices) sel.append(el('option', { value: v.name, text: v.name.replace(/^Microsoft\s+/i, '').replace(/\s*-\s*[A-Za-z ()]+$/, '') }));
  const chosen = currentVoice(lang);
  if (chosen) sel.value = chosen.name;
}

function sampleVoice() {
  if (!synth) return;
  const language = $('language').value;
  const lang = SPEECH_LANG[language] ?? 'en-US';
  const voices = synth.getVoices();
  const voice = voices.find((v) => v.name === $('voice').value) ?? currentVoice(lang);
  synth.cancel();
  const u = new SpeechSynthesisUtterance(SAMPLE[language] ?? SAMPLE.en);
  u.lang = lang;
  if (voice) u.voice = voice;
  Object.assign(u, PROSODY);
  setTimeout(() => synth.speak(u), 90);
}

// ------------------------------------------------------------------ speech input

async function ensureMic() {
  if (!SR) return false;
  if (S.micAllowed) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    S.micAllowed = true;
    return true;
  } catch {
    banner('error', 'Voice input is unavailable because microphone access was denied. You can type your request instead.');
    $('mic').classList.add('hidden');
    return false;
  }
}

function startListening() {
  if (!SR || !S.micAllowed || S.busy || S.state === 'ended' || S.recognition || !S.sessionId) return;
  // Never open the microphone while Lifeline is talking or just after, or it hears itself.
  if (S.speaking || S.speakQueue.length || synth?.speaking) return;
  const wait = S.listenBlockedUntil - Date.now();
  if (wait > 0) { clearTimeout(S.resumeTimer); S.resumeTimer = setTimeout(resumeListening, wait + 50); return; }

  const r = new SR();
  r.lang = SPEECH_LANG[S.language];
  r.continuous = true;
  r.interimResults = true;
  S.finalBuf = '';
  S.interimBuf = '';
  r.onresult = (e) => {
    if (S.recognition !== r) return; // a recognizer we already closed must not send anything
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) S.finalBuf += `${t} `;
      else interim += t;
    }
    S.interimBuf = interim;
    $('interim').textContent = `${S.finalBuf}${interim}`.trim();
    clearTimeout(S.silenceTimer);
    S.silenceTimer = setTimeout(finishUtterance, SILENCE_MS);
  };
  r.onerror = (e) => {
    if (S.recognition !== r) return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      S.micAllowed = false;
      banner('error', 'Voice input is unavailable because microphone access was denied. You can type your request instead.');
      $('mic').classList.add('hidden');
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      banner('error', `Voice input had a problem (${e.error}). You can type instead.`);
    }
  };
  r.onend = () => {
    if (S.recognition !== r) return;
    S.recognition = null; // browsers stop on silence: reopen unless we are busy or talking
    setTimeout(resumeListening, 250);
  };
  try {
    r.start();
    S.recognition = r;
    setState('listening');
    $('mic').textContent = 'Microphone on';
  } catch {
    S.recognition = null;
  }
}

function stopListening() {
  clearTimeout(S.silenceTimer);
  const r = S.recognition;
  S.recognition = null;
  if (r) {
    // Detach everything first: a stopping recognizer can still deliver its last result, and
    // that result must not be sent. abort() discards it, where stop() would deliver it.
    r.onresult = null; r.onerror = null; r.onend = null;
    try { r.abort(); } catch { try { r.stop(); } catch { /* already stopped */ } }
  }
  S.finalBuf = '';
  S.interimBuf = '';
  $('interim').textContent = '';
  $('mic').textContent = 'Microphone';
}

function finishUtterance() {
  // finalBuf holds the finished phrases, interimBuf the phrase still in progress. (The on-screen
  // preview shows both, so reading it back as well sent every word twice.)
  const text = `${S.finalBuf} ${S.interimBuf}`.trim().replace(/\s+/g, ' ');
  stopListening();
  if (text.length < 2) { resumeListening(); return; }
  if (isEcho(text, S.spokenRecent)) {
    // The microphone picked up Lifeline's own voice. Drop it instead of answering ourselves.
    console.info('Ignored echo of Lifeline\'s own voice:', text);
    resumeListening();
    return;
  }
  send(text);
}

// ------------------------------------------------------------------ talking to the server

async function send(text, existing) {
  if (!S.sessionId) return;
  const turn = existing ?? { text, id: crypto.randomUUID() };
  S.lastTurn = turn;
  if (!existing) addBubble('user', turn.text);
  clearBanners();

  S.busy = true;
  S.fillerSpoken = false;
  stopListening();
  cancelSpeech();
  setState('thinking');
  clearTimeout(S.fillerTimer);
  S.fillerTimer = setTimeout(() => {
    if (S.busy && !S.fillerSpoken) { S.fillerSpoken = true; enqueueSpeech(FILLER[S.language]); }
  }, FILLER_AFTER_MS);

  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const out = await api('/api/chat', { method: 'POST', body: { sessionId: S.sessionId, message: turn.text, clientMsgId: turn.id }, signal: ctl.signal });
    S.fillerSpoken = true;
    cancelSpeech();
    renderMessages(out.messages);
    renderCards(out.cards);
    S.lastTurn = null;
  } catch (err) {
    const tooLong = err.name === 'AbortError';
    banner('error', tooLong ? 'Lifeline is taking longer than usual.' : (err.message === 'rate_limited' ? 'Too many messages. Please wait a moment.' : 'We could not complete that request.'), [
      el('button', { class: 'btn small', type: 'button', text: 'Try again', onclick: () => send(turn.text, turn) }),
    ]);
    // The server keeps working on a timed-out turn and pushes the reply over the event stream.
  } finally {
    clearTimeout(timeout);
    clearTimeout(S.fillerTimer);
    S.busy = false;
    resumeListening(); // waits if Lifeline is still speaking
  }
}

function openEvents(sessionId) {
  S.events?.close();
  const es = new EventSource(`/api/events/${encodeURIComponent(sessionId)}`);
  S.events = es;
  es.addEventListener('message', (e) => renderMessages([JSON.parse(e.data)]));
  es.addEventListener('cards', (e) => renderCards(JSON.parse(e.data)));
  es.addEventListener('status', () => {
    if (S.busy && !S.fillerSpoken && S.state === 'thinking') $('status-text').textContent = 'Checking for you…';
  });
}

// ------------------------------------------------------------------ call lifecycle

async function beginCall({ sessionId, language, greeting, messages, cards }) {
  S.sessionId = sessionId;
  S.language = language;
  S.shown = new Set();
  clear($('transcript'));
  clear($('cards'));
  $('setup').classList.add('hidden');
  $('call').classList.remove('hidden');
  openEvents(sessionId);

  // Show (and speak) the greeting first so it never lands below the caller's first message
  // while the browser's microphone permission prompt is open.
  S.spokenRecent = [];
  S.speaking = false;
  S.listenBlockedUntil = 0;
  if (greeting) { addBubble('assistant', greeting); enqueueSpeech(greeting); }
  if (!SR) {
    banner('info', 'Voice input is not supported in this browser, so please type your request below. Replies are still shown as text.');
    $('mic').classList.add('hidden');
  } else {
    await ensureMic();
  }
  renderMessages(messages);
  renderCards(cards);
  if (!S.micAllowed) setState('idle', 'Type your message below');
  else if (!S.speaking && !S.speakQueue.length) resumeListening();
  $('textinput').focus({ preventScroll: true });
}

async function startInbound() {
  $('start').disabled = true;
  try {
    const language = $('language').value;
    const s = await api('/api/session', { method: 'POST', body: { language, neighborhood: $('hood').value } });
    await beginCall({ sessionId: s.sessionId, language: s.language, greeting: s.greeting });
  } catch (err) {
    banner('error', 'Could not start the call. Please try again.');
    $('start').disabled = false;
  }
}

function endCall() {
  setState('ended');
  clearTimeout(S.resumeTimer);
  stopListening();
  cancelSpeech();
  S.events?.close();
  S.sessionId = null;
  $('call').classList.add('hidden');
  $('setup').classList.remove('hidden');
  $('start').disabled = false;
  clearBanners();
  banner('info', 'Call ended. If you still need help, start a new call. In an emergency, call 911.');
}

// ------------------------------------------------------------------ outbound ("Lifeline calls you")

function watchForCalls(residentId) {
  S.residentSource?.close();
  S.residentSource = null;
  if (!residentId) return;
  const es = new EventSource(`/api/resident-events/${encodeURIComponent(residentId)}`);
  S.residentSource = es;
  es.addEventListener('incoming_call', (e) => showIncoming(residentId, JSON.parse(e.data).callId));
}

function showIncoming(residentId, callId) {
  const actions = clear($('incoming-actions'));
  actions.append(
    el('button', { class: 'btn good mic', type: 'button', text: 'Answer', onclick: async () => {
      $('incoming').classList.add('hidden');
      try {
        const out = await api(`/api/resident/${encodeURIComponent(residentId)}/answer`, { method: 'POST', body: { callId } });
        await beginCall({ sessionId: out.sessionId, language: out.language, messages: out.messages, cards: out.cards });
      } catch { banner('error', 'The call could not be connected.'); }
    } }),
    el('button', { class: 'btn', type: 'button', text: 'Decline', onclick: () => $('incoming').classList.add('hidden') }),
  );
  $('incoming').classList.remove('hidden');
  actions.firstChild.focus();
}

// ------------------------------------------------------------------ init

async function init() {
  S.config = await api('/api/config');
  const fill = (sel, items, label) => items.forEach((i) => sel.append(el('option', { value: i.id, text: label(i) })));
  fill($('language'), S.config.languages, (l) => l.label);
  fill($('hood'), S.config.neighborhoods, (n) => n.label);
  $('resident').append(el('option', { value: '', text: 'No, I am an anonymous caller' }));
  fill($('resident'), S.config.residents, (r) => `${r.displayName} (opted in)`);
  if (!S.config.residents.length) $('demo-tools').classList.add('hidden');

  $('start').addEventListener('click', startInbound);
  $('end').addEventListener('click', endCall);
  $('resident').addEventListener('change', () => watchForCalls($('resident').value));
  $('mic').addEventListener('click', async () => {
    if (S.recognition) { stopListening(); setState('idle', 'Microphone off'); return; }
    if (await ensureMic()) startListening();
  });
  $('textform').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('textinput').value.trim();
    if (!v) return;
    $('textinput').value = '';
    send(v);
  });
  $('language').addEventListener('change', () => { S.language = $('language').value; populateVoices(); });
  if (synth) {
    populateVoices();
    synth.addEventListener?.('voiceschanged', populateVoices); // browsers load voices asynchronously
    $('voice').addEventListener('change', () => {
      const saved = savedVoices();
      saved[baseLang(SPEECH_LANG[$('language').value] ?? 'en-US')] = $('voice').value;
      try { localStorage.setItem(VOICE_KEY, JSON.stringify(saved)); } catch { /* private mode */ }
      sampleVoice();
    });
    $('voice-sample').addEventListener('click', sampleVoice);
  } else {
    $('voice-row').classList.add('hidden');
  }
  if (!SR) $('mic')?.classList.add('hidden');
}

init().catch(() => banner('error', 'Lifeline could not load. Please refresh the page.'));
