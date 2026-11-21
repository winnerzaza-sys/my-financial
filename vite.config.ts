import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
      name: 'offline-app-shell',
      apply: 'build',
      generateBundle(_, bundle) {
        const built = Object.keys(bundle).filter((name) => /\.(?:js|css|html|woff2?)$/.test(name))
        const shell = [
          '/',
          '/coin.svg',
          '/coin-192.png',
          '/coin-512.png',
          '/manifest.webmanifest',
          ...built.map((name) => '/' + name),
        ]
        const cache = 'financial-shell-' + built.filter((name) => name.endsWith('.js')).join('-')
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: `
const cacheName = ${JSON.stringify(cache)};
const shell = ${JSON.stringify(shell)};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('financial-shell-') && key !== cacheName)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.open(cacheName).then(cache => cache.match('/'))));
  } else if (shell.includes(url.pathname)) {
    event.respondWith(caches.open(cacheName).then(cache => cache.match(url.pathname)).then(found => found || fetch(event.request)));
  }
});`,
        })
      },
    },
  ],
})
