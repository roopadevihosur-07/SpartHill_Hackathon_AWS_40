// Caller page flourishes: a live orb that mirrors the call state, quick-reply chips,
// bubble pop-ins, a confetti burst on the first confirmation, and button ripples.
// It only reads the page's state (dot class, status text, transcript, cards). It never changes the call logic.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const make = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

// 1) Setup title: letters rise in one by one (the accessible name stays the full sentence).
const title = $('setup-title');
if (title && !reduceMotion) {
  const text = title.textContent;
  title.setAttribute('aria-label', text);
  title.textContent = '';
  [...text].forEach((ch, i) => {
    const span = make('span', 'ch', ch === ' ' ? ' ' : ch);
    span.setAttribute('aria-hidden', 'true');
    span.style.setProperty('--i', String(i));
    title.append(span);
  });
}

// 2) Live orb inside the call: idle, listening, thinking or speaking.
const call = $('call');
const dot = $('dot');
const status = $('status-text');
const orb = make('div', 'orb-live');
orb.setAttribute('aria-hidden', 'true');
const core = make('span', 'core');
const bars = Array.from({ length: 7 }, () => make('i'));
const orbLabel = make('div', 'orb-label');
orb.append(core, ...bars, orbLabel);
call.prepend(orb);

const syncOrb = () => {
  const state = ['listening', 'thinking', 'speaking'].find((s) => dot.classList.contains(s)) ?? 'idle';
  orb.dataset.state = state;
  orbLabel.textContent = status.textContent;
};
new MutationObserver(syncOrb).observe(dot, { attributes: true, attributeFilter: ['class'] });
new MutationObserver(syncOrb).observe(status, { childList: true, characterData: true, subtree: true });
syncOrb();

// 3) Quick-reply chips: one tap sends a realistic first message.
const SAMPLES = [
  ['I need insulin', 'My insulin is getting warm, the power is out, and I have no car.'],
  ['Food for my family', 'I need food for a family of four. We have no car.'],
  ['Cooling center near me', 'Is there a cooling center open near me?'],
  ['Demo: chest pain', 'I have chest pain.'],
];
const form = $('textform');
const input = $('textinput');
const chipRow = make('div', 'chips');
chipRow.setAttribute('role', 'group');
chipRow.setAttribute('aria-label', 'Quick messages');
for (const [label, message] of SAMPLES) {
  const chip = make('button', 'chip', label);
  chip.type = 'button';
  chip.addEventListener('click', () => {
    input.value = message;
    form.requestSubmit();
    input.value = '';
  });
  chipRow.append(chip);
}
form.before(chipRow);

// 4) Chat bubbles pop in as they arrive.
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) if (node.nodeType === 1 && !reduceMotion) node.classList.add('pop');
  }
}).observe($('transcript'), { childList: true });

// 5) The first confirmation card bursts into confetti.
let burst = false;
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1 || burst || reduceMotion) continue;
      burst = true;
      const layer = make('div', 'burst');
      layer.setAttribute('aria-hidden', 'true');
      const colours = ['#ff9900', '#0972d3', '#1d8102', '#ec7211', '#d13212', '#ffd27a'];
      for (let i = 0; i < 26; i++) {
        const piece = make('i');
        piece.style.setProperty('--x', `${(Math.random() - 0.5) * 320}px`);
        piece.style.setProperty('--y', `${-80 - Math.random() * 180}px`);
        piece.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
        piece.style.setProperty('--d', `${Math.random() * 0.2}s`);
        piece.style.setProperty('--c', colours[i % colours.length]);
        layer.append(piece);
      }
      node.append(layer);
      setTimeout(() => layer.remove(), 2200);
    }
  }
}).observe($('cards'), { childList: true });

// 6) Button ripple on press.
document.addEventListener('pointerdown', (e) => {
  const button = e.target.closest?.('.btn');
  if (!button || reduceMotion) return;
  const rect = button.getBoundingClientRect();
  const ripple = make('span', 'ripple');
  ripple.style.setProperty('--x', `${e.clientX - rect.left}px`);
  ripple.style.setProperty('--y', `${e.clientY - rect.top}px`);
  button.append(ripple);
  setTimeout(() => ripple.remove(), 650);
});
