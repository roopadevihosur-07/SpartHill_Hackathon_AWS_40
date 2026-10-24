// Best-effort PII redaction for anything we PERSIST (stored transcripts, decision log).
// Amazon Comprehend is not available on the event account, so this is rule-based:
// emails, phone numbers, SSN-like ids, street addresses, "my name is X" patterns and
// any names we already know (resident profile). It is not a guarantee. It is applied
// before storage, and if it throws, the text is NOT stored.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const STREET =
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl|circle|cir|highway|hwy)\b\.?(?:\s*(?:apt|apartment|unit|#)\s*\w+)?/gi;
const NAME_INTRO =
  /\b((?:my name is|my name's|i am|i'm|this is|me llamo|mi nombre es|soy|tôi tên là|tên tôi là|tôi là)\s+(?:(?:mr|mrs|ms|miss|dr|señor|señora|sr|sra)\.?\s+)?)(\p{L}[\p{L}'-]*(?:\s+\p{L}[\p{L}'-]*){0,2})/giu;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} text
 * @param {{knownNames?: string[]}} [opts]
 * @returns {string}
 * @throws if text is not a string (callers must treat a throw as "do not persist")
 */
export function redact(text, opts = {}) {
  if (typeof text !== 'string') throw new TypeError('redact: text must be a string');
  let out = text
    .replace(EMAIL, '[EMAIL]')
    .replace(SSN, '[ID]')
    .replace(PHONE, '[PHONE]')
    .replace(STREET, '[ADDRESS]');

  // "my name is X" only makes sense for what a CALLER says. Applied to the assistant it
  // wrongly turns "this is Lifeline" into "this is [NAME]". Known names are still redacted below.
  if (opts.nameIntro !== false) {
    out = out.replace(NAME_INTRO, (match, intro, name) =>
      /^\p{Lu}/u.test(name) ? `${intro}[NAME]` : match,
    );
  }

  for (const known of opts.knownNames ?? []) {
    for (const part of String(known).split(/\s+/)) {
      if (part.length < 3) continue;
      out = out.replace(new RegExp(`\\b${escapeRe(part)}\\b`, 'gi'), '[NAME]');
    }
  }
  return out;
}

/** Redact every string inside a JSON-like value. */
export function redactDeep(value, opts = {}) {
  if (typeof value === 'string') return redact(value, opts);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, opts)]));
  }
  return value;
}

/** Returns the redacted text, or null if redaction failed (caller must not persist). */
export function redactOrNull(text, opts = {}) {
  try {
    return redact(text, opts);
  } catch {
    return null;
  }
}
