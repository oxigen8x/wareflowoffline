// Cambia il numero per forzare il rinnovo completo della cache
const V = 'wareflow-offline-v13';
const SHELL = ['./', 'index.html', 'localapi.js', 'sql-wasm.js', 'sql-wasm.wasm', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => e.waitUntil(
  caches.open(V).then(c => Promise.all(SHELL.map(u => fetch(new Request(u, { cache: 'reload' })).then(r => { if (!r.ok) throw new Error(u); return c.put(u, r); }))))
    .then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => !k.startsWith(V)).map(k => caches.delete(k)))).then(() => self.clients.claim())));
// App: prima la rete (timeout 4s) così i file nuovi arrivano sempre insieme; senza rete usa la copia salvata
const conTimeout = (p, ms) => Promise.race([p, new Promise((_, ko) => setTimeout(() => ko(new Error('timeout')), ms))]);
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === location.origin) {
    e.respondWith(conTimeout(fetch(r, { cache: 'no-cache' }), 4000).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); }
      return res;
    }).catch(() => caches.match(r, { ignoreSearch: true }).then(hit => hit || Response.error())));
  } else if (/(^|\.)(googleapis|gstatic)\.com$/.test(u.hostname)) {   // font: li salva alla prima apertura online
    e.respondWith(caches.open(V + '-fonts').then(async c => {
      const hit = await c.match(r);
      const net = fetch(r).then(res => { c.put(r, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
