/* ==========================================================================
   zxing-loader.js
   Owns: loading the zxing-wasm "full" module (reader + writer in one
   bundle — js/vendor/zxing-wasm-full.js + js/vendor/zxing_full.wasm).

   WHY THIS FILE EXISTS: decoder.js and generator.js both need the same
   ZXingWASM module ready before they can do anything. Previously decoder.js
   fetched and instantiated the wasm itself. Now that generator.js also
   needs it (to support Aztec/PDF417/DataMatrix/etc. generation, not just
   QR), letting each file independently fetch+prepare its own module would
   double the ~1.5MB download and compile the wasm twice — wasteful, and
   the module-caching in zxing-wasm keys off object identity of the
   `overrides` object, so two independently-created `{ wasmBinary: ... }`
   objects with identical bytes would NOT be treated as the same call.
   Centralizing here guarantees exactly one fetch/prepare no matter how
   many callers ask for it.

   Public surface:
     window.ScannerApp.zxing.ready() -> Promise<ZXingWASM module>
   ========================================================================== */

(function () {
  'use strict';

  // Path to the combined reader+writer wasm binary, relative to index.html.
  var WASM_URL = 'js/vendor/zxing_full.wasm';

  var moduleReadyPromise = null;

  function ready() {
    if (moduleReadyPromise) return moduleReadyPromise;

    if (typeof window.ZXingWASM === 'undefined') {
      moduleReadyPromise = Promise.reject(new Error('decoder-not-ready'));
      return moduleReadyPromise;
    }

    moduleReadyPromise = fetch(WASM_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('wasm-fetch-failed');
        return res.arrayBuffer();
      })
      .then(function (bytes) {
        return window.ZXingWASM.prepareZXingModule({
          overrides: { wasmBinary: new Uint8Array(bytes) },
          fireImmediately: true
        });
      });

    return moduleReadyPromise;
  }

  // Kick off loading as soon as this script runs so the module is likely
  // already warm by the time someone scans or generates something.
  // Failures here are silent by design — they surface properly on the
  // first real ready() call's rejection.
  if (typeof window.ZXingWASM !== 'undefined') {
    ready().catch(function () {});
  }

  window.ScannerApp = window.ScannerApp || {};
  window.ScannerApp.zxing = { ready: ready };
})();
