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
})();
