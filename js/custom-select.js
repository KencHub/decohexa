/* ==========================================================================
   custom-select.js
   Owns: replacing every native <select class="field"> with a styled,
   in-app dropdown (button trigger + role="listbox" panel) so mobile
   browsers stop taking over with their own system picker — the native
   <select>'s *open* dropdown can't be styled at all, only its closed box.

   This is a progressive-enhancement WRAPPER, not a rewrite of the format
   picker or history filter: the original <select> stays in the DOM
   (visually hidden) as the single source of truth. generator.js and
   history.js keep reading `select.value` and listening for `change` on
   the select exactly as before — nothing in either file needed to change.
   A MutationObserver watches each select's <option> list, so History's
   format filter (which grows its options at runtime as new formats are
   scanned) stays in sync automatically.

   Does NOT touch decoding, parsing, validation, or history storage.
   ========================================================================== */

(function () {
  'use strict';

  function enhance(select) {
    if (!select || select.dataset.customSelectEnhanced) return;
    select.dataset.customSelectEnhanced = 'true';

    var wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    select.parentNode.insertBefore(wrapper, select);

    select.classList.remove('field');
    select.classList.add('custom-select__native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(select);

    // Point any <label for="..."> at the trigger instead, so clicking the
    // label opens the real (custom) control rather than the hidden select.
    var triggerId = select.id ? select.id + '-trigger' : '';
    if (select.id) {
      var label = document.querySelector('label[for="' + select.id + '"]');
      if (label) label.setAttribute('for', triggerId);
    }

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select__trigger field';
    if (triggerId) trigger.id = triggerId;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    var ariaLabel = select.getAttribute('aria-label');
    if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);

    var valueSpan = document.createElement('span');
    valueSpan.className = 'custom-select__value';
    var chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('class', 'custom-select__chevron');
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.innerHTML = '<polyline points="6 9 12 15 18 9"></polyline>';
    trigger.appendChild(valueSpan);
    trigger.appendChild(chevron);
    wrapper.appendChild(trigger);

    var panel = document.createElement('div');
    panel.className = 'custom-select__panel';
    panel.setAttribute('role', 'listbox');
    if (triggerId) panel.setAttribute('aria-labelledby', triggerId);
    panel.hidden = true;
    wrapper.appendChild(panel);

    var optionEls = [];
    var highlightedIndex = -1;

    function labelForValue(value) {
      for (var i = 0; i < select.options.length; i++) {
        if (select.options[i].value === value) return select.options[i].textContent;
      }
      return '';
    }

    function syncTrigger() {
      valueSpan.textContent = labelForValue(select.value) || '\u2014';
    }

    function rebuildOptions() {
      panel.innerHTML = '';
      optionEls = [];
      highlightedIndex = -1;

      if (!select.options.length) {
        var empty = document.createElement('div');
        empty.className = 'custom-select__empty';
        empty.textContent = 'No options available';
        panel.appendChild(empty);
        syncTrigger();
        return;
      }

      Array.prototype.forEach.call(select.options, function (opt, i) {
        var optEl = document.createElement('div');
        optEl.className = 'custom-select__option';
        optEl.setAttribute('role', 'option');
        optEl.dataset.value = opt.value;
        optEl.textContent = opt.textContent;
        optEl.setAttribute('aria-selected', opt.value === select.value ? 'true' : 'false');
        if (opt.value === select.value) highlightedIndex = i;

        optEl.addEventListener('click', function () {
          selectValue(opt.value);
          closePanel();
          trigger.focus();
        });

        panel.appendChild(optEl);
        optionEls.push(optEl);
      });

      syncTrigger();
    }

    function selectValue(value) {
      if (select.value === value) return;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      rebuildOptions();
    }

    function setHighlighted(index, opts) {
      optionEls.forEach(function (el, i) {
        el.classList.toggle('is-highlighted', i === index);
      });
      highlightedIndex = index;
      var el = optionEls[index];
      if (!el) return;
      if (opts && opts.center) {
        // Center the option in the panel's viewport so neighbors on both
        // sides are visible, rather than snapping it to whichever edge
        // scrollIntoView({block:'nearest'}) happens to pick.
        var target = el.offsetTop - (panel.clientHeight / 2) + (el.offsetHeight / 2);
        panel.scrollTop = Math.max(0, Math.min(target, panel.scrollHeight - panel.clientHeight));
      } else {
        el.scrollIntoView({ block: 'nearest' });
      }
    }

    function positionPanel() {
      // Default (CSS) is anchored below the trigger. Flip above it when
      // there isn't enough room below in the viewport but there is above,
      // so the panel never renders partially off-screen.
      panel.classList.remove('is-flipped');
      var triggerRect = trigger.getBoundingClientRect();
      var panelHeight = panel.getBoundingClientRect().height;
      var spaceBelow = window.innerHeight - triggerRect.bottom;
      var spaceAbove = triggerRect.top;
      if (spaceBelow < panelHeight && spaceAbove > spaceBelow) {
        panel.classList.add('is-flipped');
      }
    }

    function openPanel() {
      if (!panel.hidden) return;
      panel.hidden = false;
      trigger.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      positionPanel();
      var current = optionEls.findIndex(function (el) { return el.dataset.value === select.value; });
      setHighlighted(current === -1 ? 0 : current, { center: true });
      document.addEventListener('click', onDocClick, true);
    }

    function closePanel() {
      if (panel.hidden) return;
      panel.hidden = true;
      trigger.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick, true);
    }

    function onDocClick(e) {
      if (!wrapper.contains(e.target)) closePanel();
    }

    trigger.addEventListener('click', function () {
      if (panel.hidden) openPanel(); else closePanel();
    });

    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (panel.hidden) openPanel(); else if (e.key === 'Enter' || e.key === ' ') {
          if (optionEls[highlightedIndex]) optionEls[highlightedIndex].click();
        }
      }
    });

    panel.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlighted(Math.min(highlightedIndex + 1, optionEls.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlighted(Math.max(highlightedIndex - 1, 0));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (optionEls[highlightedIndex]) optionEls[highlightedIndex].click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closePanel();
        trigger.focus();
      } else if (e.key === 'Tab') {
        closePanel();
      }
    });
    // Panel items aren't natively focusable; route keys through the trigger
    // while open by keeping focus on the trigger and listening there too.
    trigger.addEventListener('keydown', function (e) {
      if (!panel.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape')) {
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: false, cancelable: true }));
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) closePanel();
    });

    trigger.addEventListener('blur', function () {
      window.setTimeout(function () {
        if (!wrapper.contains(document.activeElement)) closePanel();
      }, 0);
    });

    // Keep in sync when the underlying options list changes at runtime
    // (e.g. history.js rebuilding the format filter as new formats appear).
    new MutationObserver(rebuildOptions).observe(select, { childList: true });
    // Keep in sync if something else sets select.value programmatically.
    select.addEventListener('change', syncTrigger);
    // A separate, side-effect-free "just repaint" signal for the same case
    // (something else set .value directly). Deliberately not reusing
    // 'change' here: several selects have real 'change' handlers with
    // business-logic side effects (persisting a value, re-filtering,
    // showing a toast) that shouldn't re-run just because a caller wants
    // the visible box to catch up to a value it already set.
    select.addEventListener('scannerapp:syncselect', syncTrigger);

    rebuildOptions();
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('select.field'), enhance);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
