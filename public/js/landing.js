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
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
let autoOn = !reduceMotion;
let storyPaused = false;
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
