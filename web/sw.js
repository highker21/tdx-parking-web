// 只快取靜態檔（頁面、icon、Leaflet）。TDX／轉送回應、token、地圖圖磚一律不進快取。
const CACHE = 'pk-static-2026-11-04w';
const STATIC = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys()
  .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  const ok = e.request.method === 'GET' &&
    ((u.origin === location.origin && !u.search) || (u.hostname === 'cdnjs.cloudflare.com' && u.pathname.includes('/leaflet/1.9.4/')));
  if (!ok) return; // 其他請求（資料、token、圖磚）照常走網路
  // 網路優先，失敗才用快取，避免卡在舊版頁面
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
