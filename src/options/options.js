/* Options page / toolbar popup. Shares settings with the in-page panel. */
(async function () {
  'use strict';
  const { store } = globalThis.HAI;
  const $ = (id) => document.getElementById(id);
  const status = (text, cls) => {
    $('status').textContent = text;
    $('status').className = 'status ' + (cls || '');
  };

  const s = await store.getSettings();
  $('connectionKey').value = s.connectionKey;
  $('autoConnect').checked = !!s.autoConnect;
  $('apiBase').value = s.apiBase || '';
  $('uploadUrl').value = s.uploadUrl || '';

  async function save() {
    await store.saveSettings({
      connectionKey: $('connectionKey').value.trim(),
      autoConnect: $('autoConnect').checked,
      apiBase: $('apiBase').value.trim(),
      uploadUrl: $('uploadUrl').value.trim(),
    });
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await save();
    status('Saved.', 'ok');
  });

  $('toggleKey').addEventListener('click', () => {
    const el = $('connectionKey');
    el.type = el.type === 'password' ? 'text' : 'password';
    $('toggleKey').textContent = el.type === 'password' ? 'Show' : 'Hide';
  });

  $('test').addEventListener('click', async () => {
    await save();
    status('Connecting…');
    try {
      const r = await chrome.runtime.sendMessage({ ns: 'handy', op: 'connect' });
      if (!r || !r.ok) throw new Error((r && r.error) || 'No answer from the extension');
      status('Connected. Round trip ' + r.rtt + ' ms.', 'ok');
    } catch (e) {
      status(e.message, 'err');
    }
  });

  $('clearData').addEventListener('click', async () => {
    if (!confirm('Delete every saved script and scan?')) return;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('video:') || k.startsWith('upload:'));
    await chrome.storage.local.remove(keys);
    status('Deleted ' + keys.filter((k) => k.startsWith('video:')).length + ' saved scripts.', 'ok');
  });
})();
