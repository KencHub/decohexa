/* ==========================================================================
   camera.js
   Owns: getUserMedia, rear-camera default, camera switching, torch toggle.
   Does NOT own decoding or the scan loop — that's decoder.js's job (called by
   app.js). This file only manages the video stream and hardware capabilities.

   Public surface (per integration contract — do not rename):
     window.ScannerApp.camera.start()          -> Promise<{ deviceCount, torchSupported }>
     window.ScannerApp.camera.stop()
     window.ScannerApp.camera.switchCamera()    -> Promise<{ deviceCount, torchSupported }> | null
     window.ScannerApp.camera.toggleTorch()     -> Promise<boolean>
   ========================================================================== */

(function () {
  'use strict';

  var stream = null;
  var videoEl = null;
  var devices = [];        // videoinput devices, populated after permission is granted
  var currentDeviceIndex = 0;
  var currentTrack = null;
  var torchOn = false;

  function getVideoEl() {
    if (!videoEl) videoEl = document.getElementById('video');
    return videoEl;
  }

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
    }
    stream = null;
    currentTrack = null;
  }

  async function listVideoDevices() {
    try {
      var all = await navigator.mediaDevices.enumerateDevices();
      devices = all.filter(function (d) { return d.kind === 'videoinput'; });
    } catch (err) {
      devices = [];
    }
    return devices;
  }

  function trackSupportsTorch(track) {
    if (!track || typeof track.getCapabilities !== 'function') return false;
    try {
      var caps = track.getCapabilities();
      return !!caps.torch;
    } catch (err) {
      // Some browsers throw if the track has been stopped or capabilities
      // aren't supported at all — treat as "no torch" rather than propagating.
      return false;
    }
  }

  function classifyGetUserMediaError(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return 'permission-denied';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return 'no-camera';
    }
    return 'camera-error';
  }

  /**
   * Start (or restart) the camera stream. Defaults to the rear/environment
   * camera on first start. On subsequent starts after a switchCamera() call,
   * re-requests the specific device that was selected.
   */
  async function start() {
    var video = getVideoEl();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      var unsupported = new Error('Camera API not available in this browser');
      unsupported.code = 'unsupported';
      throw unsupported;
    }

    stopStream();

    var constraints;
    if (devices.length && devices[currentDeviceIndex]) {
      constraints = { video: { deviceId: { exact: devices[currentDeviceIndex].deviceId } }, audio: false };
    } else {
      constraints = { video: { facingMode: { ideal: 'environment' } }, audio: false };
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      var code = classifyGetUserMediaError(err);
      var wrapped = new Error(code);
      wrapped.code = code;
      throw wrapped;
    }

    video.srcObject = stream;
    try { await video.play(); } catch (err) { /* autoplay quirks — video element has muted+playsinline set */ }

    currentTrack = stream.getVideoTracks()[0] || null;
    torchOn = false;

    // Device labels are only populated once permission has been granted, so
    // enumerate now rather than before start() — this is also what lets the
    // switch-camera button reflect the true device count.
    await listVideoDevices();

    // Keep currentDeviceIndex pointing at the camera we actually got, not
    // just wherever it happened to be left. The very first start() goes
    // through the facingMode branch above (devices[] is still empty), which
    // reliably picks the rear/environment camera — but once devices[] is
    // populated, every later start() (e.g. pause -> resume) switches to the
    // deviceId-exact branch and defaults to index 0. enumerateDevices()
    // doesn't guarantee the rear camera is first, so without this, a
    // pause -> resume could silently reconnect to a *different* physical
    // camera (front-facing, or a torch-less secondary lens) — which is
    // exactly what made the torch button vanish after pausing and
    // resuming, only "fixed" by a refresh that reset devices[] to empty.
    var settings = currentTrack && typeof currentTrack.getSettings === 'function'
      ? currentTrack.getSettings() : null;
    if (settings && settings.deviceId) {
      var matchIndex = devices.findIndex(function (d) { return d.deviceId === settings.deviceId; });
      if (matchIndex !== -1) currentDeviceIndex = matchIndex;
    }

    return {
      deviceCount: devices.length,
      torchSupported: trackSupportsTorch(currentTrack)
    };
  }

  function stop() {
    stopStream();
    var video = getVideoEl();
    if (video) video.srcObject = null;
    torchOn = false;
  }

  /**
   * Cycle to the next available camera and restart the stream on it.
   * Returns null if there's nothing to switch to (0 or 1 cameras).
   */
  async function switchCamera() {
    if (!devices.length) {
      await listVideoDevices();
    }
    if (devices.length < 2) return null;

    currentDeviceIndex = (currentDeviceIndex + 1) % devices.length;
    return start();
  }

  /**
   * Toggle the torch/flashlight on the active track, if supported.
   * Returns the new torch state (false if unsupported or the browser
   * rejects the constraint).
   */
  async function toggleTorch() {
    if (!trackSupportsTorch(currentTrack)) return false;

    var next = !torchOn;
    try {
      await currentTrack.applyConstraints({ advanced: [{ torch: next }] });
      torchOn = next;
    } catch (err) {
      // Leave torchOn as it was — the constraint application failed.
    }
    return torchOn;
  }

  window.ScannerApp = window.ScannerApp || {};
  window.ScannerApp.camera = {
    start: start,
    stop: stop,
    switchCamera: switchCamera,
    toggleTorch: toggleTorch
  };
})();
