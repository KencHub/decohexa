/* ==========================================================================
   ui.js
   Owns: primary nav / view switching (rail buttons -> .view sections), and
   custom toast + confirm-dialog components that replace window.alert /
   window.confirm everywhere else in the app. No other file should call
   window.alert or window.confirm directly.

   Public surface:
     window.ScannerApp.ui.setView(name)          // 'scan' | 'generate' | 'history'
     window.ScannerApp.ui.toast(message, kind?)  // kind: 'default' | 'danger'
     window.ScannerApp.ui.confirm(message)       -> Promise<boolean>
     window.ScannerApp.ui.describeResultFields    // attached later by app.js;
                                                    // parsed -> [{label,value,link}]
   ========================================================================== */

(function () {
  'use strict';

  var App = window.ScannerApp;
  App.ui = App.ui || {};

  // ---- view switching (scan / generate / history) --------------------------
  var navButtons = Array.prototype.slice.call(document.querySelectorAll('.rail__item[data-view]'));
  var views = Array.prototype.slice.call(document.querySelectorAll('.view[data-view-panel]'));

  // On phones (see styles.css's 720px breakpoint), .rail switches from a
  // left sidebar to a sticky top bar — so any other sticky element below it
  // (currently just History's date-group headers) needs to stick *under*
  // it, not at the same top:0. The bar's height isn't a fixed value in CSS
  // (it scales with font size/icon size), so it's measured here and
  // published as a custom property rather than duplicating a guessed
  // pixel number in styles.css that would silently drift out of sync.
  var railEl = document.querySelector('.rail');
  var mobileNavQuery = window.matchMedia('(max-width: 720px)');

  function syncStickyNavOffset() {
    var isTopBar = mobileNavQuery.matches;
    var h = (isTopBar && railEl) ? railEl.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--sticky-nav-offset', h + 'px');
  }
  syncStickyNavOffset();
  window.addEventListener('resize', syncStickyNavOffset);
  window.addEventListener('orientationchange', syncStickyNavOffset);

  function setView(name) {
    views.forEach(function (v) {
      var active = v.getAttribute('data-view-panel') === name;
      v.classList.toggle('is-active', active);
      v.hidden = !active;
    });
    navButtons.forEach(function (b) {
      var active = b.getAttribute('data-view') === name;
      b.classList.toggle('is-active', active);
      if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  navButtons.forEach(function (b) {
    b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
  });

  App.ui.setView = setView;

  // ---- toast -----------------------------------------------------------------
  var toastStack = document.getElementById('toast-stack');

  function toast(message, kind) {
    if (!toastStack) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'danger' ? ' toast--danger' : '');
    el.textContent = message;
    toastStack.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('is-shown'); });
    window.setTimeout(function () {
      el.classList.remove('is-shown');
      window.setTimeout(function () { el.remove(); }, 200);
    }, 3200);
  }
  App.ui.toast = toast;

  // ---- confirm (promise-based, replaces window.confirm) ----------------------
  var confirmScrim = document.getElementById('confirm-scrim');
  var confirmModal = document.getElementById('confirm-modal');
  var confirmMessage = document.getElementById('confirm-modal-message');
  var confirmOk = document.getElementById('confirm-modal-ok');
  var confirmCancel = document.getElementById('confirm-modal-cancel');
  var pendingResolve = null;

  function openConfirm(message) {
    confirmMessage.textContent = message;
    confirmScrim.classList.add('is-open');
    confirmModal.classList.add('is-open');
    confirmOk.focus();
    return new Promise(function (resolve) { pendingResolve = resolve; });
  }
  function closeConfirm(result) {
    confirmScrim.classList.remove('is-open');
    confirmModal.classList.remove('is-open');
    if (pendingResolve) { pendingResolve(result); pendingResolve = null; }
  }
  confirmOk.addEventListener('click', function () { closeConfirm(true); });
  confirmCancel.addEventListener('click', function () { closeConfirm(false); });
  confirmScrim.addEventListener('click', function () { closeConfirm(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && confirmModal.classList.contains('is-open')) closeConfirm(false);
  });

  App.ui.confirm = openConfirm;

  // ---- shared export helpers --------------------------------------------------
  // Used by every export/download point in the app (live result panel and
  // .txt/.json export in app.js, per-row + bulk export in history.js, PNG
  // download in generator.js) so filenames follow one consistent, readable,
  // collision-resistant pattern instead of four different ad-hoc schemes.
  function formatTimestampForFilename(ts) {
    var d = new Date(ts == null ? Date.now() : ts);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }
  App.ui.formatTimestampForFilename = formatTimestampForFilename;

  // Turns a describeResultFields()-style [{label, value}] array into a plain
  // -text block, e.g. "SSID: MyNetwork\nPassword: pass123". Shared by
  // "Copy details" and the .txt export summary section so both stay in sync.
  function fieldsToText(fields) {
    return fields.map(function (f) { return f.label + ': ' + f.value; }).join('\n');
  }
  App.ui.fieldsToText = fieldsToText;

  // Formats a timestamp for display in the History list: shows just the time
  // for entries from today, "Yesterday" + time for yesterday, and a full
  // date + time for anything older — so two entries at the same clock time
  // on different days are never visually indistinguishable.
  function formatHistoryTimestamp(ts) {
    var d = new Date(ts);
    var now = new Date();
    var time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    var dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var entryStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dayDiff = Math.round((dayStart - entryStart) / 86400000);

    if (dayDiff === 0) return time;
    if (dayDiff === 1) return 'Yesterday, ' + time;
    var sameYear = d.getFullYear() === now.getFullYear();
    var dateLabel = d.toLocaleDateString(undefined, sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
    return dateLabel + ', ' + time;
  }
  App.ui.formatHistoryTimestamp = formatHistoryTimestamp;

  // Label for a History sticky date-group header ("Today", "Yesterday", or
  // a short date) — the day-level counterpart to formatHistoryTimestamp,
  // used once per group instead of repeated on every row.
  function getDateGroupLabel(ts) {
    var d = new Date(ts);
    var now = new Date();
    var dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var entryStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dayDiff = Math.round((dayStart - entryStart) / 86400000);

    if (dayDiff === 0) return 'Today';
    if (dayDiff === 1) return 'Yesterday';
    var sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(undefined, sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
  }
  App.ui.getDateGroupLabel = getDateGroupLabel;

  // Numeric day-bucket key for the same grouping getDateGroupLabel()
  // describes. Labels alone aren't safely comparable across renders (two
  // different years' "Mar 3" would collide), so history.js uses this to
  // detect when consecutive rows cross a day boundary.
  function getDateGroupKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  App.ui.getDateGroupKey = getDateGroupKey;

  // Time-only stamp for individual History rows, now that the day context
  // lives in the sticky group header above them instead of on every row.
  function formatHistoryTime(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  App.ui.formatHistoryTime = formatHistoryTime;
})();
