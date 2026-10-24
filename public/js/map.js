// Coordinator live map. Uses Leaflet (window.L, loaded by console.html) with
// OpenStreetMap tiles. Driver movement is a display simulation, not GPS.
// All text is set with textContent.

const LOOP_MS = 16000; // one simulated trip along a route
const ROUTE_COLOR = { assigned: '#0972d3', accepted: '#1d8102', rerouting: '#ec7211' };
const ACTIVE = ['assigned', 'accepted', 'rerouting'];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const tip = (text) => {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
};

// Cumulative lengths along a polyline, so a marker can move at constant speed.
function measure(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const cosLat = Math.cos((a[0] * Math.PI) / 180);
    const dx = (b[1] - a[1]) * cosLat;
    const dy = b[0] - a[0];
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return cum;
}

function pointAt(points, cum, fraction) {
  const target = fraction * cum.at(-1);
  for (let i = 1; i < points.length; i++) {
    if (target <= cum[i]) {
      const seg = cum[i] - cum[i - 1] || 1;
      const t = (target - cum[i - 1]) / seg;
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
    }
  }
  return points.at(-1);
}

export function createLiveMap(container) {
  const L = window.L;
  if (!L) {
    container.textContent = 'The map could not load. The rest of the console still works.';
    return { update() {} };
  }

  const map = L.map(container, { scrollWheelZoom: false }).setView([37.352, -121.826], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const layer = L.layerGroup().addTo(map);
  let moving = []; // { marker, points, cum, offset }
  let fitted = false;
  let frame = null;

  const pin = (cls) => L.divIcon({ className: '', html: `<span class="pin ${cls}"></span>`, iconSize: null });

  function step(now) {
    for (const m of moving) {
      const fraction = ((now / LOOP_MS) + m.offset) % 1;
      m.marker.setLatLng(pointAt(m.points, m.cum, fraction));
    }
    frame = moving.length ? requestAnimationFrame(step) : null;
  }

  function update(snap) {
    layer.clearLayers();
    moving = [];

    for (const s of snap.sites ?? []) {
      const empty = !s.open || !Object.values(s.inventory ?? {}).some((v) => v > 0);
      const cls = empty ? 'empty' : `k-${s.kind}`;
      L.marker([s.lat, s.lng], { icon: pin(cls) }).bindTooltip(tip(s.name)).addTo(layer);
    }

    const activeDrivers = new Set();
    const routes = (snap.dispatches ?? []).filter((d) => ACTIVE.includes(d.status) && d.map?.driver && d.map?.pickup && d.map?.dropoff);
    routes.forEach((d, i) => {
      const { driver, pickup, dropoff } = d.map;
      const points = [[driver.lat, driver.lng], [pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]];
      activeDrivers.add(d.driver?.id);
      L.polyline(points, { color: ROUTE_COLOR[d.status] ?? '#0972d3', weight: 4, opacity: 0.85, dashArray: '8 8' }).addTo(layer);

      const who = `${d.driver?.name ?? 'Driver'} · ${d.status}${d.etaMin ? ` · about ${d.etaMin} min` : ''}`;
      const marker = L.marker(points[0], { icon: pin('driver'), zIndexOffset: 500 }).bindTooltip(tip(who)).addTo(layer);
      moving.push({ marker, points, cum: measure(points), offset: (i * 0.37) % 1 });
    });

    for (const d of routes) {
      const c = d.map.dropoff;
      L.marker([c.lat, c.lng], { icon: pin('caller'), zIndexOffset: 400 }).bindTooltip(tip(`Caller area: ${c.label} (approximate)`)).addTo(layer);
    }

    for (const dr of snap.drivers ?? []) {
      if (activeDrivers.has(dr.id) || dr.lat == null) continue;
      L.marker([dr.lat, dr.lng], { icon: pin('base') }).bindTooltip(tip(`${dr.name} · base`)).addTo(layer);
    }

    if (!fitted && snap.sites?.length) {
      const pts = [...snap.sites, ...(snap.drivers ?? []).filter((d) => d.lat != null)].map((p) => [p.lat, p.lng]);
      map.fitBounds(pts, { padding: [24, 24], maxZoom: 14 });
      fitted = true;
    }

    if (moving.length && !reduceMotion) {
      if (!frame) frame = requestAnimationFrame(step);
    } else {
      for (const m of moving) m.marker.setLatLng(m.points[0]);
    }
  }

  return { update };
}
