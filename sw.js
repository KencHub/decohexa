/* ==========================================================================
   sw.js
   Owns: offline caching of the app shell (HTML/CSS/JS/icons/vendored
   decoder library) so the scanner still opens and runs with no network.
   Does NOT touch app state or any window.ScannerApp module — a service
   worker runs in its own thread with no access to the page's globals.

   Strategy: cache-first for same-origin app-shell files (they're versioned
   by CACHE_NAME below, not by individual file hashing), network-first with
   a cache fallback for everything else (e.g. the Google Fonts CSS/font
   files, which are cross-origin and fine to skip on first offline load —
   the fallback system fonts in styles.css cover that gap). Camera access
   (getUserMedia) and file uploads never go through fetch, so they aren't
   affected by any of this either way.
   ========================================================================== */

// Bump this (v2 -> v3 -> ...) any time a file in SHELL_FILES changes.
// The browser only re-copies the shell files when this string changes —
// editing history.js/app.js/etc. alone does nothing until this does too.
var CACHE_NAME = 'scanner-shell-v3';

// Everything the app needs to boot and run with zero network access.
// ZXing is vendored locally (see index.html's comment on that decision),
// so it's included here rather than relying on a CDN.
var SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/vendor/zxing-wasm-full.js',
  './js/vendor/zxing_full.wasm',
  './js/zxing-loader.js',
  './js/ui.js',
  './js/camera.js',
  './js/decoder.js',
  './js/parsers.js',
  './js/validators.js',
  './js/history.js',
  './js/settings.js',
  './js/generator.js',
  './js/custom-select.js',
  './js/app.js',
  './assets/icons/favicon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-192-maskable.png',
  './assets/icons/icon-512-maskable.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // addAll fails atomically if any single file 404s — that's fine here
      // since these are all files this same build ships, but if a future
      // phase adds/removes a file without updating SHELL_FILES, install
      // will start failing loudly rather than silently caching a partial
      // shell. Fail loud is the right default for an app-shell cache.
      return cache.addAll(SHELL_FILES);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) { return name !== CACHE_NAME; })
          .map(function (name) { return caches.delete(name); })
      );
    })
  );
  self.clients.claim();
});

function isSameOrigin(url) {
  return new URL(url).origin === self.location.origin;
}

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only handle GET — POST/etc (none exist in this app, but be safe) pass
  // straight through untouched.
  if (req.method !== 'GET') return;

  if (isSameOrigin(req.url)) {
    // App shell: cache-first, falling back to network (and caching what we
    // get, so anything not pre-listed in SHELL_FILES still ends up
    // available offline after first visit).
    event.respondWith(
      caches.match(req).then(function (cached) {
        if (cached) return cached;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        }).catch(function () {
          // Navigating while offline to a URL we haven't cached (e.g. a
          // deep link) — fall back to the shell itself rather than a
          // browser error page.
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Promise.reject('offline-and-not-cached');
        });
      })
    );
    return;
  }

  // Cross-origin (Google Fonts, etc.): network-first, cache as a fallback
  // for next time, but never block or error the page if it's unreachable.
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req);
    })
  );
});
