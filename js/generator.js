/* ==========================================================================
   generator.js
   Owns: the Generate page — turning typed text into a barcode on-screen,
   and downloading it as a PNG. Does NOT own view/nav switching anymore
   (that moved to ui.js, which is shared shell chrome used by every page,
   not just this one). Does NOT touch decoding, parsing, validation,
   history, or settings.

   Uses zxing-wasm's writeBarcode (via the shared loader in js/zxing-loader.js)
   — the same engine decoder.js uses for reading — for real multi-format
   support (Aztec, PDF417, DataMatrix, Code128/39, EAN/UPC), matching
   exactly what decoder.js can read.

   Public surface (per integration contract — do not rename):
     window.ScannerApp.generator.generate(text, format) -> Promise<HTMLCanvasElement>
   ========================================================================== */

(function () {
  'use strict';

  var App = window.ScannerApp;

  var els = {
    format: document.getElementById('generator-format'),
    formatHint: document.getElementById('generator-format-hint'),
    text: document.getElementById('generator-text'),
    btnGenerate: document.getElementById('btn-generate'),
    canvas: document.getElementById('generator-canvas'),
    hint: document.getElementById('generator-hint'),
    btnDownload: document.getElementById('btn-generator-download')
  };

  var DEFAULT_HINT = 'Enter text and generate to preview here.';

  // Bumped on every generate() call and every input/format change so an
  // in-flight (async) generate response can tell it's stale and bail out
  // instead of painting success UI over a newer selection.
  var generationToken = 0;
  // The format actually baked into the current canvas pixels — not
  // necessarily els.format.value, which may have changed since.
  var canvasFormat = null;

  var GENERATE_FORMATS = [
    { value: 'QRCode', label: 'QR Code' },
    { value: 'Aztec', label: 'Aztec' },
    { value: 'PDF417', label: 'PDF417' },
    { value: 'DataMatrix', label: 'Data Matrix' },
    { value: 'Code128', label: 'Code 128' },
    { value: 'Code39', label: 'Code 39' },
    { value: 'EAN13', label: 'EAN-13' },
    { value: 'EAN8', label: 'EAN-8' },
    { value: 'UPCA', label: 'UPC-A' },
    { value: 'UPCE', label: 'UPC-E' }
  ];

  var FORMAT_HINTS = {
    QRCode: 'Any text, URL, or data — the most flexible format.',
    Aztec: 'Any text or data — compact, used on tickets and boarding passes.',
    PDF417: 'Any text or data — holds more data, used on IDs and shipping labels.',
    DataMatrix: 'Any text or data — compact, common on small parts and labels.',
    Code128: 'Any text, letters and numbers — common shipping/logistics barcode.',
    Code39: 'Uppercase letters, numbers, and a few symbols only.',
    EAN13: 'Digits only — exactly 12 or 13, a real product barcode number.',
    EAN8: 'Digits only — exactly 7 or 8, a real product barcode number.',
    UPCA: 'Digits only — exactly 11 or 12, a real product barcode number.',
    UPCE: 'Digits only — exactly 6 to 8, a compressed product barcode number.'
  };

  // ---- format dropdown population -----------------------------------------
  (function populateFormatSelect() {
    if (!els.format) return;
    GENERATE_FORMATS.forEach(function (fmt) {
      var opt = document.createElement('option');
      opt.value = fmt.value;
      opt.textContent = fmt.label;
      els.format.appendChild(opt);
    });
    els.format.value = 'QRCode';
  })();

  function updateFormatHint() {
    if (!els.formatHint || !els.format) return;
    els.formatHint.textContent = FORMAT_HINTS[els.format.value] || '';
  }
  updateFormatHint();

  // ---- rendering ------------------------------------------------------------
  // Drawn black-on-white deliberately (ignoring the current theme) because a
  // barcode's real-world scannability depends on high contrast.
  function drawImageToCanvas(blob, canvas) {
    return createImageBitmap(blob).then(function (bitmap) {
      var cw = canvas.width;
      var ch = canvas.height;
      var ctx = canvas.getContext('2d');

      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cw, ch);

      var scale = Math.min(cw / bitmap.width, ch / bitmap.height);
      var dw = bitmap.width * scale;
      var dh = bitmap.height * scale;
      var dx = (cw - dw) / 2;
      var dy = (ch - dh) / 2;

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bitmap, dx, dy, dw, dh);

      if (bitmap.close) bitmap.close();
    });
  }

  function clearCanvas() {
    var canvas = els.canvas;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    canvasFormat = null;
  }

  /**
   * Encode `text` as `format` (defaults to "QRCode") and draw it onto the
   * generator canvas. Returns a Promise resolving to the canvas element.
   */
  function generate(text, format) {
    var value = String(text == null ? '' : text).trim();
    if (!value) {
      var emptyErr = new Error('empty-input');
      emptyErr.code = 'empty-input';
      return Promise.reject(emptyErr);
    }

    var writerOptions = {
      format: format || 'QRCode',
      scale: 4,
      addQuietZones: true
    };

    return App.zxing.ready()
      .then(function () {
        return window.ZXingWASM.writeBarcode(value, writerOptions);
      }, function () {
        var unavailableErr = new Error('encoder-unavailable');
        unavailableErr.code = 'encoder-unavailable';
        throw unavailableErr;
      })
      .then(function (result) {
        if (!result || !result.image) {
          var encodeErr = new Error('encode-failed');
          encodeErr.code = 'encode-failed';
          encodeErr.detail = result && result.error;
          throw encodeErr;
        }
        return drawImageToCanvas(result.image, els.canvas).then(function () {
          return els.canvas;
        });
      });
  }

  // ---- UI wiring --------------------------------------------------------------
  var GENERATE_ERROR_COPY = {
    'empty-input': 'Type something to encode first.',
    'encoder-unavailable': 'The barcode library hasn\u2019t loaded, so generating isn\u2019t available yet. Check your connection and reload the page.',
    'encode-failed': 'That text is too long (or otherwise can\u2019t be encoded) for the selected format. Try shortening it or choosing a different format.'
  };

  function handleGenerateClick() {
    var format = els.format ? els.format.value : 'QRCode';
    var token = ++generationToken;

    els.btnGenerate.disabled = true;
    els.hint.textContent = 'Generating\u2026';

    generate(els.text.value, format)
      .then(function () {
        if (token !== generationToken) return; // a newer request/edit supersedes this one
        canvasFormat = format;
        els.hint.textContent = 'Generated ' + new Date().toLocaleTimeString() + '.';
        els.btnDownload.hidden = false;
      })
      .catch(function (err) {
        if (token !== generationToken) return;
        els.hint.textContent = (err && GENERATE_ERROR_COPY[err.code]) || 'Could not generate a barcode from that text.';
        els.btnDownload.hidden = true;
        clearCanvas();
      })
      .then(function () {
        els.btnGenerate.disabled = false;
      });
  }

  function handleDownloadClick() {
    var format = canvasFormat || (els.format ? els.format.value : 'QRCode');
    var url = els.canvas.toDataURL('image/png');
    var stamp = (App.ui && App.ui.formatTimestampForFilename) ? App.ui.formatTimestampForFilename(Date.now()) : Date.now();
    var a = document.createElement('a');
    a.href = url;
    a.download = format.toLowerCase() + '-code-' + stamp + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  els.btnGenerate.addEventListener('click', handleGenerateClick);
  els.btnDownload.addEventListener('click', handleDownloadClick);

  function resetHint() {
    generationToken++; // invalidate any generate() still in flight
    if (els.hint.textContent !== DEFAULT_HINT) {
      els.hint.textContent = DEFAULT_HINT;
      els.btnDownload.hidden = true;
    }
    if (canvasFormat !== null) clearCanvas();
  }
  els.text.addEventListener('input', resetHint);
  if (els.format) {
    els.format.addEventListener('change', function () {
      resetHint();
      updateFormatHint();
    });
  }

  window.ScannerApp = window.ScannerApp || {};
  window.ScannerApp.generator = {
    generate: generate
  };
})();
