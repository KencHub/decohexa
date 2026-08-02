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
     window.ScannerApp.generator.prefill(rawText, format)  // Regenerate round-trip;
                                                            // fills the form, doesn't render
   ========================================================================== */

(function () {
  'use strict';

  var App = window.ScannerApp;

  var els = {
    format: document.getElementById('generator-format'),
    formatHint: document.getElementById('generator-format-hint'),
    text: document.getElementById('generator-text'),
    decodePreview: document.getElementById('generator-decode-preview'),
    base64Row: document.getElementById('generator-base64-row'),
    base64Switch: document.getElementById('switch-generator-base64'),
    btnGenerate: document.getElementById('btn-generate'),
    canvas: document.getElementById('generator-canvas'),
    hint: document.getElementById('generator-hint'),
    btnDownload: document.getElementById('btn-generator-download')
  };

  // Whether the "Encode as base64" toggle is on. Deliberately not persisted
  // (matches the rest of the Generate form, which is scratch/session input,
  // not a saved setting) — starts off on every load.
  var base64Enabled = false;

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

  // Formats whose character set can't hold base64 output (mixed case,
  // '+' '/' '=') — the digit-only product-barcode formats, plus Code39
  // (uppercase + a small symbol set only). Everything else here is
  // effectively byte-capable, including Code128 (full ASCII).
  var BASE64_UNSUPPORTED_FORMATS = ['Code39', 'EAN13', 'EAN8', 'UPCA', 'UPCE'];

  // Mirrors the `type` values parsers.js returns, for the live "will be
  // recognized as" preview below. Kept here rather than imported from
  // parsers.js since it's just display copy, not logic.
  var TYPE_LABELS = {
    jwt: 'JWT',
    wifi: 'WiFi network',
    vcard: 'Contact card (vCard)',
    url: 'URL / link',
    json: 'JSON',
    base64json: 'Encoded JSON (base64)',
    base64text: 'Encoded text (base64)',
    text: 'Plain text'
  };

  var FORMAT_STORAGE_KEY = 'scannerapp-generator-format';

  // ---- format dropdown population -----------------------------------------
  (function populateFormatSelect() {
    if (!els.format) return;
    GENERATE_FORMATS.forEach(function (fmt) {
      var opt = document.createElement('option');
      opt.value = fmt.value;
      opt.textContent = fmt.label;
      els.format.appendChild(opt);
    });
    var saved = null;
    try { saved = window.localStorage.getItem(FORMAT_STORAGE_KEY); } catch (err) { /* storage unavailable */ }
    var savedIsValid = saved && GENERATE_FORMATS.some(function (fmt) { return fmt.value === saved; });
    els.format.value = savedIsValid ? saved : 'QRCode';
  })();

  function updateFormatHint() {
    if (!els.formatHint || !els.format) return;
    els.formatHint.textContent = FORMAT_HINTS[els.format.value] || '';
  }
  updateFormatHint();

  // ---- base64 encode toggle -------------------------------------------------

  // Standard base64 (not base64url) — matches what tryParseBase64 in
  // parsers.js accepts (its alphabet check allows both '+/' and '-_').
  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function setBase64SwitchVisual(on) {
    if (!els.base64Switch) return;
    els.base64Switch.classList.toggle('is-on', !!on);
    els.base64Switch.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  // Hides/disables the toggle for formats that can't physically hold
  // base64 output (digit-only barcodes, Code39's restricted charset), and
  // turns it back off automatically if the user switches into one of those
  // formats while it was on — so a stale "on" state can't silently break
  // the next generate() call.
  function updateBase64Availability() {
    if (!els.base64Row) return;
    var format = els.format ? els.format.value : 'QRCode';
    var supported = BASE64_UNSUPPORTED_FORMATS.indexOf(format) === -1;
    els.base64Row.hidden = !supported;
    if (!supported && base64Enabled) {
      base64Enabled = false;
      setBase64SwitchVisual(false);
    }
  }

  if (els.base64Switch) {
    els.base64Switch.addEventListener('click', function () {
      base64Enabled = !base64Enabled;
      setBase64SwitchVisual(base64Enabled);
      updateDecodePreview();
      resetHint(); // the barcode's actual payload would change — any drawn canvas is now stale
    });
  }

  // ---- live "will be recognized as" preview ----------------------------------
  // Runs the exact same parser scanning uses (App.parsers.parse) against
  // whatever's currently in the text box — encoded first if the base64
  // toggle is on — so what you see here is a true preview of what scanning
  // the generated code back would show, not a separate reimplementation
  // that could drift from the real detection logic.
  function updateDecodePreview() {
    if (!els.decodePreview) return;
    var raw = els.text.value.trim();
    if (!raw) { els.decodePreview.textContent = ''; return; }

    var toCheck = raw;
    if (base64Enabled) {
      try {
        toCheck = utf8ToBase64(raw);
      } catch (err) {
        els.decodePreview.textContent = '';
        return;
      }
    }

    if (!App.parsers || !App.parsers.parse) return;
    var parsed = App.parsers.parse(toCheck);
    var label = (parsed && TYPE_LABELS[parsed.type]) || 'Plain text';
    els.decodePreview.textContent = 'Will be recognized as: ' + label;
  }

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
   *
   * `options.base64` (optional, default false): base64-encode `text` before
   * it goes into the barcode, so the readable input becomes a decodable
   * blob — the same shape parsers.js's base64json/base64text detection
   * reads back out on scan (e.g. ID/claims-style codes).
   */
  function generate(text, format, options) {
    var value = String(text == null ? '' : text).trim();
    if (!value) {
      var emptyErr = new Error('empty-input');
      emptyErr.code = 'empty-input';
      return Promise.reject(emptyErr);
    }

    if (options && options.base64) {
      value = utf8ToBase64(value);
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

    generate(els.text.value, format, { base64: base64Enabled })
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
  els.text.addEventListener('input', function () {
    resetHint();
    updateDecodePreview();
  });
  if (els.format) {
    els.format.addEventListener('change', function () {
      try { window.localStorage.setItem(FORMAT_STORAGE_KEY, els.format.value); } catch (err) { /* storage unavailable */ }
      resetHint();
      updateFormatHint();
      updateBase64Availability();
      updateDecodePreview();
    });
  }

  // Initial state: no format-specific restriction applied to the toggle yet
  // (default format is QRCode, which supports it), and nothing typed yet
  // so the preview starts blank.
  updateBase64Availability();
  updateDecodePreview();

  /**
   * Pre-fill the Generate form from an existing scan (Scan's live result or
   * a History entry) — the "Regenerate" round-trip. `rawText` is used
   * verbatim (it's the literal payload that was scanned, e.g. the full
   * "WIFI:T:WPA;S:...;P:...;;" string), not reconstructed from parsed
   * fields, so this is correct for every type with no per-type logic and
   * without needing to touch any masked/sensitive on-screen value — the
   * mask only ever affects rendered DOM text, never entry.rawText itself.
   *
   * `format` should be one of GENERATE_FORMATS' values (decoder.js's
   * READ_OPTIONS.formats and this file's GENERATE_FORMATS are kept
   * symmetric on purpose, so this should always hit); falls back to
   * 'QRCode' if it somehow doesn't.
   *
   * Does not call generate() itself — leaves the canvas empty and lets the
   * person hit Generate, same as typing input by hand, so they can tweak
   * the text first if they want.
   */
  function prefill(rawText, format) {
    var formatIsValid = GENERATE_FORMATS.some(function (fmt) { return fmt.value === format; });
    var useFormat = formatIsValid ? format : 'QRCode';

    if (els.format) {
      els.format.value = useFormat;
      try { window.localStorage.setItem(FORMAT_STORAGE_KEY, useFormat); } catch (err) { /* storage unavailable */ }
    }

    // rawText is already the literal payload as scanned — never re-encode
    // it as base64 here, or a WiFi/vCard/etc. payload would double-encode.
    base64Enabled = false;
    setBase64SwitchVisual(false);

    updateFormatHint();
    updateBase64Availability();

    els.text.value = rawText == null ? '' : String(rawText);
    resetHint();
    updateDecodePreview();

    els.text.focus();
    if (els.text.scrollIntoView) els.text.scrollIntoView({ block: 'nearest' });
  }

  window.ScannerApp = window.ScannerApp || {};
  window.ScannerApp.generator = {
    generate: generate,
    prefill: prefill
  };
})();
