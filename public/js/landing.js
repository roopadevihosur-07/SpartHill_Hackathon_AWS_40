// Landing page interactivity: architecture details, story walkthrough, use-case tabs.
// All text is set with textContent. The page has no inline script (CSP script-src 'self').

const ARCH = {
  caller: { title: 'Caller', body: 'Speaks or types. Gets a confirmation card and a text message.', related: ['agent'] },
  driver: { title: 'Volunteer driver', body: 'Sees the route and drop-offs. Re-routed when a site changes.', related: ['tools'] },
  coord: { title: 'Coordinator', body: 'Approves medicine holds, re-plans, and reads the log.', related: ['tools', 'safety'] },
  agent: { title: 'Agent loop', body: 'Bedrock picks the tools. Our code runs them and checks the results.', related: ['bedrock', 'tools', 'safety'] },
  safety: { title: 'Safety layer', body: 'Red flags go to 911 first. Replies are checked. Personal details are redacted.', related: ['guardrail', 'caller'] },
  tools: { title: 'Tools', body: 'Find sites, check stock, route, dispatch, hold, re-plan.', related: ['data', 'driver'] },
  data: { title: 'Live data', body: 'openFDA shortages and RxNorm names are live. Sites are simulated.', related: ['tools'] },
  bedrock: { title: 'Amazon Bedrock', body: 'Runs the model, Nova Pro in us-east-1.', related: ['agent', 'guardrail', 'cloudwatch'] },
  guardrail: { title: 'Bedrock Guardrail', body: 'Checks every model call. Blocks advice and prompt attacks.', related: ['bedrock', 'safety'] },
  cloudwatch: { title: 'CloudWatch', body: 'Decision log, metrics and the dashboard.', related: ['bedrock'] },
};

const STORY = [
  { title: 'A call from the kitchen', body: '"My insulin is warming up and I have no car." Lifeline answers.', flow: ['caller'] },
  { title: 'Triage first', body: 'No red flags. If she had said "chest pain", 911 guidance would play at once.', flow: ['caller', 'safety'] },
  { title: 'Find medicine', body: 'The agent checks the live shortage list and finds a pharmacy with power.', flow: ['bedrock', 'tools'] },
  { title: 'Human approval', body: 'The coordinator approves the medicine hold. Nothing is held before that.', flow: ['coord', 'tools'] },
  { title: 'Stock runs out', body: 'The site is marked out of stock. The new plan arrives in about 20 seconds.', flow: ['tools', 'driver', 'caller'] },
  { title: 'Confirmed', body: 'Confirmation card and text sent. The driver has the drop-off.', flow: ['caller', 'driver', 'coord'] },
];

const USE_CASES = {
  medicine: {
    title: 'Medicine in a power cut',
    body: 'Cold-chain medicine, and no car.',
    flow: ['Caller describes the need', 'Live shortage check', 'Site with power held', 'Coordinator approves', 'Driver confirmed'],
  },
  food: {
    title: 'Food and water',
    body: 'Nearby requests share one driver run.',
    flow: ['Household described', 'Stock found', 'Batched if the detour is small', 'Driver gets ordered stops'],
  },
  info: {
    title: 'Shelter and cooling',
    body: 'Answers come from the live site list, in the caller\'s language.',
    flow: ['Caller asks', 'Site list checked', 'Hours and address read back'],
  },
  safety: {
    title: 'Someone in danger',
    body: 'Red flags trigger 911 guidance at once.',
    flow: ['Red flag detected', '911 guidance spoken', 'Critical alert raised', 'Planning waits for coordinator'],
  },
  checkin: {
    title: 'Planned shutoff',
    body: 'The coordinator calls enrolled residents with the verified bulletin.',
    flow: ['Residents picked', 'Call placed', 'Bulletin read', 'Needs logged'],
  },
};

const $ = (sel) => document.querySelector(sel);

// Motion state. Declared up here because the first story render below reads it.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let autoOn = !reduceMotion;
let storyPaused = false;

// ---------- architecture ----------
const detailTitle = $('#detail-title');
const detailBody = $('#detail-body');
const nodes = [...document.querySelectorAll('[data-node]')];

