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
     window.ScannerApp.history.applyRetention(force)  // added: Split 2a (#4/#12)
       Trims App.state.history (+ IndexedDB) against App.state.settings.retention
       ({ mode: 'none'|'count'|'days', value: number|null }, owned/persisted by
       settings.js — see that file's retention section). Returns the number of
       entries removed. settings.js calls this with force=true right after the
       user changes the setting, so the new rule is visibly applied immediately
       instead of waiting for the next scan.
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
    btnClear: document.getElementById('btn-history-clear'),
    footerDefault: document.getElementById('history-footer'),
    footerSelect: document.getElementById('history-footer-select'),
    btnSelectToggle: document.getElementById('btn-history-select-toggle'),
    btnSelectAll: document.getElementById('btn-history-select-all'),
    btnSelectCancel: document.getElementById('btn-history-select-cancel'),
    btnDeleteSelected: document.getElementById('btn-history-delete-selected'),
    btnExportSelectedCsv: document.getElementById('btn-history-export-selected-csv'),
    btnExportSelectedJson: document.getElementById('btn-history-export-selected-json'),
    selectCount: document.getElementById('history-select-count')
  };

  var knownFormats = [];
  var activeEntry = null;
  var expandedEntry = null;

  // ---- duplicate-count map (backs validators.isDuplicate's O(1) path) -------
  // Map<dupKey, count> instead of a Set, because history intentionally keeps
  // duplicate scans (isDuplicate just flags them, it doesn't block adding),
  // so more than one entry can share the same key — a Set would lose count
  // and could get emptied out by the first matching delete even while a
  // second identical entry is still present.
  if (!(App.state.history._dupKeyCounts instanceof Map)) {
    App.state.history._dupKeyCounts = new Map();
  }

  function dupKeyIncr(entry) {
    var counts = App.state.history._dupKeyCounts;
    var key = App.validators.dupKey(entry);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  function dupKeyDecr(entry) {
    var counts = App.state.history._dupKeyCounts;
    var key = App.validators.dupKey(entry);
    var next = (counts.get(key) || 0) - 1;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
  }

  // ---- bulk select mode -------------------------------------------------------
  // selectMode replaces tap-to-expand with tap-to-select on each row (see
  // buildItem()); expandedEntry is deliberately left alone (not restored)
  // when select mode ends — nothing was relying on it while selecting, and
  // starting select mode fresh with nothing expanded avoids a detail panel
  // interfering with row taps.
  var selectMode = false;
  var selectedEntries = new Set();

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

  // Maps an in-memory entry object -> a Promise that resolves to its
  // IndexedDB key (or null if it was never persisted, e.g. IndexedDB was
  // unavailable at add time). A Promise rather than the bare key because
  // persistAdd()'s write is async — if a bulk delete targets an entry
  // that was scanned moments ago, its key might not have come back from
  // IndexedDB yet; persistDelete() awaits this promise instead of racing
  // it, so a fast select-and-delete can never leave an orphaned row that
  // would silently reappear on the next reload via loadPersisted().
  var entryDbKeys = new WeakMap();

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
    var keyPromise = openDb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).add(result);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      });
    });
    entryDbKeys.set(result, keyPromise);
  }

  // entries: array of in-memory entry objects to remove from IndexedDB.
  // Each one's key is looked up via entryDbKeys — entries with no known
  // key (never persisted) are skipped rather than guessed at.
  function persistDelete(entries) {
    openDb().then(function (db) {
      if (!db) return;
      entries.forEach(function (entry) {
        var keyPromise = entryDbKeys.get(entry);
        if (!keyPromise) return;
        keyPromise.then(function (key) {
          if (key == null) return;
          db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(key);
        });
      });
    });
  }

  function loadPersisted() {
    return openDb().then(function (db) {
      if (!db) return [];
      return new Promise(function (resolve) {
        var entries = [];
        var store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
        var req = store.openCursor();
        req.onsuccess = function (e) {
          var cursor = e.target.result;
          if (!cursor) { resolve(entries); return; }
          entryDbKeys.set(cursor.value, Promise.resolve(cursor.key));
          entries.push(cursor.value);
          cursor.continue();
        };
        req.onerror = function () { resolve([]); };
      });
    });
  }

  // ---- retention / cap (#4, #12) ---------------------------------------------
  // App.state.settings.retention is owned/persisted by settings.js — this file
  // only reads it and does the actual trimming, same division of labor as the
  // rest of the settings <-> history boundary in this app.
  //
  // 'count' mode is O(1) to check (just a length compare) and, once at cap,
  // keeps App.state.history itself bounded at that cap size going forward —
  // so calling this on every add() never reintroduces the O(n)-per-scan cost
  // that Split 1 (#1/#2) fixed; the array can't grow past the cap regardless
  // of how many codes get scanned in a session.
  //
  // 'days' mode can't bound the array size the same way (a busy batch session
  // can log thousands of scans inside a 7/30/90-day window), so checking it
  // on literally every add would re-introduce that same O(n)-per-scan problem.
  // It's throttled to at most once/minute instead — acceptable per this
  // split's own acceptance criteria ("on next add (or on a schedule)"), since
  // newly-added entries are always newer than the cutoff anyway and only
  // cross it as real time passes, not as scan volume increases.
  var lastDaysRetentionCheck = 0;
  var DAYS_RETENTION_CHECK_MIN_INTERVAL_MS = 60 * 1000;

  // entries: array of in-memory entries to remove. Mirrors deleteSelected()'s
  // approach (rebuild the array in place, decrement dup counts, persistDelete,
  // re-render) since trimming is a data-shape delete like any other here.
  function trimEntries(entries) {
    if (!entries.length) return 0;
    var removeSet = new Set(entries);
    var kept = App.state.history.filter(function (e) { return !removeSet.has(e); });
    App.state.history.length = 0;
    Array.prototype.push.apply(App.state.history, kept);
    entries.forEach(dupKeyDecr);
    persistDelete(entries);
    render();
    return entries.length;
  }

  // force=true bypasses the days-mode throttle — used right after load and
  // right after the user changes the retention setting, so a stricter rule
  // takes effect immediately instead of waiting up to a minute.
  function applyRetention(force) {
    var retention = App.state.settings.retention;
    if (!retention || retention.mode === 'none' || !retention.value) return 0;

    if (retention.mode === 'count') {
      var excess = App.state.history.length - retention.value;
      if (excess <= 0) return 0;
      // Array is oldest-first internally (see getFiltered()'s reverse()),
      // so the oldest entries to drop are always at the front.
      return trimEntries(App.state.history.slice(0, excess));
    }

    if (retention.mode === 'days') {
      var now = Date.now();
      if (!force && (now - lastDaysRetentionCheck) < DAYS_RETENTION_CHECK_MIN_INTERVAL_MS) return 0;
      lastDaysRetentionCheck = now;
      var cutoff = now - retention.value * 24 * 60 * 60 * 1000;
      var toRemove = App.state.history.filter(function (e) { return e.timestamp < cutoff; });
      return trimEntries(toRemove);
    }

    return 0;
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

  function updateCounts(filtered) {
    var full = App.state.history;
    var filteredCount = (filtered || getFiltered()).length;
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
    dupKeyIncr(result);
    trackFormat(result.format);

    // Fast path: a full render() rebuilds every row in the list, which
    // gets slower as history grows — a real problem for Batch mode, whose
    // whole purpose is logging many scans in one session. When the new
    // entry would land at the top of the currently-filtered view anyway,
    // just insert that one row instead of rebuilding everything.
    if (matchesCurrentFilter(result)) {
      var emptyRow = document.getElementById('history-empty');
      if (emptyRow) emptyRow.remove();

      // A brand-new entry is always the most recent, so it always belongs
      // at the very top. If the current top-of-list header already covers
      // today, just insert the row under it; otherwise (empty list, or the
      // last scan was on a previous day — e.g. crossing midnight) insert a
      // fresh header too, so the header-per-group invariant render() relies
      // on never drifts out of sync on this fast path.
      var todayKey = App.ui.getDateGroupKey(result.timestamp);
      var topNode = els.list.firstChild;
      var topIsTodayHeader = topNode && topNode.classList &&
        topNode.classList.contains('history-date-header') &&
        Number(topNode.dataset.groupKey) === todayKey;

      if (topIsTodayHeader) {
        els.list.insertBefore(buildItem(result), topNode.nextSibling);
      } else {
        els.list.insertBefore(buildDateHeader(App.ui.getDateGroupLabel(result.timestamp), todayKey), topNode);
        els.list.insertBefore(buildItem(result), topNode);
      }
      var filtered = getFiltered();
      updateCounts(filtered);
      syncSelectFooter(filtered);
    } else {
      render();
    }

    persistAdd(result);
    applyRetention();
  }

  var CLEAR_UNDO_MS = 5000;

  function clear() {
    if (!App.state.history.length) return;
    App.ui.confirm(
      'Clear all ' + App.state.history.length + ' scanned codes from history?'
    ).then(function (ok) {
      if (!ok) return;

      // Snapshot the exact entries being cleared (same object references,
      // so entryDbKeys lookups for them still resolve later either way).
      // Nothing is deleted from IndexedDB yet — only the in-memory list is
      // emptied — so the undo below is a true restore, not a re-scan.
      var snapshot = App.state.history.slice();
      App.state.history.length = 0;
      // Every snapshot entry's count was added via add()'s dupKeyIncr —
      // clearing the whole map here is equivalent to decrementing each of
      // them individually, since nothing else is in history at this point.
      App.state.history._dupKeyCounts.clear();
      render();

      App.ui.toast('History cleared.', null, {
        actionLabel: 'Undo',
        duration: CLEAR_UNDO_MS,
        onAction: function () {
          // Restore in place, ahead of anything scanned during the undo
          // window (add() would have pushed those onto the now-empty
          // array, and the array is oldest-first internally — see
          // getFiltered()'s reverse() — so the snapshot belongs before
          // them, not after).
          var scannedDuringWindow = App.state.history.slice();
          App.state.history.length = 0;
          Array.prototype.push.apply(App.state.history, snapshot);
          Array.prototype.push.apply(App.state.history, scannedDuringWindow);
          // Re-count the restored snapshot entries (their counts were
          // wiped above). scannedDuringWindow entries already went through
          // add()'s dupKeyIncr when they were scanned, so touching them
          // again here would double-count them.
          snapshot.forEach(dupKeyIncr);
          render();
        },
        onExpire: function () {
          // Undo window passed untouched — now actually delete. Uses the
          // same key-scoped persistDelete() Feature 6 built, rather than
          // a blanket IndexedDB store wipe: if a new code was scanned
          // during the undo window, it's already in IndexedDB by now
          // (persistAdd() fires as soon as it's scanned) and must NOT be
          // swept up in this deferred delete.
          persistDelete(snapshot);
        }
      });
    });
  }

  // ---- bulk select mode -------------------------------------------------------
  function toggleSelectMode() {
    selectMode = !selectMode;
    selectedEntries.clear();
    expandedEntry = null;
    // render() below calls syncSelectFooter() itself once it has computed
    // getFiltered() — no need to also call it here first.
    render();
  }

  function exitSelectMode() {
    if (!selectMode) return;
    selectMode = false;
    selectedEntries.clear();
    render();
  }

  function toggleEntrySelected(entry) {
    if (selectedEntries.has(entry)) {
      selectedEntries.delete(entry);
    } else {
      selectedEntries.add(entry);
    }
    render();
  }

  // "Select all" only ever applies to what's currently visible (respects
  // the active search/format filter) — selecting everything in a filtered
  // view shouldn't silently reach into rows the person can't currently see.
  function selectAllToggle() {
    var filtered = getFiltered();
    var allSelected = filtered.length > 0 && filtered.every(function (e) {
      return selectedEntries.has(e);
    });
    filtered.forEach(function (e) {
      if (allSelected) selectedEntries.delete(e);
      else selectedEntries.add(e);
    });
    render();
  }

  // Selected rows in current newest-first list order (rather than Set
  // insertion order), so bulk export stays consistent with the ordering
  // exportCsv()/exportJson() already use for the non-selected case.
  function getSelectedRows() {
    return getFiltered().filter(function (e) { return selectedEntries.has(e); });
  }

  function deleteSelected() {
    var count = selectedEntries.size;
    if (!count) return;
    App.ui.confirm(
      'Delete ' + count + ' selected ' + (count === 1 ? 'code' : 'codes') +
      ' from history? This cannot be undone.'
    ).then(function (ok) {
      if (!ok) return;
      var toDelete = selectedEntries;
      // Mutate App.state.history in place (length=0 then re-push) rather
      // than reassigning App.state.history to a new array — clear() above
      // does the same, since other modules may hold a reference to this
      // exact array instance.
      var kept = App.state.history.filter(function (e) { return !toDelete.has(e); });
      App.state.history.length = 0;
      Array.prototype.push.apply(App.state.history, kept);
      toDelete.forEach(dupKeyDecr);

      persistDelete(Array.from(toDelete));
      selectedEntries.clear();
      selectMode = false;
      render();
      App.ui.toast(count === 1 ? '1 code deleted.' : count + ' codes deleted.');
    });
  }

  function syncSelectFooter(filtered) {
    els.footerDefault.hidden = selectMode;
    els.footerSelect.hidden = !selectMode;
    if (!selectMode) return;

    els.selectCount.textContent = selectedEntries.size === 1
      ? '1 selected'
      : selectedEntries.size + ' selected';

    filtered = filtered || getFiltered();
    var allSelected = filtered.length > 0 && filtered.every(function (e) {
      return selectedEntries.has(e);
    });
    els.btnSelectAll.textContent = allSelected ? 'Deselect all' : 'Select all';

    var hasSelection = selectedEntries.size > 0;
    els.btnDeleteSelected.disabled = !hasSelection;
    els.btnExportSelectedCsv.disabled = !hasSelection;
    els.btnExportSelectedJson.disabled = !hasSelection;
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

    updateCounts(filtered);
    syncSelectFooter(filtered);

    els.list.innerHTML = '';

    if (!full.length) {
      appendEmptyRow('Nothing scanned yet.');
      return;
    }
    if (!filtered.length) {
      appendEmptyRow('No history entries match your search.');
      return;
    }

    // getFiltered() already returns newest-first; walk it once, inserting
    // a sticky date header whenever the day changes instead of repeating
    // the date on every row (each row now shows only a time — see
    // buildItem()).
    var lastGroupKey = null;
    for (var i = 0; i < filtered.length; i++) {
      var entry = filtered[i];
      var groupKey = App.ui.getDateGroupKey(entry.timestamp);
      if (groupKey !== lastGroupKey) {
        els.list.appendChild(buildDateHeader(App.ui.getDateGroupLabel(entry.timestamp), groupKey));
        lastGroupKey = groupKey;
      }
      els.list.appendChild(buildItem(entry));
    }
  }

  // Sticky separator between days' worth of rows. groupKey is stashed on
  // the node itself (rather than recomputed from label text) so add()'s
  // fast path can cheaply check "is the top group already today?" without
  // re-parsing a display string.
  function buildDateHeader(label, groupKey) {
    var li = document.createElement('li');
    li.className = 'history-date-header';
    li.textContent = label;
    li.setAttribute('role', 'separator');
    li.dataset.groupKey = String(groupKey);
    return li;
  }

  function appendEmptyRow(text) {
    var empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.id = 'history-empty';
    empty.textContent = text;
    els.list.appendChild(empty);
  }

  function buildItem(entry) {
    var isSelected = selectMode && selectedEntries.has(entry);
    var item = document.createElement('li');
    item.className = 'history-item' +
      (entry === activeEntry ? ' is-active' : '') +
      (entry === expandedEntry ? ' is-expanded' : '') +
      (selectMode ? ' is-selectable' : '') +
      (isSelected ? ' is-selected' : '');
    var time = (App.ui && App.ui.formatHistoryTime)
      ? App.ui.formatHistoryTime(entry.timestamp)
      : new Date(entry.timestamp).toLocaleTimeString();

    var badges = '';
    if (entry.customLabel) badges += '<span class="badge badge--custom">' + escapeHtml(entry.customLabel) + '</span>';
    if (entry.valid === true) badges += '<span class="badge badge--success">Valid</span>';
    if (entry.valid === false) badges += '<span class="badge badge--danger">Invalid</span>';
    if (entry.duplicate) badges += '<span class="badge badge--warning">Duplicate</span>';

    if (selectMode) {
      // No detail panel is reachable in select mode (expandedEntry is
      // always null while selecting — see toggleSelectMode()), so
      // aria-expanded doesn't apply here; the checkbox below carries the
      // row's selection state instead.
      item.removeAttribute('aria-expanded');
    } else {
      item.setAttribute('aria-expanded', entry === expandedEntry ? 'true' : 'false');
    }

    var checkboxHtml = selectMode
      ? '<input type="checkbox" class="history-select-checkbox" aria-label="Select this entry"' +
        (isSelected ? ' checked' : '') + '>'
      : '';

    item.innerHTML =
      '<div class="history-row1">' +
        checkboxHtml +
        '<span class="history-time mono">' + time + '</span>' +
        '<span class="history-format">' + escapeHtml(entry.format) + '</span>' +
        badges +
      '</div>' +
      '<div class="history-preview">' + escapeHtml(App.ui.maskWifiRawText(entry.rawText, entry.parsed)) + '</div>';

    // Tap a row to expand/collapse its full detail *inline, within History*
    // — unless select mode is active, in which case a tap toggles that
    // row's selection instead (a click on the checkbox itself bubbles up
    // to this same listener, so it's handled by the same branch rather
    // than needing a separate checkbox change listener).
    item.addEventListener('click', function () {
      if (selectMode) {
        toggleEntrySelected(entry);
        return;
      }
      expandedEntry = (expandedEntry === entry) ? null : entry;
      activeEntry = entry;
      render();
    });

    if (!selectMode && entry === expandedEntry) {
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
        if (f.sensitive) {
          App.ui.renderSensitiveField(dd, f.value);
        } else if (f.link) {
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

    // Sends this entry's raw payload + format over to the Generate page,
    // pre-filled (see generator.js's prefill() for why entry.rawText is
    // used verbatim rather than reconstructed from parsed fields — it
    // works for every type this app knows about, and never touches the
    // masked/sensitive on-screen value above, since the mask only ever
    // affects rendered DOM text, not entry.rawText itself).
    var btnRegenerate = document.createElement('button');
    btnRegenerate.className = 'btn btn--sm btn--ghost';
    btnRegenerate.textContent = 'Regenerate';
    btnRegenerate.addEventListener('click', function () {
      if (!App.generator) return;
      App.ui.setView('generate');
      App.generator.prefill(entry.rawText, entry.format);
      App.ui.toast('Sent to Generate \u2014 tap Generate to recreate it.');
    });
    actions.appendChild(btnRegenerate);

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

  function exportCsv(rows) {
    rows = rows || getFiltered();
    if (!rows.length) { App.ui.toast('Nothing to export.'); return; }

    var header = ['timestamp', 'format', 'rawText', 'valid', 'duplicate', 'customLabel', 'details'];
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
        csvEscape(r.customLabel || ''),
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

  function exportJson(rows) {
    rows = rows || getFiltered();
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
  els.btnExportCsv.addEventListener('click', function () { exportCsv(); });
  els.btnExportJson.addEventListener('click', function () { exportJson(); });
  els.btnClear.addEventListener('click', clear);

  els.btnSelectToggle.addEventListener('click', toggleSelectMode);
  els.btnSelectCancel.addEventListener('click', exitSelectMode);
  els.btnSelectAll.addEventListener('click', selectAllToggle);
  els.btnDeleteSelected.addEventListener('click', deleteSelected);
  els.btnExportSelectedCsv.addEventListener('click', function () { exportCsv(getSelectedRows()); });
  els.btnExportSelectedJson.addEventListener('click', function () { exportJson(getSelectedRows()); });

  App.history = {
    add: add,
    clear: clear,
    applyRetention: applyRetention
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
      dupKeyIncr(entry);
      trackFormat(entry.format);
    });
    render();
    // Forced: settings.js has already loaded the saved retention setting
    // synchronously by the time this async callback fires (its script runs
    // right after history.js, well before this IndexedDB promise resolves),
    // so this correctly enforces whatever rule was saved in a prior session
    // — e.g. the cap was lowered since the last visit and IndexedDB still
    // has more entries than the new limit allows.
    applyRetention(true);
  });
})();
