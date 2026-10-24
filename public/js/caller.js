import { el, clear, api } from './common.js';

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
  residentSource: null,
};

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

function pickVoice(lang) {
  const voices = synth?.getVoices?.() ?? [];
  const base = lang.split('-')[0];
  return voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang.startsWith(base)) ?? null;
}

function enqueueSpeech(text) {
  if (!synth || S.state === 'ended') return;
  S.speakQueue.push(text);
  if (!synth.speaking) speakNext();
}

function speakNext() {
  const text = S.speakQueue.shift();
  if (text === undefined) {
    if (S.state === 'speaking') startListening();
    return;
  }
  stopListening();
  setState('speaking');
  const u = new SpeechSynthesisUtterance(text);
  u.lang = SPEECH_LANG[S.language];
  const voice = pickVoice(u.lang);
  if (voice) u.voice = voice;
  u.onend = speakNext;
  u.onerror = speakNext;
  synth.speak(u);
}

function cancelSpeech() {
  S.speakQueue = [];
  synth?.cancel();
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
  if (!SR || !S.micAllowed || S.busy || S.state === 'ended' || S.recognition) return;
  const r = new SR();
  r.lang = SPEECH_LANG[S.language];
  r.continuous = true;
  r.interimResults = true;
  S.finalBuf = '';
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) S.finalBuf += `${t} `;
      else interim += t;
    }
    $('interim').textContent = (S.finalBuf + interim).trim();
    clearTimeout(S.silenceTimer);
    S.silenceTimer = setTimeout(finishUtterance, SILENCE_MS);
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      S.micAllowed = false;
      banner('error', 'Voice input is unavailable because microphone access was denied. You can type your request instead.');
      $('mic').classList.add('hidden');
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      banner('error', `Voice input had a problem (${e.error}). You can type instead.`);
    }
  };
  r.onend = () => {
    S.recognition = null;
    if (S.state === 'listening' && !S.busy) setTimeout(startListening, 250); // browsers stop on silence
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
  if (r) { r.onend = null; try { r.stop(); } catch { /* already stopped */ } }
  $('interim').textContent = '';
  $('mic').textContent = 'Microphone';
}

function finishUtterance() {
  const text = (S.finalBuf + ' ' + $('interim').textContent).trim().replace(/\s+/g, ' ');
  S.finalBuf = '';
  stopListening();
  if (text) send(text);
  else if (S.state === 'listening') startListening();
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
    if (!synth?.speaking && S.speakQueue.length === 0 && S.state !== 'ended') {
      if (S.micAllowed) startListening(); else setState('idle', 'Type your message below');
    }
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
  if (greeting) { addBubble('assistant', greeting); enqueueSpeech(greeting); }
  if (!SR) {
    banner('info', 'Voice input is not supported in this browser, so please type your request below. Replies are still shown as text.');
    $('mic').classList.add('hidden');
  } else {
    await ensureMic();
  }
  renderMessages(messages);
  renderCards(cards);
  if (!synth?.speaking && S.micAllowed) startListening();
  else if (!S.micAllowed) setState('idle', 'Type your message below');
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
  $('language').addEventListener('change', () => { S.language = $('language').value; });
  synth?.getVoices?.(); // warm the voice list
  if (!SR) $('mic')?.classList.add('hidden');
}

init().catch(() => banner('error', 'Lifeline could not load. Please refresh the page.'));