function selectNode(key) {
  const info = ARCH[key];
  if (!info) return;
  nodes.forEach((btn) => {
    const on = btn.dataset.node === key;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-related', !on && info.related.includes(btn.dataset.node));
  });
  detailTitle.textContent = info.title;
  detailBody.textContent = info.body;
  detailBody.classList.remove('muted');
  swapIn(detailTitle);
  swapIn(detailBody);
}

nodes.forEach((btn) => {
  btn.addEventListener('click', () => selectNode(btn.dataset.node));
});

// ---------- story ----------
const storyButtons = [...document.querySelectorAll('.story-btn')];
const storyTitle = $('#story-title-step');
const storyBody = $('#story-body');
const storyCount = $('#story-count');
const storyPrev = $('#story-prev');
const storyNext = $('#story-next');
const flowNodes = [...document.querySelectorAll('.flow-node')];
let storyIndex = 0;

function showStory(index) {
  storyIndex = Math.max(0, Math.min(STORY.length - 1, index));
  const step = STORY[storyIndex];
  storyTitle.textContent = step.title;
  storyBody.textContent = step.body;
  storyCount.textContent = `Step ${storyIndex + 1} of ${STORY.length}`;
  storyButtons.forEach((btn, i) => btn.setAttribute('aria-selected', i === storyIndex ? 'true' : 'false'));
  flowNodes.forEach((node) => {
    const on = step.flow.includes(node.dataset.flow);
    node.classList.toggle('on', on);
    node.classList.toggle('dim', !on);
  });
  storyPrev.disabled = storyIndex === 0;
  storyNext.disabled = storyIndex === STORY.length - 1;
  restartProgress();
  swapIn(storyTitle);
  swapIn(storyBody);
}

storyButtons.forEach((btn) => btn.addEventListener('click', () => showStory(Number(btn.dataset.step))));
storyPrev.addEventListener('click', () => showStory(storyIndex - 1));
storyNext.addEventListener('click', () => showStory(storyIndex + 1));

// Arrow keys move through the story when a story button has focus.
$('.story-steps').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { e.preventDefault(); showStory(storyIndex + 1); storyButtons[storyIndex].focus(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); showStory(storyIndex - 1); storyButtons[storyIndex].focus(); }
});

// ---------- use cases ----------
const ucButtons = [...document.querySelectorAll('.uc-btn')];
const ucTitle = $('#uc-title-text');
const ucBody = $('#uc-body');
const ucFlow = $('#uc-flow');

