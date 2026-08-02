/* ==========================================================================
   ui.js
   Owns: primary nav / view switching (rail buttons -> .view sections), and
   custom toast + confirm-dialog components that replace window.alert /
   window.confirm everywhere else in the app. No other file should call
   window.alert or window.confirm directly.

   Public surface:
     window.ScannerApp.ui.setView(name)          // 'scan' | 'generate' | 'history'
     window.ScannerApp.ui.toast(message, kind?, opts?)  // kind: 'default' | 'danger'
                                                 // opts: { actionLabel, onAction, onExpire, duration }
                                                 // — onAction fires if the action button is tapped;
                                                 // onExpire fires instead if the toast times out
                                                 // untouched. Exactly one of the two ever fires.
     window.ScannerApp.ui.confirm(message)       -> Promise<boolean>
     window.ScannerApp.ui.describeResultFields    // attached later by app.js;
                                                    // parsed -> [{label,value,link,sensitive}]
     window.ScannerApp.ui.renderSensitiveField(dd, value)     // mask/reveal control for a <dd>
     window.ScannerApp.ui.maskWifiRawText(rawText, parsed)    // masks P:<password> in a raw WIFI: payload
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

  // opts is optional and additive — every pre-existing call site that only
  // passes (message) or (message, kind) behaves exactly as before. Only
  // Feature 7 (undo on "Clear history") passes opts so far.
  function toast(message, kind, opts) {
    if (!toastStack) return;
    opts = opts || {};

    var el = document.createElement('div');
    el.className = 'toast' +
      (kind === 'danger' ? ' toast--danger' : '') +
      (opts.actionLabel ? ' toast--action' : '');

    var textEl = document.createElement('span');
    textEl.className = 'toast__text';
    textEl.textContent = message;
    el.appendChild(textEl);

    // settled guards against both paths firing — either the action button
    // is clicked, or the timer expires untouched, never both.
    var settled = false;

    function hide() {
      el.classList.remove('is-shown');
      window.setTimeout(function () { el.remove(); }, 200);
    }

    if (opts.actionLabel && opts.onAction) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast__action';
      btn.textContent = opts.actionLabel;
      btn.addEventListener('click', function () {
        if (settled) return;
        settled = true;
        window.clearTimeout(hideTimer);
        opts.onAction();
        hide();
      });
      el.appendChild(btn);
    }

    toastStack.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('is-shown'); });
    var hideTimer = window.setTimeout(function () {
      if (settled) return;
      settled = true;
      hide();
      if (opts.onExpire) opts.onExpire();
    }, opts.duration || 3200);
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
  // Masks the P:<password> segment of a raw WiFi QR payload string
  // ("WIFI:T:WPA;S:MySSID;P:MyPassword;;"), for callers that display the
  // raw scanned text by default rather than behind an explicit reveal —
  // History's collapsed-row preview and Scan's always-visible readout
  // (both would otherwise show the password on-screen with zero
  // interaction). No-op for non-WiFi entries. Respects the vCard/WIFI
  // escaping convention (\; \, \: \\) documented in parsers.js, so an
  // escaped ';' inside the password doesn't truncate the match early.
  // Shared so the two callers can't drift out of sync with each other.
  //
  // Deliberately keyed off parsed.type === 'wifi' only, NOT
  // parsed.data.password — a malformed payload that uses ':' instead of
  // ';' as its field separator (e.g. "WIFI:S:MyNet:T:WPA:P:pass123::")
  // fails tryParseWifi()'s field-splitting in parsers.js, so
  // parsed.data.password comes back empty even though the raw string
  // still visibly contains "P:pass123". Running the regex directly
  // against rawText (rather than trusting the structured parse) still
  // catches that case; it's a no-op if there's no "P:" substring to find,
  // so a genuinely password-less WiFi entry is unaffected either way.
  function maskWifiRawText(rawText, parsed) {
    if (!parsed || parsed.type !== 'wifi' || !parsed.data) {
      return rawText;
    }
    var MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    if (parsed.data.password) {
      // A real P: field was structurally isolated by the parser (proper
      // ';'-separated fields). Mask only that field — require it to be
      // preceded by ';' or to be the very first field after 'WIFI:' — so
      // a coincidental "P:" substring elsewhere (e.g. an SSID like
      // "ShopP:5") is never mistaken for the password and left exposed.
      return rawText.replace(/(^WIFI:|;)(P:)((?:\\.|[^;])*)/i, function (match, lead, key, pwd) {
        return pwd ? lead + key + MASK : match;
      });
    }
    // No structural P: field was found — the malformed-colon-separator
    // case this function was originally written for. Fall back to a
    // loose scan so a password-looking fragment isn't left exposed just
    // because parsing couldn't cleanly isolate it.
    return rawText.replace(/P:((?:\\.|[^;])*)/i, function (match, pwd) {
      return pwd ? 'P:' + MASK : match;
    });
  }
  App.ui.maskWifiRawText = maskWifiRawText;

  // Renders a mask/reveal control into the given <dd> for a sensitive field
  // value (e.g. a WiFi password), so it isn't shown in plaintext on-screen
  // or exposed in a casual screenshot by default. Shared by the live Scan
  // result panel (app.js addField) and History's expanded detail
  // (history.js buildDetail) so the two stay behavior-identical instead of
  // drifting. Deliberately NOT used by describeFields()'s text/CSV export
  // consumers (fieldsToText, exportCsv) — an exported file is opened
  // intentionally by the user (often to reuse the credential), so masking
  // it there would just make the export useless.
  function renderSensitiveField(dd, value) {
    dd.classList.add('field-value-sensitive');
    var MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'; // fixed-length bullets — doesn't leak password length either
    var masked = document.createElement('span');
    masked.className = 'field-value-masked';
    masked.textContent = MASK;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'field-reveal-btn';
    btn.textContent = 'Show';
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('aria-pressed', 'false');

    var revealed = false;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      revealed = !revealed;
      masked.textContent = revealed ? value : MASK;
      masked.classList.toggle('field-value-masked--revealed', revealed);
      btn.textContent = revealed ? 'Hide' : 'Show';
      btn.setAttribute('aria-label', revealed ? 'Hide password' : 'Show password');
      btn.setAttribute('aria-pressed', String(revealed));
    });

    dd.appendChild(masked);
    dd.appendChild(btn);
  }
  App.ui.renderSensitiveField = renderSensitiveField;

  function formatHistoryTime(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  App.ui.formatHistoryTime = formatHistoryTime;
})();
