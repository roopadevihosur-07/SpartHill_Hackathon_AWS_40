// Deterministic safety net. The model is also told to call `escalate`, but a medical
// red flag must never depend on the model noticing it. Matching errs toward over-escalating
// (for example, negated phrases still trigger), because a false alarm costs a sentence
// and a miss can cost a life.

const FLAGS = [
  {
    flag: 'chest_pain',
    patterns: [
      /chest\s+(pain|pressure|tightness|hurts?)|(pain|pressure|tightness)\s+in\s+(my|the)\s+chest|heart\s+attack/i,
      /dolor\s+(de|en\s+el)\s+pecho|dolor\s+en\s+el\s+pecho|ataque\s+(al|de)\s+coraz[oó]n/i,
      /đau\s+ngực|tức\s+ngực/i,
    ],
  },
  {
    flag: 'difficulty_breathing',
    patterns: [
      /(can'?t|cannot|can\s+not|unable\s+to|hard\s+to|trouble|difficulty|struggling\s+to)\s+(to\s+)?breath/i,
      /short(ness)?\s+of\s+breath|not\s+breathing|gasping|choking/i,
      /no\s+puedo\s+respirar|falta\s+de\s+aire|dificultad\s+para\s+respirar|me\s+ahogo/i,
      /khó\s+thở|không\s+thở\s+được|ngộp\s+thở/i,
    ],
  },
  {
    flag: 'confusion',
    patterns: [
      /confus(ed|ion)|disoriented|don'?t\s+know\s+where\s+i\s+am|incoherent|can'?t\s+think\s+straight/i,
      /confundid[oa]|desorientad[oa]|no\s+s[eé]\s+d[oó]nde\s+estoy/i,
      /lú\s+lẫn|lẫn\s+lộn|không\s+biết\s+mình\s+đang\s+ở\s+đâu/i,
    ],
  },
  {
    flag: 'other',
    patterns: [
      /unconscious|unresponsive|passed\s+out|collaps(ed|e)|seizure|stroke|face\s+(is\s+)?droop|slurred\s+speech|overdos|suicid|want\s+to\s+die/i,
      /inconsciente|desmay[oó]|convulsi[oó]n|derrame\s+cerebral/i,
      /bất\s+tỉnh|co\s+giật|đột\s+quỵ/i,
    ],
  },
];

/** @returns {string|null} the first detected flag name, or null */
export function detectRedFlag(text) {
  if (typeof text !== 'string') return null;
  for (const { flag, patterns } of FLAGS) {
    if (patterns.some((re) => re.test(text))) return flag;
  }
  return null;
}

export const EMERGENCY_GUIDANCE = {
  en: "This could be an emergency. Please call 911 right now, or ask someone near you to call. I've alerted our coordinator Rosa, and I'll stay on with you.",
  es: 'Esto podría ser una emergencia. Por favor llame al 911 ahora mismo, o pida a alguien cercano que llame. Ya avisé a nuestra coordinadora Rosa y me quedo con usted.',
  vi: 'Đây có thể là trường hợp khẩn cấp. Xin hãy gọi 911 ngay bây giờ, hoặc nhờ người ở gần gọi giúp. Tôi đã báo cho điều phối viên Rosa và sẽ ở lại với bạn.',
};

export const guidanceFor = (language) => EMERGENCY_GUIDANCE[language] ?? EMERGENCY_GUIDANCE.en;

// Affirmative / negative detection for verbal consent. Deliberately conservative:
// anything that is not clearly "yes" is treated as NOT consent.
const YES =
  /^\s*(yes|yeah|yep|yup|sure|ok|okay|of course|please do|go ahead|that'?s fine|i consent|i agree|s[ií]|claro|por favor|vale|de acuerdo|v[âa]ng|d[ạa]|được|đồng ý|ok[eê])\b/i;
const NO =
  /\b(no|nope|nah|don'?t|do not|rather not|not comfortable|never|no quiero|prefiero que no|không|khong|đừng)\b/i;

// Does the caller need something delivered? Inferred from their own words so the answer never
// depends on the model remembering to set a flag. true / false / null (not stated).
const DELIVER_YES =
  /\b(no car|don'?t have a car|without a car|can'?t drive|cannot drive|no (ride|transportation|way to get)|can'?t (leave|get out|walk|go out)|cannot (leave|get out|walk)|homebound|bedridden|wheelchair|send (a |some )?(driver|volunteer|someone|it)|deliver|bring (it|them|some)|drop (it|them) off|me llevan|sin carro|sin coche|no tengo carro|no puedo (salir|manejar|conducir)|env[ií]e (a alguien|un conductor)|tra[ií]ganlo|không có xe|không thể (đi|lái)|giao (đến|tới|cho))/i;
const DELIVER_NO =
  /\b(i (can|will) (pick (it )?up|come|drive|go|walk)|i have a car|i'?ll come|i can get there|voy yo|puedo ir|tengo carro|tengo coche|tôi tự đến|tôi có xe)\b/i;

export function inferDelivery(text) {
  if (typeof text !== 'string') return null;
  if (DELIVER_YES.test(text)) return true;
  if (DELIVER_NO.test(text)) return false;
  return null;
}

export function classifyConsent(text) {
  if (typeof text !== 'string') return 'unclear';
  if (NO.test(text) && !YES.test(text)) return 'declined';
  if (YES.test(text) && !NO.test(text)) return 'granted';
  return 'unclear';
}