function showUseCase(key) {
  const uc = USE_CASES[key];
  if (!uc) return;
  ucButtons.forEach((btn) => btn.setAttribute('aria-selected', btn.dataset.uc === key ? 'true' : 'false'));
  ucTitle.textContent = uc.title;
  ucBody.textContent = uc.body;
  swapIn(ucTitle);
  swapIn(ucBody);
  ucFlow.replaceChildren(...uc.flow.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
}

ucButtons.forEach((btn) => btn.addEventListener('click', () => showUseCase(btn.dataset.uc)));

// Initial state
showStory(0);
showUseCase('medicine');

// =====================================================================
// Motion. Skipped entirely when the visitor prefers reduced motion.
// =====================================================================
// Story progress bar: fills over the auto-advance interval.
const STORY_INTERVAL = 5000;
function restartProgress() {
  const bar = document.querySelector('.story-progress span');
  if (!bar || reduceMotion) return;
  bar.classList.remove('run');
  void bar.offsetWidth; // restart the CSS transition
  if (autoOn && !storyPaused) bar.classList.add('run');
}

// Auto-advance the story until the visitor takes control of it.
const storyEl = $('#story');
storyEl.addEventListener('pointerenter', () => { storyPaused = true; document.querySelector('.story-progress span')?.classList.remove('run'); });
storyEl.addEventListener('pointerleave', () => { storyPaused = false; restartProgress(); });
storyEl.addEventListener('pointerdown', () => { autoOn = false; });
storyEl.addEventListener('keydown', () => { autoOn = false; });
setInterval(() => {
  if (!autoOn || storyPaused || document.hidden) return;
  showStory(storyIndex + 1 >= STORY.length ? 0 : storyIndex + 1);
}, STORY_INTERVAL);

// Architecture pipeline: a highlight travels through the request steps.
const pipelineSteps = [...document.querySelectorAll('.pipeline .step')];
let pipeIndex = 0;
if (!reduceMotion && pipelineSteps.length) {
  pipelineSteps[0].classList.add('active');
  setInterval(() => {
    if (document.hidden) return;
    pipelineSteps[pipeIndex].classList.remove('active');
    pipeIndex = (pipeIndex + 1) % pipelineSteps.length;
    pipelineSteps[pipeIndex].classList.add('active');
  }, 900);
}

// Hero spotlight follows the pointer.
const hero = $('#hero');
if (!reduceMotion) {
  hero.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    hero.style.setProperty('--mx', `${e.clientX - r.left}px`);
    hero.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
}

// Use-case steps cascade in: each item gets an index for its delay.
if (!reduceMotion) {
  const observeUc = new MutationObserver(() => {
    [...ucFlow.children].forEach((li, i) => li.style.setProperty('--i', i));
  });
  observeUc.observe(ucFlow, { childList: true });
}

// Scroll reveal and count-up numbers.
if (!reduceMotion) {
  document.documentElement.classList.add('js');

  const revealTargets = [
    '.section > h2', '.section > .section-lead', '.section > .note',
    '.card-tile', '.arch', '.detail', '.pipeline', '.table-wrap',
    '.story', '.uc-tabs', '.uc-panel', '.closing h2', '.closing p', '.closing .cta-row',
    '.compare > .side', '.arch-col', '.aws-table tbody tr', '.pipeline .step', '.story-steps li', '.story-controls',
    '.story-progress', '.uc-btn', '.foot', '.section.alt > .uc-panel', '.stats-note',
  ];
  const revealEls = [...document.querySelectorAll(revealTargets.join(','))];
  // Stagger siblings so grids of tiles, rows and steps arrive one after another.
  revealEls.forEach((node) => {
    node.classList.add('reveal');
    const siblings = node.parentElement ? [...node.parentElement.children] : [];
    const idx = siblings.indexOf(node);
    if (idx > 0) node.style.setProperty('--d', `${Math.min(idx, 6) * 0.09}s`);
  });

  const countUp = (el) => {
    const target = Number(el.dataset.count);
    const suffix = el.dataset.suffix ?? '';
    const duration = 1400;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = `${Math.round(target * eased)}${suffix}`;
      if (t < 1) requestAnimationFrame(tick);
    };
    el.textContent = `0${suffix}`;
    requestAnimationFrame(tick);
  };

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      entry.target.querySelectorAll?.('[data-count]').forEach(countUp);
      if (entry.target.matches('[data-count]')) countUp(entry.target);
      io.unobserve(entry.target);
    }
  }, { threshold: 0.15 });

  revealEls.forEach((el) => io.observe(el));
  document.querySelectorAll('.stats').forEach((el) => io.observe(el));
}

// Re-run a CSS entrance animation on an element whose text just changed.
function swapIn(el) {
  if (!el || reduceMotion) return;
  el.classList.remove('swap');
  void el.offsetWidth; // restart the animation
  el.classList.add('swap');
}

