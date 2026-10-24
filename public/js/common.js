// Shared helpers. All dynamic text goes through textContent, never innerHTML.

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

export const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

export async function api(path, { method = 'GET', body, token, signal } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-admin-token'] = token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(json?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Server-sent events over fetch so a header (the admin token) can be sent. Reconnects with backoff.
 * Returns a function that closes the stream.
 */
export function connectSse(url, { token, onEvent, onStatus }) {
  let stopped = false;
  let controller;
  let attempt = 0;

  async function run() {
    while (!stopped) {
      controller = new AbortController();
      try {
        onStatus?.('connecting');
        const res = await fetch(url, { headers: token ? { 'x-admin-token': token } : {}, signal: controller.signal });
        if (res.status === 401) { onStatus?.('unauthorized'); return; }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        onStatus?.('live');
        attempt = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            const data = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            }
            if (data.length) {
              try { onEvent(event, JSON.parse(data.join('\n'))); } catch (e) { console.error('bad event', e); }
            }
          }
        }
      } catch (err) {
        if (stopped) return;
      }
      onStatus?.('reconnecting');
      await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** attempt++)));
    }
  }
  run();
  return () => { stopped = true; controller?.abort(); };
}

const TOKEN_KEY = 'lifeline.adminToken';
export const getToken = () => sessionStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (t) => sessionStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

/** Resolves once we hold a token the server accepts (or immediately if none is required). */
export async function ensureAdminAccess(mount, { title }) {
  for (;;) {
    try {
      await api('/api/admin/ping', { token: getToken() });
      return getToken();
    } catch (err) {
      if (err.status !== 401) throw err;
    }
    await new Promise((resolve) => {
      const input = el('input', { type: 'password', id: 'tok', autocomplete: 'off', 'aria-label': 'Admin token', required: true });
      const form = el('form', { class: 'gate', onsubmit: (e) => { e.preventDefault(); setToken(input.value.trim()); form.remove(); resolve(); } },
        el('h2', { text: title }),
        el('p', { text: 'Enter the admin token set in ADMIN_TOKEN.' }),
        input, el('button', { type: 'submit', class: 'btn primary', text: 'Unlock' }));
      mount.append(form);
      input.focus();
    });
  }
}

// ---------- motion helpers (shared by the console and the driver page) ----------
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Sets a node's text. If the text is a number that changed, it counts from the old value.
 * Non-numeric text is set as-is.
 */
export function setNumber(node, text) {
  const match = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(text);
  const prev = node.dataset.n;
  if (!match || prev === undefined || reduceMotion()) {
    node.textContent = text;
    if (match) node.dataset.n = match[1];
    return;
  }
  const target = Number(match[1]);
  const from = Number(prev);
  const suffix = match[2];
  const decimals = (match[1].split('.')[1] ?? '').length;
  if (from === target) { node.textContent = text; return; }
  node.dataset.n = match[1];
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / 650);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = `${(from + (target - from) * eased).toFixed(decimals)}${suffix}`;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** True when a key is new. Items seen on the first render do not animate in. */
export function isFresh(seen, key, animate) {
  const fresh = !seen.has(key);
  seen.add(key);
  return fresh && animate;
}

/** Restarts a CSS class animation on a node. */
export function flash(node, cls = 'tick') {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}
