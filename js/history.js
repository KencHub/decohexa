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
     window.ScannerApp.history.getRecent(n)  // added: Split 4b (#18)
       Returns up to n entries from App.state.history, newest first. Read-only
       helper for the Scan-page "last few scans" strip (app.js) — doesn't touch
       selection/expansion state or the DOM.
     window.ScannerApp.history.focusEntry(entry)  // added: Split 4b (#18)
       Expands `entry` in the History list and scrolls it into view, clearing
       the active search/format filter first if either is currently hiding it.
       Caller must switch to the History view (App.ui.setView('history')) BEFORE
       calling this — it measures/scrolls the real list, which only has a
       meaningful (non-zero) layout once its view is visible.

   Event (added: Split 4b, #18):
     window 'scannerapp:historychange' — dispatched (no detail payload; listen
     and re-read App.state.history / call getRecent() as needed) after every
     change to App.state.history: add, clear (+ its undo/expire), bulk/single
     delete (+ its undo/expire), retention trimming, and IndexedDB rehydration
     on load. Exists so other views (currently just the Scan-page recent-scans
     strip in app.js) can stay in sync with History without polling or being
     the ones to call render() themselves — this file remains the only writer
     of App.state.history, everyone else just listens.

   List virtualization (Split 2b, #3):
   The History list only builds real DOM nodes for rows near the viewport;
   everything else is represented purely as height in two spacer <li>s
   (topSpacer/bottomSpacer) so the page's scrollable height stays correct.
   Kept self-contained in this file (rather than a separate virtualList.js)
   because the per-row height logic is intrinsically tied to this list's two
   row kinds (date header vs. entry, and an entry's height depends on
   selectMode/expandedEntry) — factoring that out would mean exposing
   buildItem/buildDateHeader/expandedEntry/selectMode as public surface to a
   second file for no real gain. See the "list virtualization" section below
   for the mechanics.

   This app has no inner scrolling container for the list (.history-list
   sits in normal document flow; the sticky date headers rely on the
   *window* being the scroll container — see styles.css's comment above
   .history-list). Virtualization here is therefore driven by window
   scroll/resize, not a container's scrollTop.
   ========================================================================== */

(function () {
  'use strict';

  var App = window.ScannerApp;

  var els = {
    list: document.getElementById('history-list'),
    count: document.getElementById('history-count'),
    railBadge: document.getElementById('nav-history-badge'),
    search: document.getElementById('history-search'),
    searchClear: document.getElementById('history-search-clear'),
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

  // ---- historychange event (Split 4b, #18) ------------------------------------
  // Dispatched after every mutation of App.state.history. See the file-level
  // comment above for the full contract. A plain window CustomEvent (no
  // detail payload) rather than a callback registry, since this file has no
  // reason to track its listeners — window events are the same pattern
  // App.ui already uses for resize/orientationchange, so this doesn't
  // introduce a new convention.
  var HISTORY_CHANGE_EVENT = 'scannerapp:historychange';
  function fireHistoryChange() {
    window.dispatchEvent(new CustomEvent(HISTORY_CHANGE_EVENT));
  }

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

  // ---- pending-persistence tracking + unload guard ---------------------------
  // persistAdd()/persistDelete() are fire-and-forget from their callers'
  // point of view — fine for normal one-at-a-time usage, but a large burst
  // (thousands of scans, or clearing/trimming a large history) can queue
  // far more IndexedDB work than can commit before a person naturally
  // refreshes or closes the tab. Anything still in flight at that moment is
  // silently abandoned by the browser, deletes included — confirmed via a
  // standalone reproduction against this exact file: right after a 3000-add
  // burst with a 500-entry retention cap, the on-screen count was already
  // trimmed to 500, but the underlying IndexedDB store still held nearly
  // all 3000 rows — the "trimmed" rows' delete requests just hadn't
  // committed yet, and would have been lost by a refresh at that point.
  // This tracks how many persistAdd/persistDelete operations are still
  // outstanding and warns before unload if any are, so leaving mid-backlog
  // becomes a deliberate choice instead of invisible data loss.
  var pendingPersistCount = 0;
  function trackPending(promise) {
    pendingPersistCount++;
    var done = function () { pendingPersistCount--; };
    promise.then(done, done);
    return promise;
  }
  window.addEventListener('beforeunload', function (e) {
    if (pendingPersistCount > 0) {
      e.preventDefault();
      e.returnValue = ''; // required by some browsers to actually show the prompt
    }
  });

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
    trackPending(keyPromise);
  }

  // entries: array of in-memory entry objects to remove from IndexedDB.
  // Each one's key is looked up via entryDbKeys — entries with no known
  // key (never persisted) are skipped rather than guessed at.
  //
  // Batches every delete into a SINGLE IndexedDB transaction instead of one
  // transaction per entry (the original approach). For a bulk delete of
  // hundreds/thousands of rows (Clear, Delete selected, retention
  // trimming), that cuts the number of separate transactions the browser
  // has to serialize and commit from N down to 1 — this is what actually
  // lets a big delete finish fast enough to reliably beat a person
  // refreshing, instead of trickling out one commit at a time behind
  // whatever else is still queued (see the tracking comment above
  // entryDbKeys for how that showed up as a real bug).
  //
  // Returns a Promise that resolves once the transaction has actually
  // committed (or failed/aborted, best-effort either way — same tolerance
  // as before), tracked via trackPending() so the unload guard above knows
  // to warn if a refresh would abandon it mid-flight.
  function persistDelete(entries) {
    var work = openDb().then(function (db) {
      if (!db) return;
      return Promise.all(entries.map(function (entry) {
        var keyPromise = entryDbKeys.get(entry);
        return keyPromise || Promise.resolve(null);
      })).then(function (keys) {
        var validKeys = keys.filter(function (k) { return k != null; });
        if (!validKeys.length) return;
        return new Promise(function (resolve) {
          var tx = db.transaction(STORE_NAME, 'readwrite');
          var store = tx.objectStore(STORE_NAME);
          validKeys.forEach(function (key) { store.delete(key); });
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
          tx.onabort = function () { resolve(); };
        });
      });
    });
    return trackPending(work);
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
    fireHistoryChange();
    // scheduleRender(), not render() directly: applyRetention() (this
    // function's only caller) runs its count-mode check on every add(),
    // so once history is at/over a saved retention cap, a burst of adds
    // (Batch mode, or the earlier stress-test) would trim and therefore
    // render() on every single add() — reopening the exact freeze the
    // add()/scheduleRender() fix above was meant to close, just via a
    // different path. Deferring by up to one frame here is imperceptible
    // for the single-call cases too (settings-change, startup enforcement)
    // since their toast text is built from this function's synchronous
    // return value, not from the DOM having already re-rendered.
    scheduleRender();
    return entries.length;
  }

  // force=true bypasses the days-mode throttle — used right after load and
  // right after the user changes the retention setting, so a stricter rule
  // takes effect immediately instead of waiting up to a minute.
  // How much slack to allow past the cap in count-mode before actually
  // trimming. trimEntries() rebuilds the array (filter + Set), which costs
  // O(current length) per call. Enforcing the cap exactly on every single
  // add() once at/over it meant every add() from that point on paid that
  // O(length) cost again — for a sustained burst of M scans past the cap,
  // that's O(M × cap) total work, not O(M). Confirmed: a 3000-add burst
  // with a 500-entry cap already reached did ~1.5 million filter
  // iterations across 3000 separate array rebuilds (plus a matching
  // persistDelete()/IndexedDB transaction per trim) — enough to visibly
  // freeze a real tab, exactly the kind of per-add cost the add()
  // render-coalescing fix above was meant to eliminate, just reintroduced
  // via a different path.
  // Fix: let the array grow up to this many entries past the cap before
  // trimming, then trim back down to the cap exactly in one pass —
  // amortizes the O(cap) cost over many adds instead of paying it on
  // every one. force=true (user changes the setting, or the once-per-load
  // startup enforcement) bypasses the slack and trims immediately, same
  // as the existing days-mode force bypass, so a user-initiated
  // tightening still takes visible effect right away.
  var COUNT_RETENTION_SLACK = 50;

  function applyRetention(force) {
    var retention = App.state.settings.retention;
    if (!retention || retention.mode === 'none' || !retention.value) return 0;

    if (retention.mode === 'count') {
      var excess = App.state.history.length - retention.value;
      if (excess <= 0) return 0;
      if (!force && excess < COUNT_RETENTION_SLACK) return 0;
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

  // ---- recent-scans strip support (Split 4b, #18) ----------------------------
  // getRecent() is a plain read — no interaction with selectMode/expandedEntry
  // or the DOM, safe to call at any time (including before the first render()
  // or while History is hidden).
  function getRecent(n) {
    var full = App.state.history;
    var out = [];
    for (var i = full.length - 1; i >= 0 && out.length < n; i--) {
      out.push(full[i]);
    }
    return out;
  }

  function isEntryUnderCurrentFilters(entry) {
    return getFiltered().indexOf(entry) !== -1;
  }

  // Mirrors the --sticky-nav-offset custom property ui.js publishes (see
  // its syncStickyNavOffset()) — used below so a scrolled-to row doesn't
  // land underneath the sticky top nav bar on phones.
  function getStickyNavOffsetPx() {
    var raw = getComputedStyle(document.documentElement).getPropertyValue('--sticky-nav-offset');
    var n = parseFloat(raw);
    return isNaN(n) ? 0 : n;
  }

  // Scrolls the *window* (this list's actual scroll container — see the
  // file-level comment on why) so the row at currentFlatItems[idx] lands
  // just under the sticky nav / sticky date header, using the same
  // cumulative-offset math the virtualization window itself uses. Letting
  // the resulting native scroll event drive renderVisibleWindow() (via the
  // existing scroll listener) rather than forcing a window into existence
  // here directly — that keeps this function from having to duplicate the
  // overscan/pinned-header logic renderVisibleWindow() already owns.
  function scrollListToFlatIndex(idx) {
    if (idx < 0 || idx >= currentFlatItems.length) return;
    var offsets = buildOffsets();
    var rect = els.list.getBoundingClientRect();
    var listDocTop = window.scrollY + rect.top;
    var target = listDocTop + offsets[idx] - (getStickyNavOffsetPx() + 12);
    window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }

  // Jumps straight to `entry` in the History list: expanded, and scrolled
  // into view. See the file-level comment for the "caller must setView
  // first" contract — this measures the real list's layout, which only
  // means anything once the History view is actually visible.
  function focusEntry(entry) {
    if (!entry || App.state.history.indexOf(entry) === -1) return;

    // Select mode has no detail panel to expand into (see toggleSelectMode)
    // — exit it first rather than silently doing nothing.
    if (selectMode) {
      selectMode = false;
      selectedEntries.clear();
    }

    // Only touch search/filter if they're actually hiding the entry —
    // clearing them unconditionally would be a surprising side effect for
    // an entry the person could already see.
    if (!isEntryUnderCurrentFilters(entry)) {
      els.search.value = '';
      syncSearchClearVisibility();
      els.filterFormat.value = '';
      els.filterFormat.dispatchEvent(new Event('scannerapp:syncselect'));
    }

    expandedEntry = entry;
    activeEntry = entry;
    render();

    var idx = -1;
    for (var i = 0; i < currentFlatItems.length; i++) {
      var row = currentFlatItems[i];
      if (row.type === 'item' && row.entry === entry) { idx = i; break; }
    }
    scrollListToFlatIndex(idx);
  }

  // ---- public API -----------------------------------------------------------
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

    // Split 1 (#2) added a fast path here that inserted one DOM row
    // directly instead of calling a full render(), because render() used
    // to rebuild every row in the list — a real problem for Batch mode.
    // Split 2b's virtualization made that unnecessary in terms of DOM
    // size, since render() only ever builds DOM for the small on-screen
    // window regardless of history size. BUT render() also forces a
    // synchronous layout every time (measureRenderedRows reads
    // offsetHeight), and add() calling it directly, once per add(),
    // meant a tight burst of adds — Batch mode, or a stress-test loop —
    // still forced that layout once per scan with zero yielding back to
    // the browser in between. Confirmed on-device: 3000 synchronous
    // add() calls in a row froze a mobile browser tab.
    // Fix: scheduleRender() coalesces any number of add() calls within
    // the same animation frame into a single render() call. For real
    // usage (one scan at a time, human-paced) this is imperceptible —
    // still renders within ~16ms. For a burst, it collapses N calls into
    // one render() no matter how large N is.
    scheduleRender();

    persistAdd(result);
    applyRetention();
    fireHistoryChange();
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
      fireHistoryChange();

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
          fireHistoryChange();
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

  var DELETE_UNDO_MS = 5000; // same window as Clear's CLEAR_UNDO_MS, kept as
  // its own constant rather than reusing that one — this path (partial
  // deletes: bulk-select and single-row swipe) shouldn't be coupled to
  // Clear's own tuning going forward even though they start equal today.

  // Shared delete/undo path for #10 (bulk delete, deleteSelected() below)
  // and #11 (single-row swipe delete, see attachSwipeHandlers()). Both
  // remove a *subset* of App.state.history — unlike clear(), which always
  // empties everything — so undo has to put each removed entry back in its
  // original relative position among the entries that stayed, not just
  // prepend or append them; a partial delete undo that reordered the list
  // would be a visible correctness bug, not just a cosmetic one.
  //
  // Does not show its own confirm() — callers decide whether the action
  // needs confirming up front. deleteSelected() still confirms, since it's
  // a bulk action that can remove many rows at once; the single swipe
  // delete doesn't, since the Undo toast itself already covers the "oops"
  // case for one row without an extra tap.
  function removeEntriesWithUndo(entries, opts) {
    opts = opts || {};
    if (!entries.length) return;

    // Snapshot the full array (not just `entries`) in its current relative
    // order — this is what lets undo restore each deleted entry to its
    // original position relative to the entries that stayed, rather than
    // just appending them back at the end.
    var beforeSnapshot = App.state.history.slice();
    var toDeleteSet = new Set(entries);
    var kept = beforeSnapshot.filter(function (e) { return !toDeleteSet.has(e); });

    // Mutate App.state.history in place (length=0 then re-push) rather than
    // reassigning it to a new array — other modules may hold a reference to
    // this exact array instance (same approach clear() uses).
    App.state.history.length = 0;
    Array.prototype.push.apply(App.state.history, kept);
    entries.forEach(dupKeyDecr);
    render();
    fireHistoryChange();

    App.ui.toast(opts.message || 'Deleted.', null, {
      actionLabel: 'Undo',
      duration: DELETE_UNDO_MS,
      onAction: function () {
        // Anything present in App.state.history now but not in `kept` was
        // added during the undo window (add() only ever pushes), so it's
        // strictly newer than everything being restored and belongs after
        // it either way.
        var keptSet = new Set(kept);
        var addedDuringWindow = App.state.history.filter(function (e) { return !keptSet.has(e); });

        App.state.history.length = 0;
        // beforeSnapshot already holds the deleted entries in their correct
        // relative position among the survivors — restoring from it (rather
        // than kept.concat(entries)) is what actually satisfies "original
        // position, not prepended."
        Array.prototype.push.apply(App.state.history, beforeSnapshot);
        Array.prototype.push.apply(App.state.history, addedDuringWindow);
        entries.forEach(dupKeyIncr);
        render();
        fireHistoryChange();
      },
      onExpire: function () {
        // Same reasoning as Clear's undo: only these specific entries' rows
        // get deleted from IndexedDB, not a blanket wipe, so anything
        // scanned during the undo window (already persisted via its own
        // persistAdd() call) is left untouched.
        persistDelete(entries);
      }
    });
  }

  function deleteSelected() {
    var count = selectedEntries.size;
    if (!count) return;
    App.ui.confirm(
      'Delete ' + count + ' selected ' + (count === 1 ? 'code' : 'codes') + ' from history?'
    ).then(function (ok) {
      if (!ok) return;
      var toDelete = Array.from(selectedEntries);
      selectedEntries.clear();
      selectMode = false;
      removeEntriesWithUndo(toDelete, {
        message: count === 1 ? '1 code deleted.' : count + ' codes deleted.'
      });
    });
  }

  // Single-row delete triggered by the swipe gesture (#11). No confirm
  // dialog — see the note above removeEntriesWithUndo() for why.
  function deleteSingleEntry(entry) {
    removeEntriesWithUndo([entry], { message: 'Code deleted.' });
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

  // ---- search indexing --------------------------------------------------------
  // Search used to only check entry.rawText + entry.format, which meant two
  // things visible right on screen were unfindable: custom labels (the
  // "label Test" tags), and — for anything wrapped in an extra decode step
  // (json/base64json/jwt) — the human-readable decoded content, since only
  // the undecoded raw string (e.g. a Base64 blob) was ever checked.
  //
  // Fix: build one combined lowercased "search index" string per entry that
  // also includes customLabel and, where applicable, the decoded/pretty
  // content. Deliberately EXCLUDES the WiFi password: it's dot-masked in the
  // UI on purpose, and letting search match its plaintext (which sits right
  // inside rawText, e.g. "WIFI:T:WPA;S:...;P:secret;;") would quietly punch
  // a hole through that masking. Everything else about a WiFi entry (SSID,
  // encryption, etc.) is still fully searchable via rawText as before.
  //
  // Cached in a WeakMap (not a property on the entry itself) so it: (a)
  // costs nothing until an entry is actually searched, (b) never gets
  // rebuilt on every keystroke, and (c) can never leak into CSV/JSON export
  // or IndexedDB persistence, both of which copy the entry's own enumerable
  // fields directly. Entries are immutable after add() (customLabel is set
  // once, before add() is ever called — see settings.js) so a single cached
  // value per entry is always safe, no invalidation needed.
  var searchIndexCache = new WeakMap();

  function buildSearchIndex(entry) {
    var parts = [entry.rawText, entry.format];
    if (entry.customLabel) parts.push(entry.customLabel);

    var parsed = entry.parsed;
    if (parsed) {
      if (parsed.type === 'wifi' && parsed.data && parsed.data.password) {
        // Strip the password out of the rawText copy already in parts[0] —
        // do it here (once, cached) rather than reaching back into
        // entry.rawText anywhere else, so the entry itself is untouched.
        parts[0] = parts[0].split(parsed.data.password).join('');
      } else if ((parsed.type === 'json' || parsed.type === 'base64json') && parsed.data) {
        parts.push(parsed.data.pretty);
      } else if (parsed.type === 'jwt' && parsed.data) {
        parts.push(JSON.stringify(parsed.data.header), JSON.stringify(parsed.data.payload));
      }
    }

    return parts.join(' ').toLowerCase();
  }

  function getSearchIndex(entry) {
    var cached = searchIndexCache.get(entry);
    if (cached !== undefined) return cached;
    var index = buildSearchIndex(entry);
    searchIndexCache.set(entry, index);
    return index;
  }

  // ---- custom search-clear button -------------------------------------------
  // Only shown once there's something to clear. Called both on user typing
  // and after any programmatic reset of els.search.value (e.g. focusEntry()
  // above), since setting .value in JS doesn't fire an 'input' event to
  // trigger this automatically — same underlying gotcha as the dropdown
  // repaint issue elsewhere in this app, just for a plain <input> instead of
  // the custom-select wrapper.
  function syncSearchClearVisibility() {
    if (els.searchClear) els.searchClear.hidden = !els.search.value;
  }

  // ---- filtering ------------------------------------------------------------
  function getFiltered() {
    var query = (els.search.value || '').trim().toLowerCase();
    var format = els.filterFormat.value;

    var matches = App.state.history.filter(function (entry) {
      if (format && entry.format !== format) return false;
      if (!query) return true;
      return getSearchIndex(entry).indexOf(query) !== -1;
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

  // Coalesces bursts of render() requests into one per animation frame.
  // Used by add() (see its comment for why: a tight burst of adds — Batch
  // mode, or a stress-test loop — was calling render() once per add() with
  // no yielding in between, and render() forces a synchronous layout, which
  // froze the page). Other callers (search, filter, delete, clear, undo,
  // select mode, expand/collapse) still call render() directly, since a
  // single user action rendering immediately is exactly what should happen
  // — only add()'s burst case needed coalescing.
  var pendingRenderFrame = null;
  function scheduleRender() {
    if (pendingRenderFrame) return;
    pendingRenderFrame = window.requestAnimationFrame(function () {
      pendingRenderFrame = null;
      render();
    });
  }

  function render() {
    // A direct render() call makes any still-pending scheduled one (from
    // scheduleRender()) redundant — cancel it so a burst of adds followed
    // immediately by e.g. a search keystroke doesn't render twice in a row.
    if (pendingRenderFrame) {
      window.cancelAnimationFrame(pendingRenderFrame);
      pendingRenderFrame = null;
    }

    var full = App.state.history;
    var filtered = getFiltered();

    updateCounts(filtered);
    syncSelectFooter(filtered);

    if (!full.length) {
      currentFlatItems = [];
      teardownWindow();
      appendEmptyRow('Nothing scanned yet.');
      return;
    }
    if (!filtered.length) {
      currentFlatItems = [];
      teardownWindow();
      appendEmptyRow('No history entries match your search.');
      return;
    }

    // getFiltered() already returns newest-first; walk it once, building a
    // flat list of rows (date headers + entries) instead of DOM nodes —
    // renderVisibleWindow() below turns the on-screen slice of *this* into
    // real elements. Every row still gets exactly one header per group,
    // same invariant as before, just expressed as data instead of DOM.
    var flat = [];
    var lastGroupKey = null;
    for (var i = 0; i < filtered.length; i++) {
      var entry = filtered[i];
      var groupKey = App.ui.getDateGroupKey(entry.timestamp);
      if (groupKey !== lastGroupKey) {
        flat.push({ type: 'header', groupKey: groupKey, label: App.ui.getDateGroupLabel(entry.timestamp) });
        lastGroupKey = groupKey;
      }
      flat.push({ type: 'item', entry: entry });
    }
    currentFlatItems = flat;
    renderVisibleWindow(true);
  }

  // ---- list virtualization (Split 2b, #3) -------------------------------------
  // Only rows within OVERSCAN_PX of the viewport get real DOM nodes; the
  // rest of the list's height is represented by two spacer <li>s so the
  // page's scrollable height (and the sticky date-header math, which relies
  // on normal document flow) stays correct without every row existing in
  // the DOM at once.
  //
  // Height of a given row isn't known in advance (badges can wrap onto a
  // second line, and an expanded entry's detail panel is a different
  // height per entry) — heights are measured after each real render and
  // cached, keyed by the entry object itself (stable across re-renders,
  // since App.state.history holds the same objects). An entry can need two
  // different cached heights (collapsed vs. its own expanded height), so
  // the cache stores both and picks the right one based on current state.
  // Rows not yet measured fall back to a fixed estimate; the estimate only
  // has to be close enough for smooth scrolling, since it self-corrects to
  // the real height the first time that row is actually rendered.
  //
  // Sticky-header fix: .history-date-header uses position:sticky, which
  // only pins while the element actually exists in the DOM. The windowing
  // above only keeps rows within OVERSCAN_PX of the viewport — so once you
  // scroll more than ~600px past a date header, its row used to get culled
  // entirely and the sticky header simply vanished (nothing left to pin).
  // Fix: renderVisibleWindow() always finds the nearest header at or
  // before the visible window's start row and, if that header isn't
  // already part of the window, renders one extra copy of it right above
  // the window (with its own gap spacer, midSpacer, covering the culled
  // rows in between) so position:sticky always has a live anchor.
  var currentFlatItems = [];       // rebuilt by render(): [{type:'header',...}|{type:'item',...}]
  var itemHeightCache = new Map(); // entry -> { collapsed?: px, expanded?: px }
  var headerHeightCache = new Map(); // groupKey -> px
  var DEFAULT_ITEM_HEIGHT = 74;
  var DEFAULT_EXPANDED_HEIGHT = 320;
  var DEFAULT_HEADER_HEIGHT = 34;
  var OVERSCAN_PX = 600; // render this many extra px of rows above/below the viewport
  var renderedRange = { start: -1, end: -1, pinnedIdx: -1 };
  var topSpacer = null;
  var midSpacer = null;   // gap between a pinned header and the visible window, when they're not adjacent
  var bottomSpacer = null;
  var pinnedHeaderEl = null; // the currently-anchored sticky header, when rendered separately from the window
  var pendingFrame = null;
  // render() calls made while the History view is hidden (e.g. a scan
  // added from the Scan page) still update currentFlatItems, but the DOM
  // window is left untouched (no point laying out a hidden list) and
  // renderedRange is left stale. This flag forces one full rebuild the
  // next time the view becomes visible, so a stale-but-numerically-equal
  // range can never be mistaken for "nothing to do" and skipped.
  var wasHidden = false;

  function heightOfRow(row) {
    if (row.type === 'header') {
      return headerHeightCache.get(row.groupKey) || DEFAULT_HEADER_HEIGHT;
    }
    var isExpanded = !selectMode && row.entry === expandedEntry;
    var rec = itemHeightCache.get(row.entry);
    if (rec) {
      if (isExpanded && rec.expanded) return rec.expanded;
      if (!isExpanded && rec.collapsed) return rec.collapsed;
    }
    return isExpanded ? DEFAULT_EXPANDED_HEIGHT : DEFAULT_ITEM_HEIGHT;
  }

  // offsets[i] = cumulative height of currentFlatItems[0..i-1]; offsets[n]
  // is the total (virtual) list height. O(n) over the *filtered* row count,
  // same order as getFiltered()'s own filter+reverse pass — negligible
  // next to that, and only walks a plain cached-height array, not the DOM.
  function buildOffsets() {
    var n = currentFlatItems.length;
    var offsets = new Array(n + 1);
    offsets[0] = 0;
    for (var i = 0; i < n; i++) {
      offsets[i + 1] = offsets[i] + heightOfRow(currentFlatItems[i]);
    }
    return offsets;
  }

  // Returns the largest row index i such that offsets[i] <= target (i.e.
  // the row that "covers" that cumulative-height position), clamped to a
  // valid row index.
  function findRowAtOffset(offsets, target) {
    var lo = 0, hi = offsets.length - 2;
    if (hi < 0) return 0;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= target) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function ensureSpacers() {
    if (!topSpacer) {
      topSpacer = document.createElement('li');
      topSpacer.className = 'history-vlist-spacer';
      topSpacer.setAttribute('aria-hidden', 'true');
    }
    if (!midSpacer) {
      midSpacer = document.createElement('li');
      midSpacer.className = 'history-vlist-spacer';
      midSpacer.setAttribute('aria-hidden', 'true');
    }
    if (!bottomSpacer) {
      bottomSpacer = document.createElement('li');
      bottomSpacer.className = 'history-vlist-spacer';
      bottomSpacer.setAttribute('aria-hidden', 'true');
    }
  }

  function teardownWindow() {
    renderedRange = { start: -1, end: -1, pinnedIdx: -1 };
    pinnedHeaderEl = null;
  }

  // Reads the *current* (pre-update) position of the list in the viewport
  // to decide which rows should be visible. Deliberately computed before
  // any DOM changes this pass makes — see the long comment on add() above
  // for why that self-corrects positions correctly even when new rows are
  // inserted above the current window.
  function computeVisibleRange() {
    var n = currentFlatItems.length;
    if (!n) return null;
    var rect = els.list.getBoundingClientRect();
    var viewportTop = Math.max(0, -rect.top - OVERSCAN_PX);
    var viewportBottom = -rect.top + window.innerHeight + OVERSCAN_PX;

    var offsets = buildOffsets();
    var total = offsets[n];
    if (viewportBottom > total) viewportBottom = total;

    var start = findRowAtOffset(offsets, viewportTop);
    var end = findRowAtOffset(offsets, Math.max(viewportTop, viewportBottom));
    start = Math.max(0, Math.min(start, n - 1));
    end = Math.max(start, Math.min(end, n - 1));
    return { start: start, end: end, offsets: offsets, total: total };
  }

  // pinnedIdx/needsPinnedCopy describe whether a header is being rendered
  // separately, above the window, as a sticky anchor (see the fix comment
  // above heightOfRow). When it is, topSpacer only needs to cover rows
  // *before* that header, and midSpacer covers the gap between the header
  // and the window's first rendered row.
  function updateSpacerHeights(layout, pinnedIdx, needsPinnedCopy) {
    ensureSpacers();
    if (needsPinnedCopy) {
      topSpacer.style.height = layout.offsets[pinnedIdx] + 'px';
      midSpacer.style.height = Math.max(0, layout.offsets[layout.start] - layout.offsets[pinnedIdx + 1]) + 'px';
    } else {
      topSpacer.style.height = layout.offsets[layout.start] + 'px';
    }
    bottomSpacer.style.height = Math.max(0, layout.total - layout.offsets[layout.end + 1]) + 'px';
  }

  // Reads the actual laid-out height of each just-rendered row and updates
  // the height cache. Run right after inserting the window into the real
  // DOM, so an expanded entry's detail panel (already part of the node
  // buildItem() returns — see its is-expanded branch) is measured in its
  // final state with no extra layout pass needed.
  function measureRenderedRows(start, end, startNode) {
    var node = startNode;
    for (var i = start; i <= end && node && node !== bottomSpacer; i++, node = node.nextSibling) {
      var row = currentFlatItems[i];
      var h = node.offsetHeight;
      if (!h) continue;
      if (row.type === 'header') {
        headerHeightCache.set(row.groupKey, h);
      } else {
        var isExpanded = !selectMode && row.entry === expandedEntry;
        var rec = itemHeightCache.get(row.entry) || {};
        if (isExpanded) rec.expanded = h; else rec.collapsed = h;
        itemHeightCache.set(row.entry, rec);
      }
    }
  }

  // Measures the separately-rendered pinned header copy (see fix comment
  // above heightOfRow). Kept distinct from measureRenderedRows since it's
  // a single element outside the [start,end] loop, not part of that range.
  function measurePinnedHeader(pinnedIdx) {
    if (!pinnedHeaderEl) return;
    var h = pinnedHeaderEl.offsetHeight;
    if (!h) return;
    headerHeightCache.set(currentFlatItems[pinnedIdx].groupKey, h);
  }

  // force=true (render()'s callers: search/filter change, add, delete,
  // expand/collapse, select mode) always rebuilds the on-screen DOM, since
  // the *content* for the same index range may have changed even when the
  // index range itself hasn't (e.g. expanding a row that's already
  // visible). force=false (the scroll/resize scheduler below) only
  // rebuilds when the visible index range actually changed, since nothing
  // else could have.
  function renderVisibleWindow(force) {
    if (els.list.offsetParent === null) { wasHidden = true; return; } // not visible right now
    if (wasHidden) { force = true; wasHidden = false; }
    if (!currentFlatItems.length) return;

    var layout = computeVisibleRange();
    if (!layout) return;

    // Nearest header at or before the window's first row — this is the
    // one that *should* currently be pinned at the top of the viewport.
    // If it's not already inside [start,end] it would otherwise have been
    // culled entirely, taking the sticky pin with it (see fix comment
    // above heightOfRow) — so render one extra copy of it above the
    // window instead.
    var pinnedIdx = -1;
    for (var p = layout.start; p >= 0; p--) {
      if (currentFlatItems[p].type === 'header') { pinnedIdx = p; break; }
    }
    var needsPinnedCopy = pinnedIdx !== -1 && pinnedIdx < layout.start;

    var sameRange = layout.start === renderedRange.start && layout.end === renderedRange.end;
    var samePinned = pinnedIdx === renderedRange.pinnedIdx;
    if (!force && sameRange && samePinned) {
      updateSpacerHeights(layout, pinnedIdx, needsPinnedCopy);
      return;
    }
    renderedRange = { start: layout.start, end: layout.end, pinnedIdx: pinnedIdx };

    ensureSpacers();
    var frag = document.createDocumentFragment();
    for (var i = layout.start; i <= layout.end; i++) {
      var row = currentFlatItems[i];
      frag.appendChild(row.type === 'header'
        ? buildDateHeader(row.label, row.groupKey)
        : buildItem(row.entry));
    }

    els.list.innerHTML = '';
    els.list.appendChild(topSpacer);
    if (needsPinnedCopy) {
      var headerRow = currentFlatItems[pinnedIdx];
      pinnedHeaderEl = buildDateHeader(headerRow.label, headerRow.groupKey);
      els.list.appendChild(pinnedHeaderEl);
      els.list.appendChild(midSpacer);
    } else {
      pinnedHeaderEl = null;
    }
    els.list.appendChild(frag);
    els.list.appendChild(bottomSpacer);
    updateSpacerHeights(layout, pinnedIdx, needsPinnedCopy);

    measureRenderedRows(layout.start, layout.end, needsPinnedCopy ? midSpacer.nextSibling : topSpacer.nextSibling);
    if (needsPinnedCopy) measurePinnedHeader(pinnedIdx);
  }

  function scheduleWindowUpdate() {
    if (pendingFrame) return;
    pendingFrame = window.requestAnimationFrame(function () {
      pendingFrame = null;
      renderVisibleWindow(false);
    });
  }

  window.addEventListener('scroll', scheduleWindowUpdate, { passive: true });
  window.addEventListener('resize', scheduleWindowUpdate);
  // Catches the History view going from hidden (display:none, 0 height) to
  // visible when the user switches tabs — that's a resize of els.list from
  // history.js's point of view even though nothing in this file triggered
  // it (ui.js owns the tab switch), so it needs its own observer rather
  // than relying on the window 'resize' listener above.
  if (window.ResizeObserver) {
    new ResizeObserver(scheduleWindowUpdate).observe(els.list);
  }

  // Sticky separator between days' worth of rows. groupKey is stashed on
  // the node itself so heightOfRow()/measureRenderedRows() can cache its
  // height without re-parsing a display string.
  function buildDateHeader(label, groupKey) {
    var li = document.createElement('li');
    li.className = 'history-date-header';
    li.textContent = label;
    li.setAttribute('role', 'separator');
    li.dataset.groupKey = String(groupKey);
    return li;
  }

  function appendEmptyRow(text) {
    els.list.innerHTML = '';
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

    // Row content lives in its own translatable wrapper rather than
    // directly in the <li> — the swipe-to-delete gesture (#11, below)
    // slides *this* element left to reveal a delete action sitting behind
    // it at the <li> level, without disturbing the <li>'s own layout
    // height (which drives the virtualization height cache).
    var content = document.createElement('div');
    content.className = 'history-item__content';
    content.innerHTML =
      '<div class="history-row1">' +
        checkboxHtml +
        '<span class="history-time mono">' + time + '</span>' +
        '<span class="history-format">' + escapeHtml(entry.format) + '</span>' +
        badges +
      '</div>' +
      '<div class="history-preview">' + escapeHtml(App.ui.maskWifiRawText(entry.rawText, entry.parsed)) + '</div>';
    item.appendChild(content);

    // Swipe-to-delete (#11) — mobile only (gated on pointerType==='touch'
    // inside attachSwipeHandlers), disabled while selectMode is active,
    // since select mode already gives tap-on-row its own meaning
    // (toggle selection) and the two gestures shouldn't compete over what
    // a touch on a row means.
    if (!selectMode) {
      var swipeAction = document.createElement('div');
      swipeAction.className = 'history-item__swipe-action';
      swipeAction.setAttribute('aria-hidden', 'true');
      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'history-item__delete-btn';
      deleteBtn.textContent = 'Delete';
      // Sits behind the (opaque) content wrapper until revealed by a
      // swipe, so it shouldn't be in the normal tab order until then.
      deleteBtn.tabIndex = -1;
      deleteBtn.addEventListener('click', function (e) {
        e.stopPropagation(); // don't also trigger the row's own click handler below
        closeSwipe(item, content, false);
        deleteSingleEntry(entry);
      });
      swipeAction.appendChild(deleteBtn);
      item.appendChild(swipeAction);
      attachSwipeHandlers(item, content, entry);
    }

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
      if (item === swipeOpenItem) {
        // A tap while this row's delete action is revealed closes the
        // swipe instead of also expanding the row underneath it — mirrors
        // the swipe-row behavior of most mobile mail/messaging apps, and
        // avoids one tap doing two different things at once.
        closeSwipe(item, content, true);
        return;
      }
      if (item.dataset.suppressClick === '1') {
        // A real swipe drag (not a tap) just ended on this row — see
        // attachSwipeHandlers(). Treat the click the browser synthesizes
        // afterward as part of that gesture, not a fresh tap-to-expand.
        delete item.dataset.suppressClick;
        return;
      }
      expandedEntry = (expandedEntry === entry) ? null : entry;
      activeEntry = entry;
      render();
    });

    if (!selectMode && entry === expandedEntry) {
      content.appendChild(buildDetail(entry));
    }

    return item;
  }

  // ---- swipe-to-delete (#11) --------------------------------------------------
  // Touch-only (see the pointerType guard in attachSwipeHandlers): mouse/pen
  // interaction with a row is untouched, still handled entirely by the
  // click listener in buildItem() above.
  var SWIPE_REVEAL_PX = 76;          // matches .history-item__swipe-action width
  var SWIPE_MAX_DRAG_PX = 96;        // small rubber-band past fully-open
  var SWIPE_MOVE_THRESHOLD_PX = 10;  // ignore jitter below this as "not a swipe"
  var SWIPE_OPEN_SNAP_RATIO = 0.4;   // open if dragged past 40% of reveal width
  var swipeOpenItem = null;          // the one currently-revealed <li>, so
                                      // opening a new row auto-closes the last one

  function closeSwipe(item, content, animate) {
    if (!animate) content.style.transition = 'none';
    content.style.transform = 'translateX(0px)';
    item.classList.remove('is-swipe-open');
    if (swipeOpenItem === item) swipeOpenItem = null;
    if (!animate) {
      // Force layout so this instant close doesn't get coalesced with a
      // later, genuinely-animated transform change on the same element.
      void content.offsetHeight;
      content.style.transition = '';
    }
  }

  function openSwipe(item, content) {
    if (swipeOpenItem && swipeOpenItem !== item) {
      var prevContent = swipeOpenItem.querySelector('.history-item__content');
      if (prevContent) closeSwipe(swipeOpenItem, prevContent, true);
    }
    content.style.transform = 'translateX(-' + SWIPE_REVEAL_PX + 'px)';
    item.classList.add('is-swipe-open');
    swipeOpenItem = item;
  }

  // Attaches the swipe gesture to a single row. Uses Pointer Events (not
  // raw touch events) so the same listeners work whether the browser
  // routes touch through pointer or touch APIs, but every handler bails
  // immediately for any pointerType other than 'touch' — mouse/pen users
  // get exactly the pre-existing click-only behavior, unchanged.
  function attachSwipeHandlers(item, content, entry) {
    var startX = 0, startY = 0, startTransform = 0;
    var dragging = false, decided = false, horizontal = false;

    item.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'touch') return;
      startX = e.clientX;
      startY = e.clientY;
      startTransform = (item === swipeOpenItem) ? -SWIPE_REVEAL_PX : 0;
      dragging = true;
      decided = false;
      horizontal = false;
      content.style.transition = 'none';
    });

    item.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerType !== 'touch') return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;

      if (!decided) {
        if (Math.abs(dx) < SWIPE_MOVE_THRESHOLD_PX && Math.abs(dy) < SWIPE_MOVE_THRESHOLD_PX) return;
        decided = true;
        horizontal = Math.abs(dx) > Math.abs(dy);
        if (!horizontal) {
          // Predominantly vertical movement: this is a page scroll, not a
          // swipe. Stop tracking the gesture entirely and let the browser's
          // native scrolling (touch-action: pan-y in CSS) handle it.
          dragging = false;
          return;
        }
        item.dataset.suppressClick = '1';
      }
      if (!horizontal) return;

      e.preventDefault(); // we're driving the horizontal motion ourselves now
      var next = startTransform + dx;
      if (next > 0) next = 0;
      if (next < -SWIPE_MAX_DRAG_PX) next = -SWIPE_MAX_DRAG_PX;
      content.style.transform = 'translateX(' + next + 'px)';
    }, { passive: false });

    function finishDrag(e) {
      if (!dragging) return;
      dragging = false;
      if (!decided || !horizontal) return; // was a tap, or handed off to vertical scroll

      var dx = (typeof e.clientX === 'number' ? e.clientX : startX) - startX;
      var finalX = startTransform + dx;
      var shouldOpen = finalX < -(SWIPE_REVEAL_PX * SWIPE_OPEN_SNAP_RATIO);
      content.style.transition = '';
      if (shouldOpen) openSwipe(item, content); else closeSwipe(item, content, true);
      // suppressClick is normally consumed by the click listener in
      // buildItem(); this is a fallback in case no click event follows
      // (e.g. pointercancel), so the flag can't linger and wrongly
      // swallow some unrelated future tap on this row.
      window.setTimeout(function () { delete item.dataset.suppressClick; }, 0);
    }

    item.addEventListener('pointerup', finishDrag);
    item.addEventListener('pointercancel', finishDrag);
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
  els.search.addEventListener('input', function () {
    syncSearchClearVisibility();
    render();
  });
  if (els.searchClear) {
    els.searchClear.addEventListener('click', function () {
      els.search.value = '';
      syncSearchClearVisibility();
      els.search.focus();
      render();
    });
  }
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
    applyRetention: applyRetention,
    getRecent: getRecent,
    focusEntry: focusEntry
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
    // has more entries than the new limit allows. applyRetention() fires
    // its own historychange event if it actually trims anything; fired
    // unconditionally here too, since even a no-op retention check still
    // means rehydration itself changed App.state.history from empty to
    // populated — app.js's recent-scans strip (#18) needs to hear about
    // that regardless of whether retention did anything.
    applyRetention(true);
    fireHistoryChange();
  });
})();