// Scroll progress bar across the top, and a tighter nav once the page scrolls.
if (!reduceMotion) {
  const scrollBar = document.createElement('div');
  scrollBar.className = 'scroll-bar';
  scrollBar.setAttribute('aria-hidden', 'true');
  document.body.append(scrollBar);
  const nav = document.querySelector('.nav');
  const onScroll = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    scrollBar.style.setProperty('--p', max > 0 ? String(window.scrollY / max) : '0');
    nav.classList.toggle('scrolled', window.scrollY > 24);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// ---------- how the flow works ----------
const FLOW_ACTORS = ['Caller', 'Safety', 'Bedrock', 'Tools', 'Coordinator', 'Driver'];
const FLOW = [
  { title: 'Speak', body: 'The caller speaks or types in the browser. No app to install.', who: ['Caller'],
    points: ['Voice uses the browser microphone', 'The text box works the same way', 'Any language the caller chooses'] },
  { title: 'Safety check', body: 'Red flags are checked before the model runs.', who: ['Caller', 'Safety'],
    points: ['Chest pain or breathing trouble gets 911 guidance, spoken from code', 'Personal details are redacted before storage', 'Critical cases alert the coordinator'] },
  { title: 'Understand and plan', body: 'Amazon Bedrock reads the request and chooses which tools to call.', who: ['Bedrock', 'Safety'],
    points: ['Converse API with tool use', 'Bedrock Guardrail screens every model call', 'Facts come only from tool results'] },
  { title: 'Find and hold', body: 'Tools search live sites and stock, then hold the medicine.', who: ['Tools', 'Bedrock'],
    points: ['openFDA shortage list and RxNorm names are live', 'Nearest site with power and stock', 'Medicine held for the caller'] },
  { title: 'Approve and dispatch', body: 'A coordinator approves risky steps. A driver is assigned.', who: ['Coordinator', 'Driver'],
    points: ['Medicine holds need a coordinator approval', 'The driver accepts; nearby stops are batched', 'The caller gets a confirmation card'] },
  { title: 'Confirm and re-plan', body: 'If stock runs out, the plan changes and everyone sees it.', who: ['Tools', 'Driver', 'Caller'],
    points: ['Re-plan in about 20 seconds', 'Driver re-routed live on the map', 'Every decision is logged'] },
];
const FLOW_STEP_MS = 4000;

const flowBlocks = [...document.querySelectorAll('.flow-block')];
const flowPacket = document.getElementById('flow-packet');
const flowFill = document.getElementById('flow-fill');
const flowWho = $('#flow-who');
const flowTitle = $('#flow-detail-title');
const flowBody = $('#flow-detail-body');
const flowPoints = $('#flow-points');
const flowPlay = $('#flow-play');
let flowIndex = 0;
let flowTimer = null;

function showFlow(i) {
  const n = FLOW.length;
  flowIndex = (i + n) % n;
  const step = FLOW[flowIndex];
  flowBlocks.forEach((b, k) => b.setAttribute('aria-pressed', k === flowIndex ? 'true' : 'false'));
  // The rail runs from the centre of block 1 to the centre of block 6, so block i sits at i / (n - 1).
  const along = flowIndex / (n - 1);
  flowPacket.style.setProperty('--x', `${along * 100}%`);
  flowFill.style.setProperty('--p', String(along));
  flowWho.replaceChildren(...FLOW_ACTORS.map((name) => {
    const chip = document.createElement('span');
    chip.textContent = name;
    if (step.who.includes(name)) chip.classList.add('on');
    return chip;
  }));
  flowTitle.textContent = step.title;
  flowBody.textContent = step.body;
  flowPoints.replaceChildren(...step.points.map((text, k) => {
    const li = document.createElement('li');
    li.textContent = text;
    li.style.setProperty('--i', String(k));
    return li;
  }));
  swapIn(flowTitle);
  swapIn(flowBody);
}

function startFlow() {
  stopFlow();
  flowTimer = setInterval(() => { if (!document.hidden) showFlow(flowIndex + 1); }, FLOW_STEP_MS);
  flowPlay.textContent = 'Pause';
}

function stopFlow() {
  clearInterval(flowTimer);
  flowTimer = null;
  flowPlay.textContent = 'Play';
}

flowBlocks.forEach((b) => b.addEventListener('click', () => { stopFlow(); showFlow(Number(b.dataset.flowStep)); }));
$('#flow-prev').addEventListener('click', () => { stopFlow(); showFlow(flowIndex - 1); });
$('#flow-next').addEventListener('click', () => { stopFlow(); showFlow(flowIndex + 1); });
flowPlay.addEventListener('click', () => (flowTimer ? stopFlow() : startFlow()));

showFlow(0);
if (reduceMotion) stopFlow(); else startFlow();

// ---------- section-to-section transitions ----------
if (!reduceMotion) {
  // One 1440px wave repeated twice, so the sliding animation loops without a seam.
  const WAVE_D = 'M0,40 C240,80 480,0 720,40 C960,80 1200,0 1440,40 C1680,80 1920,0 2160,40 C2400,80 2640,0 2880,40 L2880,80 L0,80 Z';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const sections = [...document.querySelectorAll('main > section')];

  // Every section except the hero gets a wave on top, filled with its own colour.
  sections.slice(1).forEach((section) => {
    let fill = getComputedStyle(section).backgroundColor;
    if (!fill || fill === 'rgba(0, 0, 0, 0)') fill = '#ffffff';
    if (section.classList.contains('closing')) fill = '#161e2d'; // gradient band, so use its first colour

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', WAVE_D);
    path.setAttribute('fill', fill);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 2880 80');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.append(path);
    const wrap = document.createElement('div');
    wrap.className = 'sec-wave';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.append(svg);
    section.prepend(wrap);
    section.classList.add('enter');
  });

  // Fade and rise each section in once it is on screen.
  const sectionIO = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      sectionIO.unobserve(entry.target);
    }
  }, { threshold: 0.08 });
  sections.slice(1).forEach((section) => sectionIO.observe(section));
}

