/* ==========================================================================
   settings.js
   Owns: the settings panel (open/close), the theme/sound/vibration/batch-mode
   switches, custom regex prefix rules (add/list/remove + auto-label on match),
   and keyboard shortcuts for desktop use. Does NOT decode, parse, validate,
   or manage history storage — those stay with their owning files.

   Public surface (per integration contract — do not rename):
     window.ScannerApp.settings.applyShortcuts()
     window.ScannerApp.settings.toggle(key)   // key: 'sound' | 'vibration' | 'batchMode' | 'theme'

   NOTES:
   1) Space is intentionally not bound here — app.js's own listener already
      owns start/stop scanning on Space; binding it again would double-toggle.
   2) Custom regex rules stay a lightweight overlay on top of the documented
      result shape: the raw text is checked against saved rules *after* the
      normal decode -> parse -> validate -> history pipeline finishes, and a
      small extra badge is shown alongside the format/valid/duplicate badges.
   3) Both light and dark themes are defined natively in css/styles.css via
      html[data-theme]/body[data-theme], so no runtime stylesheet injection
      is needed.
   ========================================================================== */

(function () {
  'use strict';

  var App = window.ScannerApp;
  App.state.settings.rules = App.state.settings.rules || [];

  var els = {
    btnSettings: document.getElementById('btn-settings'),
    btnSettingsClose: document.getElementById('btn-settings-close'),
    scrim: document.getElementById('settings-scrim'),
    drawer: document.getElementById('settings-drawer'),

    switchTheme: document.getElementById('switch-theme'),
    switchSound: document.getElementById('switch-sound'),
    switchVibration: document.getElementById('switch-vibration'),
    switchBatch: document.getElementById('switch-batch'),
    btnBatchModeMain: document.getElementById('btn-batch-mode'),

    ruleName: document.getElementById('settings-rule-name'),
    ruleRegex: document.getElementById('settings-rule-regex'),
    ruleTest: document.getElementById('settings-rule-test'),
    ruleTestResult: document.getElementById('settings-rule-test-result'),
    btnAddRule: document.getElementById('btn-add-rule'),
    ruleList: document.getElementById('settings-rule-list'),

    selectRetention: document.getElementById('settings-retention-mode'),

    storageCount: document.getElementById('settings-storage-count'),
    storageSize: document.getElementById('settings-storage-size')
  };

  var RULES_STORAGE_KEY = 'scannerapp_custom_rules';
  var THEME_STORAGE_KEY = 'scannerapp_theme';
  var SOUND_STORAGE_KEY = 'scannerapp_sound';
  var VIBRATION_STORAGE_KEY = 'scannerapp_vibration';
  var BATCH_MODE_STORAGE_KEY = 'scannerapp_batch_mode';
  var RETENTION_STORAGE_KEY = 'scannerapp_retention';

  // ---- panel open/close -----------------------------------------------------
  function openPanel() {
    els.drawer.classList.add('is-open');
    els.scrim.classList.add('is-open');
    updateStorageIndicator();
  }
  function closePanel() {
    els.drawer.classList.remove('is-open');
    els.scrim.classList.remove('is-open');
  }
  if (els.btnSettings) els.btnSettings.addEventListener('click', openPanel);
  if (els.btnSettingsClose) els.btnSettingsClose.addEventListener('click', closePanel);
  if (els.scrim) els.scrim.addEventListener('click', closePanel);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && els.drawer.classList.contains('is-open')) closePanel();
  });

  // ---- generic switch visual sync --------------------------------------------
  function setSwitchVisual(el, on) {
    if (!el) return;
    el.classList.toggle('is-on', !!on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  function syncBatchModeUI() {
    var on = App.state.settings.batchMode;
    setSwitchVisual(els.switchBatch, on);
    if (els.btnBatchModeMain) {
      els.btnBatchModeMain.classList.toggle('is-on', on);
      els.btnBatchModeMain.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    // Covers both entry points to batchMode changing: the drawer switch
    // (via toggle() below) and the shutter-bar button, which app.js flips
    // on App.state.settings.batchMode directly and then calls this same
    // function to resync — see the btnBatchModeMain listener further down.
    try { window.localStorage.setItem(BATCH_MODE_STORAGE_KEY, on ? '1' : '0'); } catch (err) { /* storage unavailable */ }
  }

  function applyTheme() {
    var isDark = App.state.settings.theme === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    document.body.setAttribute('data-theme', isDark ? 'dark' : 'light');
    setSwitchVisual(els.switchTheme, isDark);
  }

  // ---- toggle(key): the one documented public mutator ------------------------
  function toggle(key) {
    var s = App.state.settings;
    if (key === 'theme') {
      s.theme = s.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      try { window.localStorage.setItem(THEME_STORAGE_KEY, s.theme); } catch (err) { /* storage unavailable */ }
      return s.theme;
    }
    if (key === 'sound' || key === 'vibration' || key === 'batchMode') {
      s[key] = !s[key];
      if (key === 'sound') {
        setSwitchVisual(els.switchSound, s.sound);
        try { window.localStorage.setItem(SOUND_STORAGE_KEY, s.sound ? '1' : '0'); } catch (err) { /* storage unavailable */ }
      }
      if (key === 'vibration') {
        setSwitchVisual(els.switchVibration, s.vibration);
        try { window.localStorage.setItem(VIBRATION_STORAGE_KEY, s.vibration ? '1' : '0'); } catch (err) { /* storage unavailable */ }
      }
      if (key === 'batchMode') syncBatchModeUI();
      return s[key];
    }
    return undefined;
  }

  if (els.switchTheme) els.switchTheme.addEventListener('click', function () { toggle('theme'); });
  if (els.switchSound) els.switchSound.addEventListener('click', function () { toggle('sound'); });
  if (els.switchVibration) els.switchVibration.addEventListener('click', function () { toggle('vibration'); });
  if (els.switchBatch) els.switchBatch.addEventListener('click', function () { toggle('batchMode'); });

  // Keep the panel's batch switch synced with the main shutter-bar toggle,
  // which app.js wires independently and flips App.state.settings.batchMode
  // itself. Deferred a tick so this runs after that handler updates state.
  if (els.btnBatchModeMain) {
    els.btnBatchModeMain.addEventListener('click', function () {
      window.setTimeout(syncBatchModeUI, 0);
    });
  }

  // ---- history retention (#12; trimming itself lives in history.js) ---------
  // Stored as a single plain string ("none" / "count:500" / "days:30") rather
  // than JSON, since the <select>'s own option values already are that string
  // — no serialize/parse mismatch to keep in sync.
  var RETENTION_DEFAULT = 'none';

  function parseRetentionValue(str) {
    if (!str || str === 'none') return { mode: 'none', value: null };
    var parts = str.split(':');
    var mode = parts[0];
    var value = parseInt(parts[1], 10);
    if ((mode !== 'count' && mode !== 'days') || !value || value <= 0) {
      return { mode: 'none', value: null };
    }
    return { mode: mode, value: value };
  }

  function persistRetention(str) {
    try { window.localStorage.setItem(RETENTION_STORAGE_KEY, str); } catch (err) { /* storage unavailable */ }
  }

  function loadRetentionValue() {
    try {
      var raw = window.localStorage.getItem(RETENTION_STORAGE_KEY);
      // Validate against the select's actual <option> values rather than
      // trusting the stored string outright, in case a future build removes
      // an option a past session saved.
      if (raw && els.selectRetention && Array.prototype.some.call(els.selectRetention.options, function (o) { return o.value === raw; })) {
        return raw;
      }
    } catch (err) { /* storage unavailable */ }
    return RETENTION_DEFAULT;
  }

  if (els.selectRetention) {
    els.selectRetention.addEventListener('change', function () {
      var value = els.selectRetention.value;
      App.state.settings.retention = parseRetentionValue(value);
      persistRetention(value);

      // Forced, so a newly-tightened rule (e.g. switching from "Keep
      // everything" to "Keep last 500") visibly trims right away instead of
      // waiting for the next scan or the days-mode throttle window.
      var removed = (App.history && typeof App.history.applyRetention === 'function')
        ? App.history.applyRetention(true)
        : 0;

      if (removed > 0) {
        App.ui.toast(removed === 1
          ? 'Removed 1 old entry to match the new retention setting.'
          : 'Removed ' + removed + ' old entries to match the new retention setting.');
      } else {
        // Every other case — loosening the cap, picking a setting that
        // doesn't need to trim anything right now, or (rare) App.history
        // not being available yet — previously gave zero feedback here.
        // The setting itself always saves correctly regardless
        // (persistRetention() above already ran), but with no visible
        // confirmation a real, successful change looked identical to
        // nothing having happened. Always confirm the save, reading the
        // option's own visible text so the toast matches exactly what
        // the dropdown now shows.
        var opt = els.selectRetention.options[els.selectRetention.selectedIndex];
        App.ui.toast('History retention set to: ' + (opt ? opt.textContent : value));
      }
    });
  }

  // ---- #17: storage usage indicator ------------------------------------------
  // Read-only — no writes to localStorage/IndexedDB. Entry count comes
  // straight from App.state.history.length (kept in sync with IndexedDB by
  // history.js itself, including after rehydration on load), so that number
  // is exact, not an estimate. Byte usage is a genuine estimate (the
  // StorageManager API reports the whole origin's storage, not just this
  // app's IndexedDB store, and browsers are explicitly allowed to round/fuzz
  // it for fingerprinting resistance) — labeled as such rather than implying
  // precision it doesn't have.
  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return null;
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var value = bytes;
    var unitIndex = -1;
    do {
      value /= 1024;
      unitIndex++;
    } while (value >= 1024 && unitIndex < units.length - 1);
    return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[unitIndex];
  }

  function updateStorageIndicator() {
    if (els.storageCount) {
      var count = (App.state.history && App.state.history.length) || 0;
      els.storageCount.textContent = count === 1 ? '1 entry' : (count + ' entries');
    }

    if (!els.storageSize) return;

    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
      els.storageSize.textContent = 'Storage size estimate not supported in this browser.';
      return;
    }

    navigator.storage.estimate().then(function (est) {
      if (!els.storageSize) return; // panel/DOM could theoretically be gone by now
      var used = formatBytes(est && est.usage);
      els.storageSize.textContent = used
        ? ('~' + used + ' used on this device (estimate)')
        : 'Storage usage estimate unavailable.';
    }).catch(function () {
      if (els.storageSize) els.storageSize.textContent = 'Storage usage estimate unavailable.';
    });
  }

  // Keep the indicator live while the panel is open too (not just on next
  // open) — cheap to recompute and matches how every other history-derived
  // UI (recent-scans strip, History page itself) already stays in sync via
  // this same event rather than polling.
  window.addEventListener('scannerapp:historychange', updateStorageIndicator);

  // ---- custom regex prefix rules ---------------------------------------------
  function persistRules() {
    try {
      window.localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(App.state.settings.rules));
    } catch (err) { /* storage unavailable — rules still work for this session */ }
  }

  function loadRules() {
    try {
      var raw = window.localStorage.getItem(RULES_STORAGE_KEY);
      if (raw) App.state.settings.rules = JSON.parse(raw);
    } catch (err) {
      App.state.settings.rules = [];
    }
  }

  function renderRuleList() {
    if (!els.ruleList) return;
    els.ruleList.innerHTML = '';
    App.state.settings.rules.forEach(function (rule) {
      var li = document.createElement('li');
      li.className = 'rule-item';

      var info = document.createElement('span');
      info.className = 'rule-item__label';
      info.textContent = rule.label;
      var pattern = document.createElement('span');
      pattern.className = 'rule-item__pattern mono';
      pattern.textContent = rule.pattern;
      info.appendChild(pattern);

      var btnRemove = document.createElement('button');
      btnRemove.className = 'btn btn--sm btn--danger-ghost';
      btnRemove.textContent = 'Remove';
      btnRemove.addEventListener('click', function () {
        App.state.settings.rules = App.state.settings.rules.filter(function (r) { return r.id !== rule.id; });
        persistRules();
        renderRuleList();
      });

      li.appendChild(info);
      li.appendChild(btnRemove);
      els.ruleList.appendChild(li);
    });
  }

  // ---- #16: regex test sandbox ------------------------------------------
  // Purely a live preview against els.ruleRegex/els.ruleTest — reads state,
  // never writes App.state.settings.rules. Independent of addRule()'s own
  // try/catch (which still runs on submit) so an invalid pattern is caught
  // and explained inline as the user types, not just on click.
  function updateRegexSandbox() {
    if (!els.ruleTestResult) return;
    var pattern = (els.ruleRegex && els.ruleRegex.value || '').trim();
    var testStr = els.ruleTest ? (els.ruleTest.value || '') : '';
    var el = els.ruleTestResult;

    el.className = 'regex-sandbox__result';

    if (!pattern) {
      el.textContent = '';
      return;
    }

    var re;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      el.textContent = 'Invalid pattern: ' + err.message;
      el.classList.add('is-invalid');
      return;
    }

    if (!testStr) {
      el.textContent = 'Valid pattern \u2014 type a test string above to try it live.';
      el.classList.add('is-idle');
      return;
    }

    if (re.test(testStr)) {
      el.textContent = '\u2713 Matches';
      el.classList.add('is-match');
    } else {
      el.textContent = '\u2715 No match';
      el.classList.add('is-nomatch');
    }
  }

  if (els.ruleRegex) els.ruleRegex.addEventListener('input', updateRegexSandbox);
  if (els.ruleTest) els.ruleTest.addEventListener('input', updateRegexSandbox);

  function addRule() {
    var label = (els.ruleName.value || '').trim();
    var pattern = (els.ruleRegex.value || '').trim();
    if (!label || !pattern) {
      App.ui.toast('Enter both a label and a regex pattern.', 'danger');
      return;
    }
    try {
      new RegExp(pattern); // eslint-disable-line no-new
    } catch (err) {
      App.ui.toast('That regex isn\u2019t valid: ' + err.message, 'danger');
      return;
    }
    App.state.settings.rules.push({
      id: 'rule_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      label: label,
      pattern: pattern
    });
    els.ruleName.value = '';
    els.ruleRegex.value = '';
    if (els.ruleTest) els.ruleTest.value = '';
    updateRegexSandbox();
    persistRules();
    renderRuleList();
    App.ui.toast('Rule added.');
  }

  if (els.btnAddRule) els.btnAddRule.addEventListener('click', addRule);

  function matchRule(text) {
    var rules = App.state.settings.rules;
    for (var i = 0; i < rules.length; i++) {
      try {
        var re = new RegExp(rules[i].pattern);
        if (re.test(text)) return rules[i];
      } catch (err) {
        continue;
      }
    }
    return null;
  }

  // ---- custom-rule badge -------------------------------------------------
  var customBadge = null;
  function ensureCustomBadge() {
    if (customBadge) return customBadge;
    var header = document.getElementById('capture-badges');
    if (!header) return null;
    customBadge = document.createElement('span');
    customBadge.className = 'badge badge--custom';
    customBadge.hidden = true;
    header.appendChild(customBadge);
    return customBadge;
  }

  function applyCustomLabelBadge(result) {
    var rule = matchRule(result.rawText);

    // Persisted onto the result object itself (not just the live badge)
    // so the match survives into History rows/detail and CSV/JSON export,
    // not just the instant the live Scan panel is showing it. Explicit
    // null (not just "leave it unset") so a scan that matches no rule
    // still gets a defined field, distinguishing "checked, no match" from
    // "never checked" for anything reading this later (e.g. export).
    result.customLabel = rule ? rule.label : null;

    var badge = ensureCustomBadge();
    if (!badge) return;
    if (rule) {
      badge.textContent = rule.label;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // Wrap the already-established history.add so every newly added result
  // (batch mode or not) gets checked against the saved rules.
  if (App.history && typeof App.history.add === 'function') {
    var originalAdd = App.history.add;
    App.history.add = function (result) {
      applyCustomLabelBadge(result);
      return originalAdd(result);
    };
  }

  // ---- keyboard shortcuts (Space intentionally omitted, see note above) ------
  function applyShortcuts() {
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        var copyBtn = document.getElementById('btn-copy-result');
        if (copyBtn) copyBtn.click();
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        var exportBtn = document.getElementById('btn-export-txt');
        if (exportBtn) exportBtn.click();
      }
    });
  }

  // ---- init --------------------------------------------------------------------
  loadRules();
  renderRuleList();
  updateRegexSandbox();
  updateStorageIndicator();

  try {
    var savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === 'light' || savedTheme === 'dark') App.state.settings.theme = savedTheme;
  } catch (err) { /* storage unavailable — keep default */ }

  try {
    var savedSound = window.localStorage.getItem(SOUND_STORAGE_KEY);
    if (savedSound === '0' || savedSound === '1') App.state.settings.sound = savedSound === '1';
  } catch (err) { /* storage unavailable — keep default */ }

  try {
    var savedVibration = window.localStorage.getItem(VIBRATION_STORAGE_KEY);
    if (savedVibration === '0' || savedVibration === '1') App.state.settings.vibration = savedVibration === '1';
  } catch (err) { /* storage unavailable — keep default */ }

  try {
    var savedBatchMode = window.localStorage.getItem(BATCH_MODE_STORAGE_KEY);
    if (savedBatchMode === '0' || savedBatchMode === '1') App.state.settings.batchMode = savedBatchMode === '1';
  } catch (err) { /* storage unavailable — keep default */ }

  if (els.selectRetention) {
    var savedRetention = loadRetentionValue();
    els.selectRetention.value = savedRetention;
    App.state.settings.retention = parseRetentionValue(savedRetention);
    // No applyRetention(true) call here by design — history.js's own
    // loadPersisted().then() callback calls it once rehydration finishes,
    // and by then this synchronous init has already set the state above.
    // Calling it here too would just be a redundant, slightly-earlier trim.
  }

  applyTheme();
  setSwitchVisual(els.switchSound, App.state.settings.sound);
  setSwitchVisual(els.switchVibration, App.state.settings.vibration);
  syncBatchModeUI();
  applyShortcuts();

  App.settings = {
    applyShortcuts: applyShortcuts,
    toggle: toggle
  };
})();
