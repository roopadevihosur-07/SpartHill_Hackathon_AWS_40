// Pure voice helpers (no DOM), so they can be unit-tested in Node.

// ------------------------------------------------------------------ choosing a voice
// The Web Speech API only exposes the voices installed in the caller's browser and OS, so we cannot
// ship our own. Instead we rank what is there and prefer a natural-sounding female voice.

const NOVELTY = /\b(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Junior|Organ|Pipe Organ|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Grandma|Grandpa|Kathy)\b/i;

const MALE = /\b(Alex|Daniel|Tom|Thomas|Oliver|Arthur|Aaron|Gordon|Rishi|Evan|Lee|Reed|Rocko|Eddy|David|Mark|George|Guy|Ryan|Davis|Brandon|Christopher|Eric|Jason|James|Roger|Steffan|Tony|Andrew|Brian|Jacob|Ethan|Alvaro|Álvaro|Jorge|Diego|Juan|Carlos|Pablo|Raul|Raúl|Alonso|Arnau|NamMinh|Nam Minh|Male)\b/i;

// Names that are known to be female, young-sounding and pleasant, best first within each language.
const FEMALE_PREFERRED = {
  en: /\b(Ava|Aria|Jenny|Samantha|Allison|Michelle|Emma|Joanna|Salli|Kendra|Kimberly|Zira|Susan|Serena|Karen|Moira|Tessa|Fiona|Victoria)\b/i,
  es: /\b(Paulina|Monica|Mónica|Dalia|Elvira|Sabina|Helena|Lupe|Marisol|Isabella|Camila|Lucia|Lucía)\b/i,
  vi: /\b(HoaiMy|Hoài My|Linh)\b/i,
};

const baseLang = (lang) => String(lang || '').replace('_', '-').toLowerCase().split('-')[0];

/** Higher is better. -Infinity means never use. */
export function scoreVoice(voice, lang) {
  const name = voice?.name ?? '';
  const vlang = String(voice?.lang ?? '').replace('_', '-').toLowerCase();
  const base = baseLang(lang);
  if (!vlang.startsWith(base)) return -Infinity;
  if (NOVELTY.test(name)) return -Infinity;

  let s = vlang === String(lang).toLowerCase() ? 30 : 10;
  if (/natural|neural|online/i.test(name)) s += 45; // Edge/Windows "Natural" and cloud voices sound best
  if (/premium/i.test(name)) s += 35;
  if (/enhanced/i.test(name)) s += 25;
  if (/\bgoogle\b/i.test(name)) s += 15;
  if (FEMALE_PREFERRED[base]?.test(name)) s += 30;
  if (/female|woman/i.test(name)) s += 20;
  if (MALE.test(name) && !/female/i.test(name)) s -= 80;
  return s;
}

/** Voices for a language, best first, without novelty voices. */
export function voicesFor(voices, lang) {
  return (voices ?? [])
    .map((v) => ({ v, s: scoreVoice(v, lang) }))
    .filter((x) => x.s > -Infinity)
    .sort((a, b) => b.s - a.s || a.v.name.localeCompare(b.v.name))
    .map((x) => x.v);
}

/** The user's saved choice if it still exists for this language, otherwise the best match. */
export function pickVoice(voices, lang, preferredName) {
  const list = voicesFor(voices, lang);
  if (preferredName) {
    const saved = list.find((v) => v.name === preferredName);
    if (saved) return saved;
  }
  return list[0] ?? null;
}

export const SAMPLE = {
  en: "Hi, I'm Lifeline. I'm here to help you. What do you need today?",
  es: 'Hola, soy Lifeline. Estoy aquí para ayudarle. ¿Qué necesita hoy?',
  vi: 'Xin chào, tôi là Lifeline. Tôi ở đây để giúp bạn. Bạn cần gì hôm nay?',
};

// Gentle, clear delivery: slightly slower than default and a touch brighter.
export const PROSODY = { rate: 0.96, pitch: 1.08, volume: 1 };

// ------------------------------------------------------------------ echo detection
// If the microphone picks up Lifeline's own voice from the speakers, the transcript is nearly the
// same words as something Lifeline just said. A real reply can reuse a few words ("hold it and send
// a driver") but not most of a sentence in the same order, so we use the longest run of matching
// words in order (LCS) and a high threshold.

export const words = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

function lcsLength(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * @param {string} heard   what the recognizer transcribed
 * @param {string[]} spoken the last few things Lifeline said out loud
 */
export function isEcho(heard, spoken, { minWords = 6, threshold = 0.85 } = {}) {
  const h = words(heard);
  if (h.length < minWords) return false; // short answers like "yes please" are never treated as echo
  return (spoken ?? []).some((s) => lcsLength(h, words(s)) / h.length >= threshold);
}
