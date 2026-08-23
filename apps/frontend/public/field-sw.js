// DOC-15 RNF-COL-002 — PWA instalável (Service Worker mínimo). Só precache
// do shell estático da área field — SEM fila de sincronização offline
// (essa é a Sessão COL-2; um Service Worker que fingisse sincronizar sem
// produtor real seria pior do que não ter nenhum, ver
// docs/PROMPT-SESSAO-COL1-pwa-coletor.md §3.2).
const CACHE_NAME = 'wms-field-v1';
const PRECACHE_URLS = ['/field', '/field/login', '/field/consulta', '/field/sincronizacao', '/field-manifest.json', '/field-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/field')) return; // só a área field usa este SW

  // network-first para navegação/API, cache-first para o resto do shell.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || caches.match('/field')))
    );
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
