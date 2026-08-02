/* ==========================================================================
   parsers.js
   Owns: turning a decoded raw string into a typed, structured object.
   Does NOT decode anything itself (decoder.js) and does NOT validate
   checksums or duplicates (validators.js) — this file only figures out
   *what kind of thing* the raw text is and pulls out its fields.

   Public surface (per integration contract — do not rename):
     window.ScannerApp.parsers.parse(rawText) -> { type, data }

   app.js is responsible for calling this with just the raw string and
   attaching the return value to result.parsed — see the contract in
   scanner-build-spec.md ("parsers.js takes that and adds the parsed
   field, returning the same object with parsed attached").

   Detection order matters: most specific/structured formats are tried
   first (jwt, wifi, vcard) before the more permissive ones (url, json)
   so a JSON blob that happens to contain "://" doesn't get misread, etc.
   Anything that matches nothing falls through to plain "text".
   ========================================================================== */

(function () {
  'use strict';

  // ---- shared helpers --------------------------------------------------

  function base64UrlDecodeToBytes(segment) {
    var s = segment.replace(/-/g, '+').replace(/_/g, '/');
    var padLen = s.length % 4;
    if (padLen === 2) s += '==';
    else if (padLen === 3) s += '=';
    else if (padLen === 1) throw new Error('bad-base64url-length');

    var binary = atob(s);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function base64UrlDecodeToString(segment) {
    var bytes = base64UrlDecodeToBytes(segment);
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(bytes);
    }
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return binary; // fallback for environments without TextDecoder
  }

  function splitRespectingEscapes(str, separator) {
    // Splits on `separator` but treats `\X` as a literal escaped char,
    // per the vCard/WIFI QR payload escaping convention (\; \, \: \\).
    var parts = [];
    var current = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (ch === '\\' && i + 1 < str.length) {
        current += ch + str[i + 1];
        i++;
        continue;
      }
      if (ch === separator) {
        parts.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.length) parts.push(current);
    return parts;
  }

  function unescapeField(str) {
    return str.replace(/\\(.)/g, '$1');
  }

  // ---- JWT ----------------------------------------------------------------

  function tryParseJwt(text) {
    var parts = text.split('.');
    if (parts.length !== 3) return null;

    var segmentPattern = /^[A-Za-z0-9_-]+$/;
    if (!segmentPattern.test(parts[0]) || !segmentPattern.test(parts[1]) || !segmentPattern.test(parts[2])) {
      return null;
    }

    var header, payload;
    try {
      header = JSON.parse(base64UrlDecodeToString(parts[0]));
      payload = JSON.parse(base64UrlDecodeToString(parts[1]));
    } catch (err) {
      return null; // not actually valid base64url JSON — not a JWT after all
    }

    var data = { header: header, payload: payload, signature: parts[2] };
    if (typeof payload.iat === 'number') data.issuedAt = new Date(payload.iat * 1000).toISOString();
    if (typeof payload.exp === 'number') data.expiresAt = new Date(payload.exp * 1000).toISOString();
    if (typeof payload.nbf === 'number') data.notBefore = new Date(payload.nbf * 1000).toISOString();

    return { type: 'jwt', data: data };
  }

  // ---- WiFi QR payload ------------------------------------------------------

  function tryParseWifi(text) {
    if (!/^WIFI:/i.test(text)) return null;

    var body = text.replace(/^WIFI:/i, '').replace(/;;?$/, '');
    var fields = splitRespectingEscapes(body, ';');
    var out = {};

    fields.forEach(function (field) {
      var match = /^([A-Za-z]+):(.*)$/.exec(field);
      if (!match) return;
      out[match[1].toUpperCase()] = unescapeField(match[2]);
    });

    // Reject only when genuinely no key:value field could be parsed at all
    // (e.g. "WIFI:this is just a note" with no colon-delimited fields) —
    // NOT specifically requiring S or T. Requiring S/T let a payload with
    // only a P: field (e.g. "WIFI:P:onlyfield", no S:, no T:) fall through
    // to tryParseUrl instead, where it's classified as type 'url' and
    // completely bypasses every wifi-specific masking safeguard below,
    // printing the password in plain text as the "Link"/"Path" fields.
    if (Object.keys(out).length === 0) return null;

    return {
      type: 'wifi',
      data: {
        ssid: out.S || '',
        password: out.P || '',
        encryption: out.T || 'nopass',
        hidden: out.H === 'true' || out.H === '1'
      }
    };
  }

  // ---- vCard --------------------------------------------------------------

  function tryParseVcard(text) {
    if (!/^BEGIN:VCARD/i.test(text.trim())) return null;

    var lines = text.split(/\r\n|\r|\n/);
    var out = { fullName: '', org: '', address: '', phones: [], emails: [] };

    lines.forEach(function (line) {
      var idx = line.indexOf(':');
      if (idx === -1) return;
      var key = line.slice(0, idx).split(';')[0].toUpperCase();
      var value = unescapeField(line.slice(idx + 1).trim());

      if (key === 'FN') {
        out.fullName = value;
      } else if (key === 'N' && !out.fullName) {
        // N is Last;First;Middle;Prefix;Suffix — only used if FN is missing
        out.fullName = value.split(';').filter(Boolean).join(' ');
      } else if (key === 'TEL') {
        out.phones.push(value);
      } else if (key === 'EMAIL') {
        out.emails.push(value);
      } else if (key === 'ORG') {
        out.org = value;
      } else if (key === 'ADR') {
        out.address = value.split(';').filter(Boolean).join(', ');
      }
    });

    return { type: 'vcard', data: out };
  }

  // ---- URL ------------------------------------------------------------------

  function tryParseUrl(text) {
    var candidate = text.trim();
    var url = null;

    try {
      url = new URL(candidate);
    } catch (err) {
      url = null;
    }

    if (!url) {
      // Bare-domain heuristic (e.g. "example.com/path" with no scheme).
      // Deliberately conservative so plain numeric barcode text never
      // matches: requires a dot, no whitespace, and a valid host shape.
      var looksLikeBareDomain = !/\s/.test(candidate) &&
        /^[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]+)?(\/\S*)?$/i.test(candidate);
      if (looksLikeBareDomain) {
        try { url = new URL('https://' + candidate); } catch (err) { url = null; }
      }
    }

    if (!url) return null;

    return {
      type: 'url',
      data: {
        href: url.href,
        domain: url.hostname,
        protocol: url.protocol.replace(':', ''),
        path: url.pathname + url.search
      }
    };
  }

  // ---- JSON -----------------------------------------------------------------

  function tryParseJson(text) {
    var trimmed = text.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;

    var value;
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      return null;
    }
    if (typeof value !== 'object' || value === null) return null;

    return { type: 'json', data: { value: value, pretty: JSON.stringify(value, null, 2) } };
  }

  // ---- bare base64 / base64url blob -----------------------------------------
  // Catches payloads that are ENCODED but not a full JWT — e.g. a lone
  // base64/base64url segment with no ".header.signature" around it, such
  // as a static claims blob some ID/verification systems put straight
  // into a barcode. tryParseJwt already handles the 3-part case; this
  // covers everything JWT-shaped detection misses. Deliberately placed
  // after every other detector (including tryParseJson) so a payload that
  // already IS readable JSON/URL/etc. is never re-interpreted as base64.
  function isPrintableDecodedText(str) {
    // A strong signal the "decoded" bytes are actually unrelated binary
    // data, not a real text payload: reject any control character other
    // than tab/newline/CR.
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code === 9 || code === 10 || code === 13) continue;
      if (code < 32 || code === 127) return false;
    }
    return true;
  }

  function tryParseBase64(text) {
    var candidate = text.trim();

    // Base64/base64url alphabet only, optional trailing '=' padding, and
    // long enough that short numeric/alpha barcode payloads (which also
    // happen to fit the base64 character set) rarely trigger this by
    // accident.
    if (candidate.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(candidate)) {
      return null;
    }

    var bytes;
    try {
      bytes = base64UrlDecodeToBytes(candidate);
    } catch (err) {
      return null; // not validly padded/shaped base64 — not actually encoded
    }
    if (!bytes.length) return null;

    var decodedText;
    try {
      // fatal: true — if this isn't valid UTF-8, it's binary data (e.g. an
      // image or compressed blob), not a human-readable payload, so bail.
      decodedText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      return null;
    }
    if (!isPrintableDecodedText(decodedText)) return null;

    // If the decoded text is itself JSON (very common — claims blobs,
    // config payloads), expose it structured/pretty-printed like
    // tryParseJson does, rather than as one raw decoded string.
    var trimmedDecoded = decodedText.trim();
    if (trimmedDecoded && (trimmedDecoded[0] === '{' || trimmedDecoded[0] === '[')) {
      try {
        var value = JSON.parse(trimmedDecoded);
        if (value && typeof value === 'object') {
          return {
            type: 'base64json',
            data: { decoded: decodedText, value: value, pretty: JSON.stringify(value, null, 2) }
          };
        }
      } catch (err) {
        // fall through — decodes fine as text, just isn't valid JSON
      }
    }

    return { type: 'base64text', data: { decoded: decodedText } };
  }

  // ---- dot-separated token, but not a full JWT ------------------------------
  // Covers formats like "payload.signature" (2 parts) or anything else
  // dot-delimited that isn't a valid header.payload.signature JWT — some
  // ID-verification systems issue these. tryParseJwt already handles the
  // proper 3-part case; tryParseBase64 already handles a single dot-free
  // blob. This fills the gap between them: split on '.', then decode
  // whichever segment actually turns out to be readable (usually the
  // payload/claims segment — a signature segment is opaque binary and
  // simply won't decode to valid UTF-8, so it's skipped over).
  function tryParseSegmentedToken(text) {
    var raw = text.trim();
    if (raw.indexOf('.') === -1) return null; // no dots — tryParseBase64 already covered this

    var parts = raw.split('.');
    if (parts.length < 2) return null;

    var segmentPattern = /^[A-Za-z0-9_-]+$/;

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part || !segmentPattern.test(part)) continue;

      var bytes;
      try {
        bytes = base64UrlDecodeToBytes(part);
      } catch (err) {
        continue;
      }
      if (!bytes.length) continue;

      var decodedText;
      try {
        decodedText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (err) {
        continue; // this segment is binary (e.g. the signature) — try the next one
      }
      if (!isPrintableDecodedText(decodedText)) continue;

      var trimmedDecoded = decodedText.trim();
      var jsonValue = null;
      if (trimmedDecoded && (trimmedDecoded[0] === '{' || trimmedDecoded[0] === '[')) {
        try {
          var candidate = JSON.parse(trimmedDecoded);
          if (candidate && typeof candidate === 'object') jsonValue = candidate;
        } catch (err) {
          // decodes fine as text, just isn't valid JSON — still usable below
        }
      }

      var meta = { segmentIndex: i, segmentCount: parts.length };

      if (jsonValue !== null) {
        return {
          type: 'base64json',
          data: Object.assign(
            { decoded: decodedText, value: jsonValue, pretty: JSON.stringify(jsonValue, null, 2) },
            meta
          )
        };
      }
      return { type: 'base64text', data: Object.assign({ decoded: decodedText }, meta) };
    }

    return null; // dot-separated, but no segment decoded to readable text
  }

  // ---- entry point ------------------------------------------------------------

  function parse(rawText) {
    var text = String(rawText == null ? '' : rawText);

    var parsed =
      tryParseJwt(text) ||
      tryParseWifi(text) ||
      tryParseVcard(text) ||
      tryParseUrl(text) ||
      tryParseJson(text) ||
      tryParseBase64(text) ||
      tryParseSegmentedToken(text);

    if (parsed) return parsed;
    return { type: 'text', data: { text: text } };
  }

  window.ScannerApp = window.ScannerApp || {};
  window.ScannerApp.parsers = { parse: parse };
})();
