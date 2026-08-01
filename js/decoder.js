/* ==========================================================================
   decoder.js
   Owns: single-frame decode, image decode, and the "lock-on-scan" debounce
   (stop re-firing the same code while the camera holds steady on it).

   Uses zxing-wasm (the real ZXing C++ engine compiled to WebAssembly) via
   the shared loader in js/zxing-loader.js. As of the Aztec-generation
   change, this now loads the combined "full" build (reader + writer in
   one module/one wasm file — js/vendor/zxing-wasm-full.js +
   js/vendor/zxing_full.wasm) instead of the old reader-only build, since
   generator.js needs the writer half and both share one instance to avoid
   fetching/instantiating the ~1.5MB wasm twice. Decoding behavior and the
   formats read are unchanged.

   Public surface (per integration contract — do not rename):
     window.ScannerApp.decoder.decodeFromVideoFrame(videoEl) -> Promise<result | null>
     window.ScannerApp.decoder.decodeFromImage(file)          -> Promise<result>

   NOTE ON THE CONTRACT CHANGE: decodeFromVideoFrame used to return
   result|null synchronously. zxing-wasm decodes are inherently async (the
   wasm module loads lazily and decoding happens off the main thread's
   synchronous call stack), so this now returns a Promise<result|null>.
   app.js's scan loop has been updated to await it — see app.js.

   Both still only ever produce the phase-2 shape:
     { rawText: string, format: string, timestamp: number }
   parsers.js / validators.js attach the rest.
   ========================================================================== */

(function () {
  'use strict';

  var App = window.ScannerApp;

  var LOCK_MS = 1500; // pause this long after a hit before the next hit can register
  var lockUntil = 0;
  var decodeInFlight = false; // guards against overlapping async decodes on fast rAF ticks

  // Formats we care about. Exact strings zxing-wasm expects — see
  // node_modules/zxing-wasm/.../bindings/barcodeFormat.d.ts if this list
  // ever needs to change. No hyphens/underscores (e.g. "EAN13", not
  // "EAN-13" or "EAN_13"). These are also exactly the formats offered on
  // the Generate side (see generator.js's GENERATE_FORMATS) so scanning
  // and generating stay symmetric.
  var READ_OPTIONS = {
    tryHarder: true,
    formats: [
      'Aztec', 'QRCode', 'PDF417', 'DataMatrix',
      'Code128', 'Code39', 'EAN8', 'EAN13', 'UPCA', 'UPCE'
    ]
  };

  function toResultShape(r) {
    return {
      rawText: r.text,
      format: r.format, // zxing-wasm already returns a readable string, e.g. "Aztec", "QRCode"
      timestamp: Date.now()
    };
  }

  // Offscreen canvas reused every frame so we're not allocating constantly.
  var frameCanvas = document.createElement('canvas');
  var frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });

  /**
   * Attempt to decode whatever the video element is currently showing.
   * Returns a Promise resolving to null when: locked out from a recent
   * hit, video isn't ready, a decode is already in flight, the wasm
   * module isn't loaded yet, or no code is found in this frame (the
   * overwhelmingly common case — NOT an error).
   */
  function decodeFromVideoFrame(videoEl) {
    if (!videoEl || videoEl.readyState < 2) return Promise.resolve(null); // HAVE_CURRENT_DATA or better
    if (Date.now() < lockUntil) return Promise.resolve(null);
    if (decodeInFlight) return Promise.resolve(null);

    var w = videoEl.videoWidth;
    var h = videoEl.videoHeight;
    if (!w || !h) return Promise.resolve(null);

    decodeInFlight = true;

    return App.zxing.ready()
      .then(function () {
        frameCanvas.width = w;
        frameCanvas.height = h;
        frameCtx.drawImage(videoEl, 0, 0, w, h);
        var imageData = frameCtx.getImageData(0, 0, w, h);
        return window.ZXingWASM.readBarcodes(imageData, READ_OPTIONS);
      })
      .then(function (results) {
        decodeInFlight = false;
        if (!results || !results.length) return null;
        lockUntil = Date.now() + LOCK_MS;
        return toResultShape(results[0]);
      })
      .catch(function () {
        decodeInFlight = false;
        return null; // no code visible in this frame — not an error
      });
  }

  /**
   * Decode from an uploaded/dropped file. Rejects with a distinct message
   * per failure mode so the UI can explain what actually happened:
   *   "not-an-image"     — the file itself isn't an image (e.g. a renamed PDF)
   *   "no-code-found"     — a valid image, but no decodable code in it
   *   "decoder-not-ready" — the wasm module hasn't loaded (or failed to)
   *
   * Note: unlike the old Image-element-based path, zxing-wasm decodes the
   * file's bytes directly, so it no longer distinguishes "corrupted image
   * file" (the old "bad-image" case) from "no code found" — both surface
   * as "no-code-found" now. Worth knowing if you see that message on a
   * file that turns out to be genuinely corrupted rather than just
   * code-less.
   */
  function decodeFromImage(file) {
    if (!file) return Promise.reject(new Error('not-an-image'));
    if (!file.type || file.type.indexOf('image/') !== 0) {
      return Promise.reject(new Error('not-an-image'));
    }

    return App.zxing.ready()
      .then(function () {
        return window.ZXingWASM.readBarcodes(file, READ_OPTIONS);
      })
      .then(function (results) {
        if (!results || !results.length) throw new Error('no-code-found');
        return toResultShape(results[0]);
      })
      .catch(function (err) {
        if (err && (err.message === 'not-an-image' || err.message === 'decoder-not-ready')) {
          throw err;
        }
        throw new Error('no-code-found');
      });
  }

  window.ScannerApp = window.ScannerApp || {};
  window.ScannerApp.decoder = {
    decodeFromVideoFrame: decodeFromVideoFrame,
    decodeFromImage: decodeFromImage
  };
})();