// ---------- architecture flow ----------
// Each connector goes from one box side to another. Offsets (0-1) place it along that side,
// so two-way links sit side by side instead of on top of each other.
const AB_TYPES = { req: '#ff9900', ctl: '#0972d3', data: '#1d8102', log: '#879596', alert: '#d13212' };
const AB_CONNECTORS = [
  { id: 'c1', from: 'caller', fs: 'r', fo: 0.35, to: 'safety', ts: 'l', to_o: 0.35, type: 'req', step: 1 },
  { id: 'c2', from: 'safety', fs: 'b', fo: 0.3, to: 'agent', ts: 't', to_o: 0.3, type: 'req', step: 2 },
  { id: 'c3', from: 'agent', fs: 'r', fo: 0.3, to: 'bedrock', ts: 'l', to_o: 0.3, type: 'req', step: 3 },
  { id: 'c4', from: 'bedrock', fs: 't', fo: 0.5, to: 'guardrail', ts: 'b', to_o: 0.5, type: 'ctl', step: 4 },
  { id: 'c5', from: 'bedrock', fs: 'l', fo: 0.7, to: 'agent', ts: 'r', to_o: 0.7, type: 'req', step: 5 },
  { id: 'c6', from: 'agent', fs: 'b', fo: 0.5, to: 'tools', ts: 't', to_o: 0.5, type: 'req', step: 6 },
  { id: 'c7', from: 'tools', fs: 'r', fo: 0.3, to: 'data', ts: 'l', to_o: 0.3, type: 'data', step: 7 },
  { id: 'c8', from: 'data', fs: 'l', fo: 0.7, to: 'tools', ts: 'r', to_o: 0.7, type: 'data', step: null },
  { id: 'c9', from: 'tools', fs: 'l', fo: 0.25, to: 'coord', ts: 'r', to_o: 0.25, type: 'ctl', step: 8 },
  { id: 'c10', from: 'coord', fs: 'r', fo: 0.75, to: 'tools', ts: 'l', to_o: 0.75, type: 'ctl', step: 9 },
  { id: 'c11', from: 'tools', fs: 'l', fo: 0.5, to: 'driver', ts: 'r', to_o: 0.5, type: 'req', step: 10 },
  { id: 'c12', from: 'tools', fs: 'b', fo: 0.5, to: 'cloudwatch', ts: 'l', to_o: 0.5, type: 'log', step: 11 },
  { id: 'c13', from: 'agent', fs: 't', fo: 0.7, to: 'safety', ts: 'b', to_o: 0.7, type: 'req', step: 12 },
  { id: 'c14', from: 'safety', fs: 'l', fo: 0.7, to: 'caller', ts: 'r', to_o: 0.7, type: 'req', step: 13 },
  { id: 'c15', from: 'safety', fs: 'l', fo: 0.92, to: 'coord', ts: 't', to_o: 0.5, type: 'alert', step: null },
];
const AB_SEQ = AB_CONNECTORS.map((c) => c.id);
const AB_STEP_MS = 1400;

const abBoard = document.getElementById('ab-board');
const abSvg = document.getElementById('ab-svg');
const abPaths = document.getElementById('ab-paths');
const abBadges = document.getElementById('ab-badges');
const abPacket = document.getElementById('ab-packet');
const abSteps = [...document.querySelectorAll('.ab-steps li[data-conn]')];
const abNodes = new Map([...document.querySelectorAll('.ab-board [data-node]')].map((n) => [n.dataset.node, n]));
const SVG_NS = 'http://www.w3.org/2000/svg';
let abIndex = 0;
let abStart = 0;

// Outward direction is kept per side so each curve leaves a box straight out of its edge.
const SIDE_DIR = { r: [1, 0], l: [-1, 0], t: [0, -1], b: [0, 1] };

