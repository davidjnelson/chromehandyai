/* Settings and per-video data in chrome.storage.local. */
(function (root) {
  'use strict';
  const HAI = root.HAI || (root.HAI = {});

  const DEFAULT_SETTINGS = {
    connectionKey: '',
    appId: '', // Handy API v3 Application ID (firmware 4 devices)
    autoConnect: true,
    minPos: 0,
    maxPos: 100,
    sensitivity: 0.5,
    smoothing: 0.4,
    invert: false,
    maxSpeed: 500,
    scanRate: 4,
    offsetMs: 0,
    apiBase: '',
    uploadUrl: '',
  };

  async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return Object.assign({}, DEFAULT_SETTINGS, settings || {});
  }

  async function saveSettings(patch) {
    const cur = await getSettings();
    const next = Object.assign(cur, patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  /**
   * Per-video record:
   *   { signal: packed motion signal | null, imported: actions | null,
   *     importedName, scannedTo (s), duration (s), createdAt }
   */
  async function getVideo(id) {
    const k = 'video:' + id;
    return (await chrome.storage.local.get(k))[k] || null;
  }

  async function saveVideo(id, rec) {
    await chrome.storage.local.set({ ['video:' + id]: Object.assign({ updatedAt: Date.now() }, rec) });
  }

  async function deleteVideo(id) {
    await chrome.storage.local.remove('video:' + id);
  }

  HAI.store = { DEFAULT_SETTINGS, getSettings, saveSettings, getVideo, saveVideo, deleteVideo };
})(typeof globalThis !== 'undefined' ? globalThis : this);
