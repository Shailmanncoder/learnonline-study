// StudyHub Service Worker
// Strategy: the app's own code (HTML/CSS/JS) is fetched network-first, so a
// deploy reaches the browser on the next load; the cache is the offline
// fallback. Images and fonts stay cache-first since they rarely change.
// API calls are never cached — that data changes constantly and is
// auth-sensitive.
//
// This was cache-first for everything, which meant a shipped CSS or JS change
// was served STALE on the next load and only took effect the load after that.
// The visible symptom was new markup rendering against old stylesheets.
// Bump CACHE_VERSION on any release that changes shell assets.

const CACHE_VERSION = 'v17-teaching-studio';
const CACHE_NAME = `studyhub-shell-${CACHE_VERSION}`;
const APP_SHELL = [
    '/',
    '/index.html',
    '/styles.css',
    '/premium.css',
    '/api.js',
    '/data.js',
    '/landing.js',
    '/refinements.js',
    '/refinements.css',
    '/app.js',
    '/teachingStudio.js',
    '/teachingStudio.css',
    '/ncert.js',
    '/premium.js',
    '/chatSidebar.js',
    '/sourceLibrary.js',
    '/chatTools.js',
    '/auto-study/index.html',
    '/auto-study/style.css',
    '/auto-study/app.js',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {
            // Non-fatal — if a shell asset fails to cache, the app still works fully online
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Never cache API calls or third-party CDN scripts — always fetch fresh
    if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) {
        return;
    }

    // Images and fonts: cache-first is safe, they are replaced by filename.
    const isStatic = /\.(png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$/i.test(url.pathname);
    if (isStatic) {
        event.respondWith(
            caches.match(request).then((cached) => cached || fetch(request).then((response) => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                }
                return response;
            }))
        );
        return;
    }

    // App code: network-first so a deploy takes effect immediately, with the
    // cache kept fresh underneath as the offline fallback.
    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                }
                return response;
            })
            .catch(() => caches.match(request).then((cached) => cached
                || (request.mode === 'navigate' ? caches.match('/index.html') : undefined)))
    );
});
