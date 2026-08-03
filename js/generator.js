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
    status: document.getElementById('generator-status'),
    previewWrap: document.getElementById('generate-preview'),
    previewEmpty: document.getElementById('generate-preview-empty'),
    previewResult: document.getElementById('generate-preview-result'),
    canvas: document.getElementById('generator-canvas'),
    hint: document.getElementById('generator-hint'),
    btnDownload: document.getElementById('btn-generator-download'),
    recentGeneratedWrap: document.getElementById('recent-generated'),
    recentGeneratedListWrap: document.getElementById('recent-generated-list-wrap'),
    recentGeneratedList: document.getElementById('recent-generated-list'),
    batchText: document.getElementById('generator-batch-text'),
    btnBatch: document.getElementById('btn-generate-batch'),
    batchHint: document.getElementById('generator-batch-hint'),
    batchResults: document.getElementById('generator-batch-results')
  };

  // Whether the "Encode as base64" toggle is on. Deliberately not persisted
  // (matches the rest of the Generate form, which is scratch/session input,
  // not a saved setting) — starts off on every load.
  var base64Enabled = false;

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

  // ---- #14: recently-generated codes strip -----------------------------------
  // Own small capped store (not a slice of a bigger dataset the way
  // History's getRecent() is) — persisted directly to localStorage since
  // there's no IndexedDB store backing generated codes. Re-generates the
  // barcode image on demand rather than storing PNG data URLs, which would
  // be a much heavier localStorage footprint for no real benefit — the
  // encoder is fast and deterministic for the same input.
  var RECENT_GENERATED_STORAGE_KEY = 'scannerapp_recent_generated';
  var RECENT_GENERATED_COUNT = 8;

  function loadRecentGenerated() {
    var raw = null;
    try { raw = window.localStorage.getItem(RECENT_GENERATED_STORAGE_KEY); } catch (err) { /* storage unavailable */ }
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (e) {
        return e && typeof e.text === 'string' && e.text &&
          typeof e.format === 'string' &&
          GENERATE_FORMATS.some(function (fmt) { return fmt.value === e.format; });
      }).slice(0, RECENT_GENERATED_COUNT);
    } catch (err) {
      return []; // malformed localStorage value — start fresh rather than throw
    }
  }

  var recentGenerated = loadRecentGenerated();

  function persistRecentGenerated() {
    try { window.localStorage.setItem(RECENT_GENERATED_STORAGE_KEY, JSON.stringify(recentGenerated)); } catch (err) { /* storage unavailable */ }
  }

  function updateGeneratedScrollFadeState() {
    if (!els.recentGeneratedListWrap || !els.recentGeneratedList) return;
    var list = els.recentGeneratedList;
    var atStart = list.scrollLeft <= 0;
    var atEnd = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
    els.recentGeneratedListWrap.classList.toggle('has-overflow-left', !atStart);
    els.recentGeneratedListWrap.classList.toggle('has-overflow-right', !atEnd);
  }
  if (els.recentGeneratedList) {
    els.recentGeneratedList.addEventListener('scroll', updateGeneratedScrollFadeState, { passive: true });
  }
  window.addEventListener('resize', updateGeneratedScrollFadeState);
  if (window.ResizeObserver && els.recentGeneratedList) {
    new ResizeObserver(updateGeneratedScrollFadeState).observe(els.recentGeneratedList);
  }

  function renderRecentGenerated() {
    if (!els.recentGeneratedWrap || !els.recentGeneratedList) return;
    els.recentGeneratedWrap.hidden = recentGenerated.length === 0;
    els.recentGeneratedList.innerHTML = '';
    if (!recentGenerated.length) {
      if (els.recentGeneratedListWrap) {
        els.recentGeneratedListWrap.classList.remove('has-overflow-left', 'has-overflow-right');
      }
      return;
    }

    recentGenerated.forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'recent-generated__item';
      li.setAttribute('role', 'button');
      li.setAttribute('tabindex', '0');
      li.setAttribute('aria-label', entry.format + ': ' + entry.text);

      var format = document.createElement('span');
      format.className = 'recent-generated__format';
      format.textContent = entry.format + (entry.base64 ? ' \u00b7 base64' : '');

      var preview = document.createElement('span');
      preview.className = 'recent-generated__preview';
      preview.textContent = entry.text;

      li.appendChild(format);
      li.appendChild(preview);

      li.addEventListener('click', function () { openRecentGenerated(entry); });
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          openRecentGenerated(entry);
        }
      });

      els.recentGeneratedList.appendChild(li);
    });

    updateGeneratedScrollFadeState();
  }

  // De-dupes by exact (text, format, base64) match anywhere in the list —
  // re-generating or re-opening the same code bumps it to the top instead
  // of creating a second chip for it.
  function pushRecentGenerated(text, format, base64) {
    var existingIndex = -1;
    for (var i = 0; i < recentGenerated.length; i++) {
      var e = recentGenerated[i];
      if (e.text === text && e.format === format && !!e.base64 === !!base64) { existingIndex = i; break; }
    }
    if (existingIndex !== -1) recentGenerated.splice(existingIndex, 1);

    recentGenerated.unshift({
      id: 'gen_' + Date.now() + '_' + Math.floor(Math.random() * 100000),
      text: text,
      format: format,
      base64: !!base64,
      timestamp: Date.now()
    });
    if (recentGenerated.length > RECENT_GENERATED_COUNT) recentGenerated.length = RECENT_GENERATED_COUNT;

    persistRecentGenerated();
    renderRecentGenerated();
  }

  // Re-opening a chip fills the form *and* immediately re-renders +
  // reveals Download — deliberately different from prefill() (used for
  // the Scan-page "Regenerate" round-trip), which intentionally leaves
  // rendering to the person so they can tweak the text first. Here the
  // whole point is "re-download exactly what I already made," so getting
  // straight to a downloadable image with one tap is the more useful
  // default.
  function openRecentGenerated(entry) {
    if (els.format) {
      els.format.value = entry.format;
      els.format.dispatchEvent(new Event('scannerapp:syncselect'));
      try { window.localStorage.setItem(FORMAT_STORAGE_KEY, entry.format); } catch (err) { /* storage unavailable */ }
    }
    base64Enabled = !!entry.base64;
    setBase64SwitchVisual(base64Enabled);
    updateFormatHint();
    updateBase64Availability(); // may turn base64Enabled back off if this format can't hold it

    els.text.value = entry.text;
    updateDecodePreview();
    els.text.focus();
    if (els.text.scrollIntoView) els.text.scrollIntoView({ block: 'nearest' });

    handleGenerateClick();
  }

  // ---- UI wiring --------------------------------------------------------------
  var GENERATE_ERROR_COPY = {
    'empty-input': 'Type something to encode first.',
    'encoder-unavailable': 'The barcode library hasn\u2019t loaded, so generating isn\u2019t available yet. Check your connection and reload the page.',
    'encode-failed': 'That text is too long (or otherwise can\u2019t be encoded) for the selected format. Try shortening it or choosing a different format.'
  };

  // Status/error feedback now lives in the form (#generator-status), not
  // inside the preview box — the preview box is hidden entirely until a
  // result exists, so it can no longer double as the place errors show up.
  function setStatus(text, isError) {
    if (!els.status) return;
    els.status.textContent = text || '';
    els.status.classList.toggle('field-hint--error', !!isError);
  }

  // Same red-for-errors / gray-for-everything-else treatment as setStatus()
  // above, applied to the batch form's own hint line — kept as a separate
  // function (not a shared one) because the batch and single-code forms
  // are two independent flows with their own elements, not because the
  // visual rule should differ between them.
  function setBatchStatus(text, isError) {
    if (!els.batchHint) return;
    els.batchHint.textContent = text || '';
    els.batchHint.classList.toggle('field-hint--error', !!isError);
  }

  // Swaps the preview box between its empty state (icon + caption) and its
  // result state (canvas + download button). On desktop the box itself is
  // always visible (see styles.css) so the empty state is what shows there
  // by default; on mobile the whole box stays hidden until has-result is
  // added (also in styles.css, 980px breakpoint), matching the previous
  // hidden-until-generated behavior for narrow screens.
  function showPreviewResult(hasResult) {
    if (!els.previewWrap) return;
    els.previewWrap.classList.toggle('has-result', !!hasResult);
    if (els.previewEmpty) els.previewEmpty.hidden = !!hasResult;
    if (els.previewResult) els.previewResult.hidden = !hasResult;
  }

  function handleGenerateClick() {
    var format = els.format ? els.format.value : 'QRCode';
    var token = ++generationToken;

    els.btnGenerate.disabled = true;
    setStatus('Generating\u2026', false);

    generate(els.text.value, format, { base64: base64Enabled })
      .then(function () {
        if (token !== generationToken) return; // a newer request/edit supersedes this one
        canvasFormat = format;
        setStatus('', false);
        els.hint.textContent = 'Generated ' + new Date().toLocaleTimeString() + '.';
        els.btnDownload.hidden = false;
        showPreviewResult(true);
        pushRecentGenerated(els.text.value.trim(), format, base64Enabled);
      })
      .catch(function (err) {
        if (token !== generationToken) return;
        setStatus((err && GENERATE_ERROR_COPY[err.code]) || 'Could not generate a barcode from that text.', true);
        els.btnDownload.hidden = true;
        showPreviewResult(false);
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

  // ---- #13: batch generate -> zip ---------------------------------------------
  // Deliberately isolated from the single-generate path above: it never
  // touches els.canvas, canvasFormat, or generationToken, so a batch run
  // can't stomp on (or be stomped on by) the live single-code preview.
  // Each line gets its own offscreen canvas, encoded via the same zxing
  // call + drawImageToCanvas() the single path uses, then packed into a
  // zip with a small hand-rolled store-only (uncompressed) writer — no
  // external library, matching this app's fully-offline/vendored-only
  // dependency policy (see sw.js's comment on why ZXing itself is
  // vendored locally rather than pulled from a CDN).

  // ---- minimal ZIP (store method, no compression) ----
  // Good enough here: barcode PNGs don't compress much further anyway
  // (they're already small, mostly black/white), and skipping DEFLATE
  // avoids pulling in a compression implementation for marginal benefit.
  var CRC32_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(date) {
    date = date || new Date();
    var dosTime = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1F);
    var dosDate = (((Math.max(date.getFullYear(), 1980) - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
    return { time: dosTime, date: dosDate };
  }

  // entries: [{ name: string, data: Uint8Array }] -> Blob (application/zip)
  function createZipBlob(entries) {
    var chunks = [];
    var centralParts = [];
    var offset = 0;
    var dt = dosDateTime();

    entries.forEach(function (entry) {
      var nameBytes = new TextEncoder().encode(entry.name);
      var data = entry.data;
      var crc = crc32(data);

      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);        // version needed to extract
      local.setUint16(6, 0x0800, true);    // flags: bit 11 = UTF-8 filename
      local.setUint16(8, 0, true);         // compression: 0 = store
      local.setUint16(10, dt.time, true);
      local.setUint16(12, dt.date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true); // compressed size
      local.setUint32(22, data.length, true); // uncompressed size
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);        // extra field length

      chunks.push(new Uint8Array(local.buffer), nameBytes, data);

      centralParts.push({ nameBytes: nameBytes, crc: crc, size: data.length, offset: offset, time: dt.time, date: dt.date });
      offset += 30 + nameBytes.length + data.length;
    });

    var centralDirStart = offset;
    centralParts.forEach(function (e) {
      var central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);      // version made by
      central.setUint16(6, 20, true);      // version needed
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, 0, true);      // compression
      central.setUint16(12, e.time, true);
      central.setUint16(14, e.date, true);
      central.setUint32(16, e.crc, true);
      central.setUint32(20, e.size, true);
      central.setUint32(24, e.size, true);
      central.setUint16(28, e.nameBytes.length, true);
      central.setUint16(30, 0, true);      // extra length
      central.setUint16(32, 0, true);      // comment length
      central.setUint16(34, 0, true);      // disk number start
      central.setUint16(36, 0, true);      // internal attrs
      central.setUint32(38, 0, true);      // external attrs
      central.setUint32(42, e.offset, true);

      chunks.push(new Uint8Array(central.buffer), e.nameBytes);
      offset += 46 + e.nameBytes.length;
    });
    var centralDirSize = offset - centralDirStart;

    var eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, centralDirSize, true);
    eocd.setUint32(16, centralDirStart, true);
    eocd.setUint16(20, 0, true);
    chunks.push(new Uint8Array(eocd.buffer));

    return new Blob(chunks, { type: 'application/zip' });
  }

  // Encodes one line to a PNG Blob using its own offscreen canvas — never
  // touches els.canvas, so it can't visually interfere with (or be reset
  // by) the single-code preview while a batch run is in progress.
  function encodeOneForBatch(text, format, base64) {
    var value = String(text == null ? '' : text).trim();
    if (!value) {
      var emptyErr = new Error('empty-input');
      emptyErr.code = 'empty-input';
      return Promise.reject(emptyErr);
    }
    if (base64) value = utf8ToBase64(value);

    var writerOptions = { format: format || 'QRCode', scale: 4, addQuietZones: true };

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
        var canvas = document.createElement('canvas');
        canvas.width = els.canvas.width;
        canvas.height = els.canvas.height;
        return drawImageToCanvas(result.image, canvas).then(function () {
          return new Promise(function (resolve, reject) {
            canvas.toBlob(function (blob) {
              if (blob) resolve(blob); else reject(new Error('blob-failed'));
            }, 'image/png');
          });
        });
      });
  }

  // Filenames: "<index>-<format>-<sanitized-snippet>.png". The index
  // prefix alone already guarantees uniqueness across lines (two lines
  // never share an index), so no separate collision-avoidance pass is
  // needed on top of it.
  function sanitizeForFilename(text) {
    var s = text.trim().slice(0, 40).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return s || 'code';
  }

  function parseBatchLines(raw) {
    var rawLines = String(raw == null ? '' : raw).split(/\r\n|\r|\n/);
    return rawLines.map(function (line, idx) {
      var trimmed = line.trim();
      return { lineNumber: idx + 1, text: trimmed, blank: !trimmed };
    });
  }

  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function renderBatchResults(failedResults, skippedCount) {
    if (!els.batchResults) return;
    els.batchResults.innerHTML = '';
    if (!failedResults.length && !skippedCount) {
      els.batchResults.hidden = true;
      return;
    }
    failedResults.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'batch-generate__result-item is-failed';
      li.textContent = 'Line ' + r.lineNumber + ': ' + r.error;
      els.batchResults.appendChild(li);
    });
    if (skippedCount) {
      var li = document.createElement('li');
      li.className = 'batch-generate__result-item is-skipped';
      li.textContent = skippedCount + ' blank line' + (skippedCount === 1 ? '' : 's') + ' skipped.';
      els.batchResults.appendChild(li);
    }
    els.batchResults.hidden = false;
  }

  function handleBatchGenerateClick() {
    if (!els.batchText || !els.btnBatch) return;
    var format = els.format ? els.format.value : 'QRCode';
    var lines = parseBatchLines(els.batchText.value);
    var toProcess = lines.filter(function (l) { return !l.blank; });

    if (!toProcess.length) {
      setBatchStatus('Add at least one line to batch-generate.', true);
      renderBatchResults([], 0);
      return;
    }

    els.btnBatch.disabled = true;
    els.batchText.disabled = true;
    renderBatchResults([], 0);

    var digits = String(toProcess.length).length;
    function pad(n) { var s = String(n); while (s.length < digits) s = '0' + s; return s; }

    var results = [];
    var chain = Promise.resolve();
    toProcess.forEach(function (item, i) {
      chain = chain.then(function () {
        setBatchStatus('Generating ' + (i + 1) + ' of ' + toProcess.length + '\u2026', false);
        return encodeOneForBatch(item.text, format, base64Enabled)
          .then(function (blob) {
            var filename = pad(i + 1) + '-' + format.toLowerCase() + '-' + sanitizeForFilename(item.text) + '.png';
            results.push({ lineNumber: item.lineNumber, status: 'ok', filename: filename, blob: blob });
          })
          .catch(function (err) {
            var reason = (err && GENERATE_ERROR_COPY[err.code]) || 'Could not generate a barcode from that text.';
            results.push({ lineNumber: item.lineNumber, status: 'failed', error: reason });
          });
      });
    });

    chain.then(function () {
      var skippedCount = lines.length - toProcess.length;
      var okResults = results.filter(function (r) { return r.status === 'ok'; });
      var failedResults = results.filter(function (r) { return r.status === 'failed'; });

      renderBatchResults(failedResults, skippedCount);

      if (!okResults.length) {
        setBatchStatus('Nothing generated \u2014 ' + failedResults.length +
          ' line' + (failedResults.length === 1 ? '' : 's') + ' failed.', true);
        els.btnBatch.disabled = false;
        els.batchText.disabled = false;
        return;
      }

      return Promise.all(okResults.map(function (r) {
        return r.blob.arrayBuffer().then(function (buf) {
          return { name: r.filename, data: new Uint8Array(buf) };
        });
      }))
        .then(function (entries) {
          var zipBlob = createZipBlob(entries);
          var stamp = (App.ui && App.ui.formatTimestampForFilename) ? App.ui.formatTimestampForFilename(Date.now()) : Date.now();
          var zipName = 'codes-' + stamp + '.zip';
          downloadBlob(zipName, zipBlob);

          var extras = [];
          if (failedResults.length) extras.push(failedResults.length + ' failed');
          if (skippedCount) extras.push(skippedCount + ' blank line' + (skippedCount === 1 ? '' : 's') + ' skipped');
          if (els.batchHint) {
            setBatchStatus('Generated ' + okResults.length + ' code' + (okResults.length === 1 ? '' : 's') +
              ' \u2192 ' + zipName + (extras.length ? ' (' + extras.join(', ') + ')' : ''), false);
          }
          if (App.ui && App.ui.toast) App.ui.toast('Downloaded ' + zipName);
        })
        .catch(function () {
          setBatchStatus('Could not build the zip file.', true);
        })
        .then(function () {
          els.btnBatch.disabled = false;
          els.batchText.disabled = false;
        });
    });
  }

  if (els.btnBatch) els.btnBatch.addEventListener('click', handleBatchGenerateClick);

  function resetHint() {
    generationToken++; // invalidate any generate() still in flight
    setStatus('', false);
    els.btnDownload.hidden = true;
    if (canvasFormat !== null) clearCanvas();
    showPreviewResult(false);
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
  renderRecentGenerated();

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
      els.format.dispatchEvent(new Event('scannerapp:syncselect'));
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
