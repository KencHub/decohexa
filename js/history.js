/* ==========================================================================
   history.js
   Owns: storage of App.state.history entries (in-memory array, persisted to
   IndexedDB so it survives a refresh), the History page UI (search, format
   filter, rendering), and export (CSV/JSON) + clearing. Does NOT decode,
   parse, or validate anything — it only receives already-complete result
   objects ({ rawText, format, timestamp, parsed, valid, duplicate }) from
   app.js and takes it from there.

   Public surface (per integration contract — do not rename):
     window.ScannerApp.history.add(result)
     window.ScannerApp.history.clear()
   ========================================================================== */

(function () {
  'use strict';

  var App = window.ScannerApp;

  var els = {
    list: document.getElementById('history-list'),
    count: document.getElementById('history-count'),
    railBadge: document.getElementById('nav-history-badge'),
    search: document.getElementById('history-search'),
    filterFormat: document.getElementById('history-filter-format'),
    btnExportCsv: document.getElementById('btn-history-export-csv'),
    btnExportJson: document.getElementById('btn-history-export-json'),
    btnClear: document.getElementById('btn-history-clear')
  };

  var knownFormats = [];
  var activeEntry = null;
  var expandedEntry = null;

  // ---- persistence (IndexedDB) -----------------------------------------------
  // App.state.history itself stays an in-memory array (everything above reads
  // it directly and expects that) — this section just keeps IndexedDB in sync
  // with it, so a refresh can rehydrate the array instead of starting empty.
  // Chosen over localStorage: history can grow large (batch mode logs every
  // unique code) and entries can carry a few KB of decoded JSON each;
  // IndexedDB stores structured objects directly (no JSON.stringify of the
  // whole array on every scan) and never blocks the main thread.
  // Best-effort throughout: if IndexedDB is unavailable (older browser,
  // private browsing) history still works, it just won't survive a refresh —
  // same degrade-gracefully approach settings.js takes with localStorage.
  var DB_NAME = 'scannerapp';
  var DB_VERSION = 1;
  var STORE_NAME = 'history';
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      var req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        // Out-of-line autoIncrement key — nothing gets written onto the
        // result object itself, so its shape stays exactly what app.js/
        // describeFields/export expect.
        req.result.createObjectStore(STORE_NAME, { autoIncrement: true });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
    return dbPromise;
  }

  function persistAdd(result) {
    openDb().then(function (db) {
      if (!db) return;
      db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).add(result);
    });
  }

  function persistClear() {
    openDb().then(function (db) {
      if (!db) return;
      db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear();
    });
  }

  function loadPersisted() {
    return openDb().then(function (db) {
      if (!db) return [];
      return new Promise(function (resolve) {
        var req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { resolve([]); };
      });
    });
  }

  // ---- public API -----------------------------------------------------------
  function matchesCurrentFilter(entry) {
    var query = (els.search.value || '').trim().toLowerCase();
    var format = els.filterFormat.value;
    if (format && entry.format !== format) return false;
    if (!query) return true;
    return entry.rawText.toLowerCase().indexOf(query) !== -1 ||
           entry.format.toLowerCase().indexOf(query) !== -1;
  }

  function updateCounts() {
    var full = App.state.history;
    var filteredCount = getFiltered().length;
    els.count.textContent = (filteredCount === full.length)
      ? String(full.length)
      : filteredCount + ' / ' + full.length;
    if (els.railBadge) {
      els.railBadge.hidden = full.length === 0;
      els.railBadge.textContent = full.length > 99 ? '99+' : String(full.length);
    }
  }

  function add(result) {
    App.state.history.push(result);
    trackFormat(result.format);

    // Fast path: a full render() rebuilds every row in the list, which
    // gets slower as history grows — a real problem for Batch mode, whose
    // whole purpose is logging many scans in one session. When the new
    // entry would land at the top of the currently-filtered view anyway,
    // just insert that one row instead of rebuilding everything.
    if (matchesCurrentFilter(result)) {
      var emptyRow = document.getElementById('history-empty');
      if (emptyRow) emptyRow.remove();
      els.list.insertBefore(buildItem(result), els.list.firstChild);
      updateCounts();
    } else {
      render();
    }

    persistAdd(result);
  }

  function clear() {
    if (!App.state.history.length) return;
    App.ui.confirm(
      'Clear all ' + App.state.history.length + ' scanned codes from history? This cannot be undone.'
    ).then(function (ok) {
      if (!ok) return;
      App.state.history.length = 0;
      render();
      App.ui.toast('History cleared.');
      persistClear();
    });
  }

  // ---- format filter dropdown -------------------------------------------------
  function trackFormat(format) {
    if (format && knownFormats.indexOf(format) === -1) {
      knownFormats.push(format);
      knownFormats.sort();
      rebuildFormatOptions();
    }
  }

  function rebuildFormatOptions() {
    var current = els.filterFormat.value;
    els.filterFormat.innerHTML = '<option value="">All formats</option>';
    knownFormats.forEach(function (f) {
      var opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      els.filterFormat.appendChild(opt);
    });
    if (current && knownFormats.indexOf(current) !== -1) {
      els.filterFormat.value = current;
    }
  }

  // ---- filtering ------------------------------------------------------------
  function getFiltered() {
    var query = (els.search.value || '').trim().toLowerCase();
    var format = els.filterFormat.value;

    var matches = App.state.history.filter(function (entry) {
      if (format && entry.format !== format) return false;
      if (!query) return true;
      return entry.rawText.toLowerCase().indexOf(query) !== -1 ||
             entry.format.toLowerCase().indexOf(query) !== -1;
    });

    // Newest first. Centralized here (rather than each caller reversing on
    // its own) so render() and the bulk export functions can't drift out
    // of sync with each other.
    matches.reverse();
    return matches;
  }

  // ---- rendering --------------------------------------------------------------
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function render() {
    var full = App.state.history;
    var filtered = getFiltered();

    updateCounts();

    els.list.innerHTML = '';

    if (!full.length) {
      appendEmptyRow('Nothing scanned yet.');
      return;
    }
    if (!filtered.length) {
      appendEmptyRow('No history entries match your search.');
      return;
    }

    // getFiltered() already returns newest-first.
    for (var i = 0; i < filtered.length; i++) {
      els.list.appendChild(buildItem(filtered[i]));
    }
  }

  function appendEmptyRow(text) {
    var empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.id = 'history-empty';
    empty.textContent = text;
    els.list.appendChild(empty);
  }

  function buildItem(entry) {
    var item = document.createElement('li');
    item.className = 'history-item' +
      (entry === activeEntry ? ' is-active' : '') +
      (entry === expandedEntry ? ' is-expanded' : '');
    var time = (App.ui && App.ui.formatHistoryTimestamp)
      ? App.ui.formatHistoryTimestamp(entry.timestamp)
      : new Date(entry.timestamp).toLocaleTimeString();

    var badges = '';
    if (entry.valid === true) badges += '<span class="badge badge--success">Valid</span>';
    if (entry.valid === false) badges += '<span class="badge badge--danger">Invalid</span>';
    if (entry.duplicate) badges += '<span class="badge badge--warning">Duplicate</span>';

    item.setAttribute('aria-expanded', entry === expandedEntry ? 'true' : 'false');

    item.innerHTML =
      '<div class="history-row1">' +
        '<span class="history-time mono">' + time + '</span>' +
        '<span class="history-format">' + escapeHtml(entry.format) + '</span>' +
        badges +
      '</div>' +
      '<div class="history-preview">' + escapeHtml(entry.rawText) + '</div>';

    // Tap a row to expand/collapse its full detail *inline, within History*.
    // History stays a self-contained browsable log; Scan's capture panel
    // only ever reflects the current live session, so browsing history
    // never silently interrupts an in-progress scan or gets confused with
    // a fresh capture.
    item.addEventListener('click', function () {
      expandedEntry = (expandedEntry === entry) ? null : entry;
      activeEntry = entry;
      render();
    });

    if (entry === expandedEntry) {
      item.appendChild(buildDetail(entry));
    }

    return item;
  }

  function buildDetail(entry) {
    var wrap = document.createElement('div');
    wrap.className = 'history-detail';
    // Clicks anywhere in the detail (the raw-text <summary>, action
    // buttons, a parsed link) shouldn't bubble up and collapse the row.
    wrap.addEventListener('click', function (e) { e.stopPropagation(); });

    // Hoisted so the action buttons below (Copy details, .txt export) can
    // reuse the exact same fields the on-screen detail panel shows.
    var fields = (entry.parsed && App.ui && App.ui.describeResultFields)
      ? App.ui.describeResultFields(entry.parsed)
      : [];

    if (fields.length) {
      var dl = document.createElement('dl');
      dl.className = 'capture-card__fields';
      fields.forEach(function (f) {
        var dt = document.createElement('dt');
        dt.textContent = f.label;
        var dd = document.createElement('dd');
        if (f.link) {
          var a = document.createElement('a');
          a.href = f.value;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = f.value;
          dd.appendChild(a);
        } else {
          dd.textContent = f.value;
        }
        dl.appendChild(dt);
        dl.appendChild(dd);
      });
      wrap.appendChild(dl);
    }

    var raw = document.createElement('details');
    raw.className = 'capture-card__raw';
    var summary = document.createElement('summary');
    summary.textContent = 'Raw text';
    var pre = document.createElement('pre');
    pre.className = 'mono';
    pre.textContent = entry.rawText;
    raw.appendChild(summary);
    raw.appendChild(pre);
    wrap.appendChild(raw);

    var actions = document.createElement('div');
    actions.className = 'capture-card__actions';

    var btnCopy = document.createElement('button');
    btnCopy.className = 'btn btn--sm btn--ghost';
    btnCopy.textContent = 'Copy';
    btnCopy.addEventListener('click', function () {
      navigator.clipboard.writeText(entry.rawText)
        .then(function () { App.ui.toast('Copied to clipboard.'); })
        .catch(function () {});
    });

    actions.appendChild(btnCopy);

    if (fields.length) {
      var btnCopyDetails = document.createElement('button');
      btnCopyDetails.className = 'btn btn--sm btn--ghost';
      btnCopyDetails.textContent = 'Copy details';
      btnCopyDetails.addEventListener('click', function () {
        navigator.clipboard.writeText(App.ui.fieldsToText(fields))
          .then(function () { App.ui.toast('Details copied to clipboard.'); })
          .catch(function () {});
      });
      actions.appendChild(btnCopyDetails);
    }

    var btnTxt = document.createElement('button');
    btnTxt.className = 'btn btn--sm btn--ghost';
    btnTxt.textContent = 'Export .txt';
    btnTxt.addEventListener('click', function () {
      var content = fields.length
        ? entry.rawText + '\n\n--- Details ---\n' + App.ui.fieldsToText(fields)
        : entry.rawText;
      var filename = 'scan-result-' + App.ui.formatTimestampForFilename(entry.timestamp) + '.txt';
      download(filename, content, 'text/plain');
      App.ui.toast('Exported ' + filename);
    });

    var btnJson = document.createElement('button');
    btnJson.className = 'btn btn--sm btn--ghost';
    btnJson.textContent = 'Export .json';
    btnJson.addEventListener('click', function () {
      var exportObj = (App.ui && App.ui.buildExportObject) ? App.ui.buildExportObject(entry) : entry;
      var filename = 'scan-result-' + App.ui.formatTimestampForFilename(entry.timestamp) + '.json';
      download(filename, JSON.stringify(exportObj, null, 2), 'application/json');
      App.ui.toast('Exported ' + filename);
    });

    actions.appendChild(btnTxt);
    actions.appendChild(btnJson);
    wrap.appendChild(actions);

    return wrap;
  }

  // ---- export -------------------------------------------------------------------
  function download(filename, content, mime) {
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

  function csvEscape(value) {
    var str = String(value == null ? '' : value);
    if (/[",\n]/.test(str)) str = '"' + str.replace(/"/g, '""') + '"';
    return str;
  }

  // Spreadsheet apps auto-detect all-digit cells (EAN/UPC numbers, etc.) as
  // numbers and render them in lossy scientific notation (e.g. "7E+12"),
  // silently dropping precision. Wrapping as ="..." forces Excel/Sheets/WPS
  // to treat it as text. Only applied where the value could plausibly be
  // read back as a plain number — not on fields like format/valid/duplicate.
  function csvForceText(value) {
    var str = String(value == null ? '' : value);
    if (/^\d+$/.test(str)) return '="' + str + '"';
    return str;
  }

  // CSV-specific details formatting: one line per row instead of the
  // newline-separated block used for Copy details/.txt export, so a details
  // cell doesn't force the whole spreadsheet row to render tall and wrapped.
  function fieldsToCsvText(fields) {
    return fields.map(function (f) { return f.label + ': ' + f.value; }).join(' | ');
  }

  function exportCsv() {
    var rows = getFiltered();
    if (!rows.length) { App.ui.toast('Nothing to export.'); return; }

    var header = ['timestamp', 'format', 'rawText', 'valid', 'duplicate', 'details'];
    var lines = [header.join(',')];
    rows.forEach(function (r) {
      var fields = (r.parsed && App.ui && App.ui.describeResultFields)
        ? App.ui.describeResultFields(r.parsed)
        : [];
      var details = fields.length ? fieldsToCsvText(fields) : '';
      lines.push([
        new Date(r.timestamp).toISOString(),
        csvEscape(r.format),
        csvEscape(csvForceText(r.rawText)),
        r.valid === null ? '' : String(r.valid),
        String(!!r.duplicate),
        csvEscape(details)
      ].join(','));
    });
    // Leading BOM so spreadsheet apps read the file as UTF-8 instead of
    // guessing Latin-1/Windows-1252 and mangling the en-dashes/curly quotes
    // that come through from parsed field text (e.g. "arenâ€™t" instead of "aren't").
    var csvContent = '\uFEFF' + lines.join('\n');
    var filename = 'scan-history-' + App.ui.formatTimestampForFilename(Date.now()) + '.csv';
    download(filename, csvContent, 'text/csv');
    App.ui.toast('Exported ' + filename);
  }

  function exportJson() {
    var rows = getFiltered();
    if (!rows.length) { App.ui.toast('Nothing to export.'); return; }
    var exportRows = (App.ui && App.ui.buildExportObject)
      ? rows.map(App.ui.buildExportObject)
      : rows;
    var filename = 'scan-history-' + App.ui.formatTimestampForFilename(Date.now()) + '.json';
    download(filename, JSON.stringify(exportRows, null, 2), 'application/json');
    App.ui.toast('Exported ' + filename);
  }

  // ---- wiring ------------------------------------------------------------------
  els.search.addEventListener('input', render);
  els.filterFormat.addEventListener('change', render);
  els.btnExportCsv.addEventListener('click', exportCsv);
  els.btnExportJson.addEventListener('click', exportJson);
  els.btnClear.addEventListener('click', clear);

  App.history = {
    add: add,
    clear: clear
  };

  render();

  // Rehydrate from IndexedDB after the first (empty) render, so a refresh
  // shows the previous session's history instead of starting blank. Runs
  // async — any scan added in the brief window before this resolves is
  // still fine, it's already in App.state.history via add() above.
  loadPersisted().then(function (entries) {
    if (!entries.length) return;
    entries.forEach(function (entry) {
      App.state.history.push(entry);
      trackFormat(entry.format);
    });
    render();
  });
})();
