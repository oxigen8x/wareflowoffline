// Cambia il numero per forzare il rinnovo completo della cache
const V = 'wareflow-offline-v3';
const SHELL = ['./', 'index.html', 'localapi.js', 'sql-wasm.js', 'sql-wasm.wasm', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => !k.startsWith(V)).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === location.origin) {            // app: cache subito, aggiorna in background
    const net = fetch(r).then(res => { if (res.ok) caches.open(V).then(c => c.put(r, res.clone())); return res; }).catch(() => null);
    e.respondWith(caches.match(r, { ignoreSearch: true }).then(hit => hit || net));
    e.waitUntil(net);
  } else if (/(^|\.)(googleapis|gstatic)\.com$/.test(u.hostname)) {   // font: li salva alla prima apertura online
    e.respondWith(caches.open(V + '-fonts').then(async c => {
      const hit = await c.match(r);
      const net = fetch(r).then(res => { c.put(r, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