function abAnchor(node, side, off, boardRect) {
  const r = node.getBoundingClientRect();
  const x = r.left - boardRect.left;
  const y = r.top - boardRect.top;
  const [dx, dy] = SIDE_DIR[side];
  let px = x;
  let py = y;
  if (side === 'r') { px = x + r.width; py = y + r.height * off; }
  else if (side === 'l') { py = y + r.height * off; }
  else if (side === 't') { px = x + r.width * off; }
  else { px = x + r.width * off; py = y + r.height; }
  return { x: px, y: py, dx, dy };
}

function abCurve(a, b) {
  const k = Math.max(30, Math.hypot(b.x - a.x, b.y - a.y) * 0.4);
  return `M${a.x},${a.y} C${a.x + a.dx * k},${a.y + a.dy * k} ${b.x + b.dx * k},${b.y + b.dy * k} ${b.x},${b.y}`;
}

// Create the SVG paths and step badges once. Positions are set by drawAB().
for (const c of AB_CONNECTORS) {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', `ab-path ${c.type}`);
  path.setAttribute('stroke', AB_TYPES[c.type]);
  path.setAttribute('marker-end', `url(#ab-m-${c.type})`);
  path.setAttribute('id', `ab-${c.id}`);
  abPaths.append(path);
  c.el = path;
  const badge = document.createElementNS(SVG_NS, 'g');
  badge.setAttribute('class', 'ab-badge');
  badge.setAttribute('aria-hidden', 'true');
  const disc = document.createElementNS(SVG_NS, 'circle');
  disc.setAttribute('r', '11');
  disc.setAttribute('fill', AB_TYPES[c.type]);
  const label = document.createElementNS(SVG_NS, 'text');
  label.textContent = String(c.step ?? '');
  badge.append(disc, label);
  badge.style.display = c.step ? '' : 'none';
  abBadges.append(badge);
  c.badge = badge;
}

function drawAB() {
  if (!abBoard || abBoard.clientWidth === 0) return;
  const boardRect = abBoard.getBoundingClientRect();
  abSvg.setAttribute('viewBox', `0 0 ${abBoard.clientWidth} ${abBoard.clientHeight}`);
  for (const c of AB_CONNECTORS) {
    const fromNode = abNodes.get(c.from);
    const toNode = abNodes.get(c.to);
    if (!fromNode || !toNode) continue;
    const a = abAnchor(fromNode, c.fs, c.fo, boardRect);
    const b = abAnchor(toNode, c.ts, c.to_o, boardRect);
    c.el.setAttribute('d', abCurve(a, b));
    c.len = c.el.getTotalLength();
    const mid = c.el.getPointAtLength(c.len / 2);
    c.badge.setAttribute('transform', `translate(${mid.x}, ${mid.y})`);
  }
}

function activateAB(i) {
  abIndex = (i + AB_SEQ.length) % AB_SEQ.length;
  abStart = performance.now();
  const conn = AB_CONNECTORS.find((c) => c.id === AB_SEQ[abIndex]);
  for (const c of AB_CONNECTORS) c.el.classList.toggle('live', c === conn);
  for (const [name, node] of abNodes) node.classList.toggle('hot', name === conn.from || name === conn.to);
  for (const li of abSteps) li.classList.toggle('live', li.dataset.conn === conn.id);
  abPacket.setAttribute('fill', AB_TYPES[conn.type]);
}

function abFrame(now) {
  const conn = AB_CONNECTORS.find((c) => c.id === AB_SEQ[abIndex]);
  const t = (now - abStart) / AB_STEP_MS;
  if (t >= 1) { activateAB(abIndex + 1); requestAnimationFrame(abFrame); return; }
  // Ease in and out so the packet slows at each joint.
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const p = conn.el.getPointAtLength(conn.len * e);
  abPacket.setAttribute('cx', p.x);
  abPacket.setAttribute('cy', p.y);
  requestAnimationFrame(abFrame);
}

if (abBoard) {
  drawAB();
  new ResizeObserver(drawAB).observe(abBoard);
  window.addEventListener('load', drawAB);
  abSteps.forEach((li) => li.addEventListener('click', () => {
    const i = AB_SEQ.indexOf(li.dataset.conn);
    activateAB(i);
    if (reduceMotion) return;
  }));
  activateAB(0);
  if (!reduceMotion) requestAnimationFrame(abFrame);
  else abPacket.style.display = 'none';
}
