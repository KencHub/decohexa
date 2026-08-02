/* ==========================================================================
   validators.js
   Owns: checksum verification for formats that carry one, and duplicate
   detection against the current session's history. Does NOT decode or
   parse anything — it only receives the { rawText, format, timestamp,
   parsed } object that parsers.js already produced and adds judgments
   about it.

   Public surface (per integration contract — do not rename):
     window.ScannerApp.validators.checkChecksum(result) -> boolean | null
     window.ScannerApp.validators.isDuplicate(result, history) -> boolean

   checkChecksum returns null (not false) for formats that don't carry a
   checksum at all — that's a distinct state from "checked and invalid",
   and the result-shape contract documents `valid` as boolean|null for
   exactly this reason.
   ========================================================================== */

(function () {
  'use strict';

  function isAllDigits(str) {
    return /^\d+$/.test(str);
  }

  // GS1 mod-10 check digit algorithm — shared by EAN-13, UPC-A and EAN-8.
  // Walk the digits (excluding the check digit) from right to left,
  // alternating weights 3 and 1 starting with 3 on the digit immediately
  // left of the check digit, then compare against the actual check digit.
  function gs1ChecksumValid(digits) {
    var body = digits.slice(0, -1);
    var checkDigit = parseInt(digits.slice(-1), 10);

    var sum = 0;
    for (var i = 0; i < body.length; i++) {
      var digit = parseInt(body[body.length - 1 - i], 10);
      var weight = (i % 2 === 0) ? 3 : 1;
      sum += digit * weight;
    }

    var computed = (10 - (sum % 10)) % 10;
    return computed === checkDigit;
  }

  function checkChecksum(result) {
    if (!result || !result.format) return null;
    var text = result.rawText || '';

    switch (result.format) {
      case 'EAN_13':
        if (!isAllDigits(text) || text.length !== 13) return null;
        return gs1ChecksumValid(text);

      case 'UPC_A':
        if (!isAllDigits(text) || text.length !== 12) return null;
        return gs1ChecksumValid(text);

      case 'EAN_8':
        if (!isAllDigits(text) || text.length !== 8) return null;
        return gs1ChecksumValid(text);

      case 'CODE_128':
        // Code 128's checksum is computed over the encoded symbol values
        // (including start/stop codes), not over the decoded text — that
        // information doesn't survive decoding, so it can't be
        // recomputed here. ZXing already rejects a frame whose Code 128
        // checksum doesn't match before decodeFromCanvas ever returns a
        // result, so getting a result here means it already passed.
        return true;

      default:
        // No checksum defined for this format (QR, Aztec, Data Matrix,
        // PDF417, Code 39, UPC-E, ...).
        return null;
    }
  }

  // Shared key format for the O(1) duplicate-count map history.js maintains
  // on App.state.history._dupKeyCounts. '\0' can't appear in either rawText
  // or format from any real scan, so it's a safe join separator.
  function dupKey(entry) {
    return entry.format + '\0' + entry.rawText;
  }

  function isDuplicate(result, history) {
    if (!result || !history || !history.length) return false;

    // Fast path: history.js keeps a Map<key, count> in sync with every
    // push/delete/undo/load, so this is an O(1) lookup instead of an O(n)
    // scan over the whole array on every single scan (which made batch
    // mode O(n^2) over a session).
    var counts = history._dupKeyCounts;
    if (counts instanceof Map) {
      return counts.has(dupKey(result));
    }

    // Fallback: only reached if something (e.g. a test harness) passes a
    // plain array without the count map attached. Keeps isDuplicate()
    // correct on its own even without history.js's bookkeeping.
    return history.some(function (entry) {
      return entry.rawText === result.rawText && entry.format === result.format;
    });
  }

  window.ScannerApp = window.ScannerApp || {};
  window.ScannerApp.validators = {
    checkChecksum: checkChecksum,
    isDuplicate: isDuplicate,
    dupKey: dupKey
  };
})();
