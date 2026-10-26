#!/usr/bin/env node
'use strict';
// Builds the serverless version of the app screens: node scripts/build-static.js --out dist
// Copies public/ and wires in the GitHub connector (github.js) with this repo's name. Used for the website (Pages) and the APK.
const fs = require('fs');
const path = require('path');

function build({ out, repo, root = path.join(__dirname, '..', 'public') }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('set GITHUB_REPOSITORY (owner/name) or pass --repo owner/name');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(root)) fs.copyFileSync(path.join(root, f), path.join(out, f));
  fs.writeFileSync(path.join(out, 'config.js'), `window.AITRADER_STATIC = ${JSON.stringify({ repo, branch: 'data', workflow: 'trader.yml' })};\n`);
  const idx = path.join(out, 'index.html');
  let html = fs.readFileSync(idx, 'utf8');
  if (!html.includes('./app.js')) throw new Error('index.html does not load ./app.js');
  html = html.replace('<script src="./app.js"></script>', '<script src="./shared.js"></script>\n<script src="./config.js"></script>\n<script src="./github.js"></script>\n<script src="./app.js"></script>');
  fs.writeFileSync(idx, html);
  return out;
}

module.exports = { build };

if (require.main === module) {
  const a = process.argv.slice(2);
  const get = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const out = build({ out: path.resolve(get('--out') || 'dist'), repo: get('--repo') || process.env.GITHUB_REPOSITORY });
    console.log('built ' + out);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
