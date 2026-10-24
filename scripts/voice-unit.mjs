// Fast checks for the voice helpers (no browser, no AWS).   npm run test:voice
import { scoreVoice, voicesFor, pickVoice, isEcho, words } from '../public/js/voice.js';

const out = [];
const check = (label, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  ' + extra}`);

const V = [
  { name: 'Daniel', lang: 'en-GB' }, { name: 'Alex', lang: 'en-US' }, { name: 'Bad News', lang: 'en-US' },
  { name: 'Samantha', lang: 'en-US' }, { name: 'Google US English', lang: 'en-US' },
  { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
  { name: 'Paulina', lang: 'es-MX' }, { name: 'Jorge', lang: 'es-ES' }, { name: 'Linh', lang: 'vi-VN' },
];

// ---- voice choice
check('prefers a natural female voice', pickVoice(V, 'en-US').name.includes('Aria'));
check('novelty voices are never offered', !voicesFor(V, 'en-US').some((v) => v.name === 'Bad News'));
check('male voices rank below female ones', voicesFor(V, 'en-US').findIndex((v) => v.name === 'Samantha') < voicesFor(V, 'en-US').findIndex((v) => v.name === 'Daniel'));
check('Spanish picks Paulina over Jorge', pickVoice(V, 'es-US').name === 'Paulina');
check('Vietnamese picks Linh', pickVoice(V, 'vi-VN').name === 'Linh');
check('a saved choice is honoured', pickVoice(V, 'en-US', 'Samantha').name === 'Samantha');
check('a saved choice that no longer exists falls back to the best', pickVoice(V, 'en-US', 'Gone').name.includes('Aria'));
check('no voices installed gives null, not a crash', pickVoice([], 'en-US') === null && pickVoice(undefined, 'en-US') === null);
check('a voice for another language scores -Infinity', scoreVoice({ name: 'Samantha', lang: 'en-US' }, 'es-US') === -Infinity);

// ---- echo detection
const said = ['Please tell me the specific medicine you need. It could be insulin, blood pressure meds, or an inhaler.'];
check('the photo: Lifeline\'s own sentence is an echo', isEcho('tell me the specific medicine you need it could be insulin blood pressure meds or an inhaler', said));
check('a slightly garbled echo is still an echo', isEcho('tell me the specific medicine you need could be insulin blood pressure or an inhaler', said));
check('"yes please" is never an echo', !isEcho('yes please', ['Do you want me to hold it? Yes or no?']));
check('a real answer that reuses a few words is not an echo', !isEcho('I need insulin and I have no car to get there', said));
check('"hold it and send a driver" is not an echo of the offer', !isEcho('yes please hold it and send a driver', ['King and McKee Pharmacy has insulin. I can hold it and send a driver. Do you want that?']));
check('an echo in Spanish (accents ignored) is caught', isEcho('que medicina necesita por ejemplo insulina o un inhalador', ['¿Qué medicina necesita? Por ejemplo, insulina o un inhalador.']));
check('no recent speech means nothing is an echo', !isEcho('this is a long sentence from a real person who is speaking', []));
check('words() ignores case, punctuation and accents', words('¡Hola, Señor!').join(' ') === 'hola senor');

console.log(out.join('\n'));
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${failed ? `${failed} FAILED` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
