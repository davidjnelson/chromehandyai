'use strict';
const browserGlobals = {
  window: 'readonly', document: 'readonly', chrome: 'readonly', globalThis: 'readonly', self: 'readonly',
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', performance: 'readonly', location: 'readonly',
  URL: 'readonly', Blob: 'readonly', FormData: 'readonly', fetch: 'readonly', crypto: 'readonly', TextEncoder: 'readonly',
  AbortController: 'readonly', HTMLVideoElement: 'readonly', Event: 'readonly', confirm: 'readonly',
  module: 'writable', require: 'readonly', process: 'readonly', __dirname: 'readonly',
};
module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: browserGlobals },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }], 'no-undef': 'error' },
  },
];
