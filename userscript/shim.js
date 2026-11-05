/*
 * Userscript shim: lets the extension's code run as a single userscript
 * (e.g. the free "Userscripts" Safari extension on iPhone/iPad, Tampermonkey,
 * Violentmonkey).
 *
 *  - chrome.storage.local      -> GM.getValue / GM.setValue (or localStorage)
 *  - chrome.runtime messaging  -> direct in-page calls to the background code
 *  - fetch                     -> GM.xmlHttpRequest (no CORS / CSP limits)
 *
 * The build (tools/build-userscript.js) wraps this file and the extension
 * sources in one function, so the `chrome` and `fetch` names below shadow
 * the globals for all of them.
 */
/* global GM */
const __gm = typeof GM !== 'undefined' ? GM : null;
const __PREFIX = 'handyai:';

const __kv = {
  async get(k) {
    if (__gm && __gm.getValue) {
      const v = await __gm.getValue(__PREFIX + k);
      return v === undefined || v === null ? undefined : typeof v === 'string' ? JSON.parse(v) : v;
    }
    const v = localStorage.getItem(__PREFIX + k);
    return v === null ? undefined : JSON.parse(v);
  },
  async set(k, v) {
    const s = JSON.stringify(v);
    if (__gm && __gm.setValue) return __gm.setValue(__PREFIX + k, s);
    localStorage.setItem(__PREFIX + k, s);
  },
  async del(k) {
    if (__gm && __gm.deleteValue) return __gm.deleteValue(__PREFIX + k);
    localStorage.removeItem(__PREFIX + k);
  },
  async keys() {
    let all;
    if (__gm && __gm.listValues) all = await __gm.listValues();
    else all = Object.keys(localStorage);
    return all.filter((k) => k.startsWith(__PREFIX)).map((k) => k.slice(__PREFIX.length));
  },
};

function __storageArea(backing) {
  return {
    async get(keys) {
      let list;
      if (keys === null || keys === undefined) list = await backing.keys();
      else list = [].concat(keys);
      const out = {};
      for (const k of list) {
        const v = await backing.get(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
    async set(obj) {
      for (const k of Object.keys(obj)) await backing.set(k, obj[k]);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) await backing.del(k);
    },
  };
}

const __mem = new Map();
const __memBacking = {
  async get(k) {
    return __mem.get(k);
  },
  async set(k, v) {
    __mem.set(k, v);
  },
  async del(k) {
    __mem.delete(k);
  },
  async keys() {
    return Array.from(__mem.keys());
  },
};

const __listeners = [];
// eslint-disable-next-line no-unused-vars
const chrome = {
  storage: {
    local: __storageArea(__kv),
    session: __storageArea(__memBacking),
    onChanged: { addListener() {} },
  },
  runtime: {
    onMessage: {
      addListener(fn) {
        __listeners.push(fn);
      },
    },
    sendMessage(msg) {
      return new Promise((resolve) => {
        let answered = false;
        for (const fn of __listeners) {
          const keepOpen = fn(msg, { id: 'userscript' }, (r) => {
            answered = true;
            resolve(r);
          });
          if (keepOpen === true || answered) return;
        }
        resolve(undefined);
      });
    },
  },
};

/** Serialize FormData by hand: GM.xmlHttpRequest only reliably sends strings. */
async function __multipart(form) {
  const boundary = '----handyai' + Math.random().toString(16).slice(2);
  let body = '';
  for (const [name, value] of form.entries()) {
    body += '--' + boundary + '\r\n';
    if (typeof value === 'string') {
      body += 'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n';
    } else {
      body += 'Content-Disposition: form-data; name="' + name + '"; filename="' + (value.name || 'file') + '"\r\n';
      body += 'Content-Type: ' + (value.type || 'application/octet-stream') + '\r\n\r\n';
      body += (await value.text()) + '\r\n';
    }
  }
  body += '--' + boundary + '--\r\n';
  return { body, contentType: 'multipart/form-data; boundary=' + boundary };
}

const __nativeFetch = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : null;
const __gmXhr = __gm && (__gm.xmlHttpRequest || __gm.xmlhttpRequest);

// eslint-disable-next-line no-unused-vars
async function fetch(url, init) {
  init = init || {};
  if (!__gmXhr) return __nativeFetch(url, init);
  const headers = Object.assign({}, init.headers || {});
  let data = init.body;
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    const mp = await __multipart(data);
    data = mp.body;
    headers['Content-Type'] = mp.contentType;
  }
  return new Promise((resolve, reject) => {
    __gmXhr({
      method: init.method || 'GET',
      url,
      headers,
      data,
      timeout: 20000,
      onload: (r) => {
        const text = r.responseText !== undefined ? r.responseText : r.response;
        resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          json: async () => JSON.parse(text),
          text: async () => text,
        });
      },
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timed out')),
    });
  });
}
