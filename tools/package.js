// Builds dist/handy-ai-scripts-<version>.zip with only the files the browser needs.
// The same zip loads in Chrome/Edge (unpacked or upload) and Firefox (desktop + Android).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `handy-ai-scripts-${version}.zip`);
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-q', out, 'manifest.json', 'src', 'rules', 'icons', '-x', 'icons/icon.svg'], { cwd: root, stdio: 'inherit' });
console.log('wrote', path.relative(root, out));
