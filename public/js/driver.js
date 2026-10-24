import { el, clear, api, connectSse, ensureAdminAccess, setNumber, isFresh } from './common.js';

const $ = (id) => document.getElementById(id);
let token = '';
let driverId = '';
let stop = null;
let firstRender = true;
const seen = new Set();
const animate = () => !firstRender;
const OPEN = ['assigned', 'accepted', 'rerouting'];
const STAGES = ['Assigned', 'Accepted', 'Delivered'];
const stageOf = (status) => ({ assigned: 0, rerouting: 1, accepted: 1, delivered: 2 }[status] ?? -1);

async function act(button, dispatchId, action) {
  button.disabled = true;
  button.classList.add('pressed');
  setTimeout(() => button.classList.remove('pressed'), 320);
  try {
    await api(`/api/driver/${driverId}/dispatch/${dispatchId}/${action}`, { method: 'POST', token });
  } catch (err) {
    alert(`That did not work: ${err.message}`);
    button.disabled = false;
  }
}

let toastRoot = null;
function toast(text) {
  if (!toastRoot) {
    toastRoot = el('div', { class: 'toasts', role: 'status' });
    document.body.append(toastRoot);
  }
  const node = el('div', { class: 'toast' }, text);
  toastRoot.append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 400);
  }, 3600);
}

function updateStats(visible) {
  const open = visible.filter((j) => OPEN.includes(j.status));
  const etas = open.map((j) => j.etaMin).filter(Boolean);
  setNumber($('ds-active'), String(open.length));
  setNumber($('ds-next'), etas.length ? String(Math.min(...etas)) : '–');
  setNumber($('ds-done'), String(visible.filter((j) => j.status === 'delivered').length));
}

function radarEmpty() {
  return el('div', { class: 'card radar-card' },
    el('div', { class: 'radar', 'aria-hidden': 'true' }, el('span'), el('span'), el('span')),
    el('p', { class: 'radar-text', text: 'Waiting for dispatches. New jobs appear here by themselves.' }));
}

function jobCard(j) {
  const open = ['assigned', 'accepted'].includes(j.status);
  const accept = el('button', { class: 'btn good', type: 'button', text: 'Accept' });
  const decline = el('button', { class: 'btn', type: 'button', text: 'Decline' });
  const done = el('button', { class: 'btn primary', type: 'button', text: 'Mark delivered' });
  accept.addEventListener('click', () => act(accept, j.id, 'accept'));
  decline.addEventListener('click', () => act(decline, j.id, 'decline'));
  done.addEventListener('click', () => act(done, j.id, 'delivered'));

  const stage = stageOf(j.status);
  const stepper = el('ol', { class: 'stepper', 'aria-label': `Status: ${j.status}` },
    STAGES.map((label, i) => el('li', { class: i < stage ? 'done' : i === stage ? 'now' : '' }, el('span', { class: 'dot' }), label)));
  // While the job is open, the pickup is the next stop, so it pulses.
  const route = el('ol', { class: 'route' }, j.route.map((s, i) =>
    el('li', { class: `${s.type}${open && OPEN.includes(j.status) && i === 1 ? ' next' : ''}` },
      el('b', { text: s.label }),
      s.address ? el('div', { class: 'small muted', text: s.address }) : null)));

  return el('div', { class: `card dcard ${j.status}`, role: 'group', 'aria-label': `Dispatch ${j.id}` },
    el('div', { class: 'dc-top' },
      el('h2', { text: j.id }),
      el('span', { class: `dc-badge ${j.status}`, text: j.status === 'rerouting' ? 'Route updating' : j.status })),
    j.urgency === 'critical' ? el('p', {}, el('span', { class: 'badge off', text: 'CRITICAL: refrigerated medicine' })) : null,
    stepper,
    j.etaMin ? el('p', { class: 'eta' }, el('b', { text: `About ${j.etaMin} min` }), ` · ${j.distanceKm} km${j.batched ? ' · batched with other stops' : ''}`) : null,
    route,
    j.error ? el('p', { class: 'small', text: j.error }) : null,
    open ? el('div', { class: 'controls' }, j.status === 'assigned' ? accept : null, j.status === 'assigned' ? decline : null, j.status === 'accepted' ? done : null) : null);
}

function render(jobs) {
  const root = clear($('jobs'));
  const visible = jobs.filter((j) => j.status !== 'declined');
  updateStats(visible);
  if (!visible.length) {
    root.append(radarEmpty());
    firstRender = false;
    return;
  }
  for (const j of [...visible].reverse()) {
    const node = jobCard(j);
    if (isFresh(seen, j.id, animate())) {
      node.classList.add('fresh');
      toast(`New job ${j.id}${j.urgency === 'critical' ? ' · critical' : ''}`);
    }
    root.append(node);
  }
  firstRender = false;
}

function watch() {
  stop?.();
  stop = connectSse(`/api/driver/${encodeURIComponent(driverId)}/stream`, {
    token,
    onEvent: (event, data) => { if (event === 'dispatches') render(data); },
    onStatus: (s) => { $('conn').textContent = s === 'live' ? 'Connected. Jobs update live.' : `Connection: ${s}`; },
  });
}

async function boot() {
  token = await ensureAdminAccess($('gate-mount'), { title: 'Volunteer driver' });
  $('app').classList.remove('hidden');
  const drivers = await api('/api/driver/list', { token });
  for (const d of drivers) $('who').append(el('option', { value: d.id, text: `${d.name} (${d.vehicle})` }));
  const saved = new URLSearchParams(location.search).get('driver');
  if (saved && drivers.some((d) => d.id === saved)) $('who').value = saved;
  driverId = $('who').value;
  $('who').addEventListener('change', () => {
    driverId = $('who').value;
    clear($('jobs'));
    seen.clear();
    firstRender = true;
    watch();
  });
  watch();
}

boot().catch((e) => { document.body.prepend(el('p', { text: `Driver page failed to load: ${e.message}` })); });
