/* ==========================================================================
   app.js — glue code
   Wires camera.js + decoder.js to the UI and runs the pipeline:
       decoder -> parsers.parse -> validators.checkChecksum/isDuplicate -> history
   history.js owns storage/search/export/rendering for App.state.history —
   this file only computes the result and hands it off via
   window.ScannerApp.history.add(result).
   ========================================================================== */

(function () {
  'use strict';

  var App = window.ScannerApp;

  var els = {
    video: document.getElementById('video'),
    viewportWrap: document.getElementById('viewport-wrap'),
    viewportStatusLabel: document.getElementById('viewport-status-label'),
    viewportEmpty: document.getElementById('viewport-empty'),
    viewportError: document.getElementById('viewport-error'),
    viewportErrorTitle: document.getElementById('viewport-error-title'),
    viewportErrorBody: document.getElementById('viewport-error-body'),
    liveDot: document.getElementById('live-dot'),

    btnToggleScan: document.getElementById('btn-toggle-scan'),
    btnToggleScanIcon: document.getElementById('btn-toggle-scan-icon'),
    btnSwitchCamera: document.getElementById('btn-switch-camera'),
    btnTorch: document.getElementById('btn-torch'),
    btnBatchMode: document.getElementById('btn-batch-mode'),

    dropzone: document.getElementById('dropzone'),
    inputUpload: document.getElementById('input-upload'),

    resultEmpty: document.getElementById('result-empty'),
    resultBody: document.getElementById('result-body'),
    resultReadout: document.getElementById('result-readout'),
    resultFields: document.getElementById('result-fields'),
    resultRawText: document.getElementById('result-raw-text'),
    badgeFormat: document.getElementById('result-badge-format'),
    badgeValid: document.getElementById('result-badge-valid'),
    badgeInvalid: document.getElementById('result-badge-invalid'),
    badgeDupe: document.getElementById('result-badge-dupe'),
    btnCopyDetails: document.getElementById('btn-copy-details')
  };

  var ICON_PLAY = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
  var ICON_STOP = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';

  var scanning = false;
  var rafHandle = null;

  // ---- batch mode: post-scan cooldown ---------------------------------------
  // Without this, loop() would call handleDecodedResult() again on the very
  // next frame if the same code is still sitting in view, spamming History
  // with duplicate entries. LOCK_MS matches the "Locked — <format>" status
  // window below so the visible lock state and the accept-gate stay in sync.
  var LOCK_MS = 1500;
  var acceptCooldownUntil = 0;

  // ---- startup check: catch a failed ZXing CDN/vendor load immediately ------
  function checkDecoderLoaded() {
    if (typeof window.ZXingWASM === 'undefined') {
      showViewportError(
        'Decoder failed to load',
        'The barcode library couldn\u2019t load, so scanning and image upload won\u2019t work yet. Check your internet connection and reload the page.'
      );
      els.btnToggleScan.disabled = true;
      els.dropzone.classList.add('is-dragover');
      els.dropzone.querySelector('.dropzone__text').innerHTML =
        '<strong>Decoder unavailable</strong> \u2014 reload the page once you\u2019re back online.';
      return false;
    }
    return true;
  }

  // ---- real pipeline: decoder -> parsers -> validators -> history --------
  function runPipeline(partialResult) {
    partialResult.parsed = App.parsers.parse(partialResult.rawText);
    partialResult.valid = App.validators.checkChecksum(partialResult);
    partialResult.duplicate = App.validators.isDuplicate(partialResult, App.state.history);

    App.history.add(partialResult);
    App.state.currentResult = partialResult;
    return partialResult;
  }

  // ---- capture panel rendering ---------------------------------------------
  function renderResult(result) {
    els.resultEmpty.hidden = true;
    els.resultBody.hidden = false;
    els.resultReadout.textContent = App.ui.maskWifiRawText(result.rawText, result.parsed);
    els.resultRawText.textContent = result.rawText;

    els.badgeFormat.hidden = false;
    els.badgeFormat.textContent = result.format;

    els.badgeValid.hidden = result.valid !== true;
    els.badgeInvalid.hidden = result.valid !== false;
    els.badgeDupe.hidden = !result.duplicate;

    renderParsedFields(result.parsed);
    els.btnCopyDetails.hidden = describeFields(result.parsed).length === 0;
  }

  function addField(label, value, opts) {
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    if (opts && opts.sensitive) {
      App.ui.renderSensitiveField(dd, value);
    } else if (opts && opts.link) {
      var a = document.createElement('a');
      a.href = value;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = value;
      dd.appendChild(a);
    } else {
      dd.textContent = value;
    }
    els.resultFields.appendChild(dt);
    els.resultFields.appendChild(dd);
  }

  // Pure: turns a parsed result into an ordered list of {label, value, link}
  // field descriptors. Used to render the live capture panel below, and
  // reused as-is by history.js so an expanded History row shows exactly
  // the same fields the live panel would have shown for that scan.
  function describeFields(parsed) {
    var fields = [];
    if (!parsed) return fields;
    var d = parsed.data;

    function push(label, value, opts) {
      fields.push({ label: label, value: value, link: !!(opts && opts.link), sensitive: !!(opts && opts.sensitive) });
    }

    switch (parsed.type) {
      case 'jwt':
        if (d.issuedAt) push('Issued at', d.issuedAt);
        if (d.expiresAt) push('Expires at', d.expiresAt);
        if (d.notBefore) push('Not before', d.notBefore);
        push('Header', JSON.stringify(d.header, null, 2));
        push('Payload', JSON.stringify(d.payload, null, 2));
        break;
      case 'url':
        push('Link', d.href, { link: true });
        push('Domain', d.domain);
        push('Protocol', d.protocol);
        push('Path', d.path || '/');
        break;
      case 'json':
        push('Pretty', d.pretty);
        break;
      case 'vcard':
        if (d.fullName) push('Name', d.fullName);
        if (d.org) push('Org', d.org);
        if (d.phones.length) push('Phone', d.phones.join(', '));
        if (d.emails.length) push('Email', d.emails.join(', '));
        if (d.address) push('Address', d.address);
        break;
      case 'wifi':
        // A malformed WIFI: payload that uses ':' instead of ';' as its
        // field separator (see tryParseWifi in parsers.js) makes the
        // greedy "S:(.*)" capture swallow every later field, including
        // "P:<password>", straight into d.ssid. maskWifiRawText() already
        // guards the raw-text preview against this exact shape; this
        // mirrors the same escaping-aware "P:" detection here so the
        // structured SSID row gets the same protection instead of
        // printing the embedded password in plain text.
        var embeddedPassword = !d.password && /P:((?:\\.|[^;])*)/i.exec(d.ssid);
        push('SSID', d.ssid, { sensitive: !!(embeddedPassword && embeddedPassword[1]) });
        push('Password', d.password || '(none)', { sensitive: !!d.password });
        push('Encryption', d.encryption);
        push('Hidden', d.hidden ? 'Yes' : 'No');
        break;
      case 'base64json':
        push('Decoded (JSON)', d.pretty);
        if (d.segmentCount > 1) {
          push('Token part', 'Segment ' + (d.segmentIndex + 1) + ' of ' + d.segmentCount + ' \u2014 the other part(s) are binary (e.g. a signature) and aren\u2019t human-readable.');
        }
        break;
      case 'base64text':
        push('Decoded', d.decoded);
        if (d.segmentCount > 1) {
          push('Token part', 'Segment ' + (d.segmentIndex + 1) + ' of ' + d.segmentCount + ' \u2014 the other part(s) are binary (e.g. a signature) and aren\u2019t human-readable.');
        }
        break;
      default:
        break;
    }
    return fields;
  }

  function renderParsedFields(parsed) {
    els.resultFields.innerHTML = '';
    describeFields(parsed).forEach(function (f) {
      addField(f.label, f.value, { link: f.link, sensitive: f.sensitive });
    });
  }

  // Exposed so history.js can build an identical fields list for its own
  // inline detail panel, without duplicating (and risking drift from)
  // this switch-case.
  App.ui = App.ui || {};
  App.ui.describeResultFields = describeFields;

  // Pure: curated per-type data for .json export — the JSON counterpart of
  // describeFields() above. Unlike describeFields (which returns
  // display-ready strings for the on-screen panel/.txt/CSV), this returns
  // real structured values, and drops fields that are just redundant
  // re-encodings of the same data (e.g. base64json's `decoded`/`pretty`
  // are string forms of `value` that exist only for display — exporting
  // all three would repeat the same claims data three times over).
  function buildExportData(parsed) {
    if (!parsed) return null;
    var d = parsed.data;
    var out;

    switch (parsed.type) {
      case 'jwt':
        out = { header: d.header, payload: d.payload, signature: d.signature };
        if (d.issuedAt) out.issuedAt = d.issuedAt;
        if (d.expiresAt) out.expiresAt = d.expiresAt;
        if (d.notBefore) out.notBefore = d.notBefore;
        return out;
      case 'url':
        return { href: d.href, domain: d.domain, protocol: d.protocol, path: d.path };
      case 'json':
        return d.value;
      case 'vcard':
        return { fullName: d.fullName, org: d.org, phones: d.phones, emails: d.emails, address: d.address };
      case 'wifi':
        return { ssid: d.ssid, password: d.password, encryption: d.encryption, hidden: d.hidden };
      case 'base64json':
        out = { value: d.value };
        if (d.segmentCount > 1) { out.segmentIndex = d.segmentIndex; out.segmentCount = d.segmentCount; }
        return out;
      case 'base64text':
        out = { decoded: d.decoded };
        if (d.segmentCount > 1) { out.segmentIndex = d.segmentIndex; out.segmentCount = d.segmentCount; }
        return out;
      default:
        return d;
    }
  }

  // Wraps a full result/history-entry object for .json export, swapping in
  // buildExportData() for the raw parsed.data. Keeps every other field
  // (rawText, format, timestamp, valid, duplicate, parsed.type) untouched —
  // only the internal parsed.data plumbing gets curated.
  function buildExportObject(result) {
    if (!result) return result;
    var out = Object.assign({}, result);
    if (result.parsed) {
      out.parsed = Object.assign({}, result.parsed, { data: buildExportData(result.parsed) });
    }
    return out;
  }

  App.ui.buildExportObject = buildExportObject;

  function flashLock() {
    els.viewportWrap.classList.add('is-locked');
    window.setTimeout(function () { els.viewportWrap.classList.remove('is-locked'); }, 550);
  }

  function handleDecodedResult(partialResult) {
    var result = runPipeline(partialResult);
    renderResult(result);
    flashLock();

    if (App.state.settings.vibration && navigator.vibrate) {
      navigator.vibrate(80);
    }

    setViewportStatus('Locked \u2014 ' + result.format);
    window.setTimeout(function () {
      if (scanning) setViewportStatus('Scanning');
    }, LOCK_MS);
  }

  // ---- viewport state ------------------------------------------------------
  function setViewportStatus(text) {
    if (els.viewportStatusLabel) els.viewportStatusLabel.textContent = text;
  }

  function showViewportError(title, body) {
    els.viewportErrorTitle.textContent = title;
    els.viewportErrorBody.textContent = body;
    els.viewportError.classList.add('is-shown');
  }

  function hideViewportError() {
    els.viewportError.classList.remove('is-shown');
  }

  var ERROR_COPY = {
    'permission-denied': {
      title: 'Camera permission denied',
      body: 'Allow camera access in your browser\u2019s site settings, then press the shutter again. You can still upload an image below.'
    },
    'no-camera': {
      title: 'No camera found',
      body: 'This device doesn\u2019t have a usable camera. Upload an image instead using the panel below.'
    },
    unsupported: {
      title: 'Camera not supported',
      body: 'This browser doesn\u2019t support camera access. Upload an image instead using the panel below.'
    },
    'camera-error': {
      title: 'Camera error',
      body: 'The camera couldn\u2019t be started. Close any other app using it and try again, or upload an image instead.'
    }
  };

  // ---- scan loop ------------------------------------------------------------
  function loop() {
    if (!scanning) return;
    App.decoder.decodeFromVideoFrame(els.video).then(function (result) {
      if (!result) return;
      if (!scanning) return; // stopped while this frame's decode was in flight
      if (Date.now() < acceptCooldownUntil) return; // cooling down from the last accepted code

      acceptCooldownUntil = Date.now() + LOCK_MS;
      handleDecodedResult(result);

      // Batch mode off: single-scan behavior — auto-stop after one hit so
      // the result is front-and-center without a manual stop. The delay
      // lets the "Locked — <format>" state (and flashLock's animation) be
      // visible for a moment before the viewport goes idle, instead of
      // stopScanning() stomping over it immediately.
      if (!App.state.settings.batchMode) {
        window.setTimeout(function () {
          if (scanning) stopScanning();
        }, 600);
      }
    });
    rafHandle = requestAnimationFrame(loop);
  }

  async function startScanning() {
    if (!checkDecoderLoaded()) return;

    hideViewportError();
    els.viewportEmpty.hidden = true;
    acceptCooldownUntil = 0;

    try {
      var info = await App.camera.start();
      scanning = true;
      els.viewportWrap.classList.add('is-scanning');
      els.liveDot.classList.add('is-live');
      setViewportStatus('Scanning');
      els.btnToggleScan.classList.add('is-scanning');
      els.btnToggleScan.setAttribute('aria-label', 'Stop scanning');
      els.btnToggleScanIcon.outerHTML = ICON_STOP.replace('<svg', '<svg id="btn-toggle-scan-icon"');
      els.btnToggleScanIcon = document.getElementById('btn-toggle-scan-icon');

      els.btnSwitchCamera.hidden = info.deviceCount < 2;
      els.btnTorch.hidden = !info.torchSupported;

      loop();
    } catch (err) {
      scanning = false;
      els.viewportEmpty.hidden = false;
      var copy = ERROR_COPY[err.code] || ERROR_COPY['camera-error'];
      showViewportError(copy.title, copy.body);
    }
  }

  // Keeps the visual "lit" state and its ARIA equivalent in sync in every
  // place torch state can change (toggled on, scan stopped, camera
  // switched) — a single spot so the two can't drift apart.
  function setTorchVisual(on) {
    els.btnTorch.classList.toggle('is-on', on);
    els.btnTorch.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function stopScanning() {
    scanning = false;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    App.camera.stop();
    els.viewportWrap.classList.remove('is-scanning');
    els.liveDot.classList.remove('is-live');
    els.viewportEmpty.hidden = false;
    setViewportStatus('Idle');
    els.btnToggleScan.classList.remove('is-scanning');
    els.btnToggleScan.setAttribute('aria-label', 'Start scanning');
    els.btnToggleScanIcon.outerHTML = ICON_PLAY.replace('<svg', '<svg id="btn-toggle-scan-icon"');
    els.btnToggleScanIcon = document.getElementById('btn-toggle-scan-icon');
    els.btnSwitchCamera.hidden = true;
    els.btnTorch.hidden = true;
    setTorchVisual(false);
  }

  // Guards against rapid double-tapping the shutter (or the Space
  // shortcut) firing a stop() while a start() is still awaiting the
  // camera, or vice versa — without this, `scanning` and the actual
  // camera stream could end up out of sync with what the button shows.
  var toggleBusy = false;
  async function toggleScanning() {
    if (toggleBusy) return;
    toggleBusy = true;
    try {
      if (scanning) stopScanning(); else await startScanning();
    } finally {
      toggleBusy = false;
    }
  }

  els.btnToggleScan.addEventListener('click', toggleScanning);

  els.btnSwitchCamera.addEventListener('click', async function () {
    try {
      var info = await App.camera.switchCamera();
      if (info) {
        els.btnTorch.hidden = !info.torchSupported;
        setTorchVisual(false);
      } else {
        App.ui.toast('No other camera to switch to.');
      }
    } catch (err) {
      showViewportError('Camera switch failed', 'Could not switch to the other camera.');
    }
  });

  els.btnTorch.addEventListener('click', async function () {
    var on = await App.camera.toggleTorch();
    setTorchVisual(on);
  });

  els.btnBatchMode.addEventListener('click', function () {
    // Flip the underlying state only. settings.js listens for this same
    // click and re-syncs both the Scan-page chip and the Settings-page
    // switch (classList + aria-pressed) via syncBatchModeUI().
    App.state.settings.batchMode = !App.state.settings.batchMode;
  });

  // ---- upload / drag-and-drop -----------------------------------------------
  function handleUploadFile(file) {
    App.decoder.decodeFromImage(file)
      .then(handleDecodedResult)
      .catch(function (err) {
        var messages = {
          'not-an-image': 'That file isn\u2019t an image the browser can read (e.g. a renamed PDF).',
          'bad-image': 'That image looks corrupted and couldn\u2019t be loaded.',
          'no-code-found': 'No code was found in that image. Try better lighting or a tighter crop around the code.',
          'decoder-not-ready': 'The barcode library hasn\u2019t finished loading yet (or failed to load). Check your connection and reload the page.'
        };
        App.ui.toast(messages[err.message] || 'Could not decode that file.', 'danger');
      });
  }

  els.inputUpload.addEventListener('change', function () {
    if (els.inputUpload.files[0]) handleUploadFile(els.inputUpload.files[0]);
    els.inputUpload.value = '';
  });

  ['dragover', 'dragenter'].forEach(function (evt) {
    els.dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      els.dropzone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'dragend'].forEach(function (evt) {
    els.dropzone.addEventListener(evt, function () {
      els.dropzone.classList.remove('is-dragover');
    });
  });
  els.dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    els.dropzone.classList.remove('is-dragover');
    var file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleUploadFile(file);
  });

  // ---- minimal keyboard shortcut (rest live in settings.js) ------------------
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      toggleScanning();
    }
  });

  // ---- result actions ---------------------------------------------------------
  document.getElementById('btn-copy-result').addEventListener('click', function () {
    if (App.state.currentResult) {
      navigator.clipboard.writeText(App.state.currentResult.rawText)
        .then(function () { App.ui.toast('Copied to clipboard.'); })
        .catch(function () {});
    }
  });

  els.btnCopyDetails.addEventListener('click', function () {
    var result = App.state.currentResult;
    if (!result) return;
    var fields = describeFields(result.parsed);
    if (!fields.length) return;
    navigator.clipboard.writeText(App.ui.fieldsToText(fields))
      .then(function () { App.ui.toast('Details copied to clipboard.'); })
      .catch(function () {});
  });

  function downloadResultFile(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // Builds the .txt export body: raw text, plus a readable "Details" summary
  // underneath (reusing the same describeFields() data behind the on-screen
  // panel and CSV export) when the format has any parsed fields.
  function buildTxtExportContent(result) {
    var fields = describeFields(result.parsed);
    if (!fields.length) return result.rawText;
    return result.rawText + '\n\n--- Details ---\n' + App.ui.fieldsToText(fields);
  }

  document.getElementById('btn-export-txt').addEventListener('click', function () {
    var result = App.state.currentResult;
    if (!result) return;
    var filename = 'scan-result-' + App.ui.formatTimestampForFilename(result.timestamp) + '.txt';
    downloadResultFile(filename, buildTxtExportContent(result), 'text/plain');
    App.ui.toast('Exported ' + filename);
  });

  document.getElementById('btn-export-json').addEventListener('click', function () {
    var result = App.state.currentResult;
    if (!result) return;
    var filename = 'scan-result-' + App.ui.formatTimestampForFilename(result.timestamp) + '.json';
    downloadResultFile(filename, JSON.stringify(buildExportObject(result), null, 2), 'application/json');
    App.ui.toast('Exported ' + filename);
  });

  // Sends this result's raw payload + format over to the Generate page,
  // pre-filled (see generator.js's prefill() for why rawText is used
  // verbatim rather than reconstructed from parsed fields).
  document.getElementById('btn-regenerate').addEventListener('click', function () {
    var result = App.state.currentResult;
    if (!result || !App.generator) return;
    App.ui.setView('generate');
    App.generator.prefill(result.rawText, result.format);
    App.ui.toast('Sent to Generate \u2014 tap Generate to recreate it.');
  });

  // ---- run the startup check once the page is ready --------------------------
  checkDecoderLoaded();
})();