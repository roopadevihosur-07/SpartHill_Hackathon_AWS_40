import { el, clear, api, connectSse, ensureAdminAccess } from './common.js';

const $ = (id) => document.getElementById(id);
let token = '';
let driverId = '';
let stop = null;

async function act(button, dispatchId, action) {
  button.disabled = true;
  try {
    await api(`/api/driver/${driverId}/dispatch/${dispatchId}/${action}`, { method: 'POST', token });
  } catch (err) {
    alert(`That did not work: ${err.message}`);
    button.disabled = false;
  }
}

function render(jobs) {
  const root = clear($('jobs'));
  const visible = jobs.filter((j) => j.status !== 'declined');
  if (!visible.length) { root.append(el('div', { class: 'card muted', text: 'No jobs right now. New dispatches appear here by themselves.' })); return; }
  for (const j of [...visible].reverse()) {
    const open = ['assigned', 'accepted'].includes(j.status);
    const accept = el('button', { class: 'btn good', type: 'button', text: 'Accept' });
    const decline = el('button', { class: 'btn', type: 'button', text: 'Decline' });
    const done = el('button', { class: 'btn primary', type: 'button', text: 'Mark delivered' });
    accept.addEventListener('click', () => act(accept, j.id, 'accept'));
    decline.addEventListener('click', () => act(decline, j.id, 'decline'));
    done.addEventListener('click', () => act(done, j.id, 'delivered'));
    root.append(el('div', { class: `card dcard ${j.status}`, role: 'group', 'aria-label': `Dispatch ${j.id}` },
      el('h2', { text: `${j.id} · ${j.status === 'rerouting' ? 'Route is being updated' : j.status}` }),
      j.urgency === 'critical' ? el('p', {}, el('span', { class: 'badge off', text: 'CRITICAL: refrigerated medicine' })) : null,
      j.etaMin ? el('p', {}, el('b', { text: `About ${j.etaMin} min` }), ` · ${j.distanceKm} km${j.batched ? ' · batched with other stops' : ''}`) : null,
      el('ol', { class: 'route' }, j.route.map((s) => el('li', { class: s.type }, el('b', { text: s.label }), s.address ? el('div', { class: 'small muted', text: s.address }) : null))),
      j.error ? el('p', { class: 'small', text: j.error }) : null,
      open ? el('div', { class: 'controls' }, j.status === 'assigned' ? accept : null, j.status === 'assigned' ? decline : null, j.status === 'accepted' ? done : null) : null));
  }
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
  $('who').addEventListener('change', () => { driverId = $('who').value; clear($('jobs')); watch(); });
  watch();
}

boot().catch((e) => { document.body.prepend(el('p', { text: `Driver page failed to load: ${e.message}` })); });
