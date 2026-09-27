'use strict';
// The audit engine's version, stamped into seo-engine.js when it is served (and when headless-audit.js inlines it):
// "<git commit>-<content hash>", e.g. "079db1e-3fa2c91b". Pages load the engine as seo-engine.js?v=<version>, so a
// new deploy is a new URL and no browser can keep running a cached engine; every report prints the version that
// produced it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ENGINE_PATH = path.join(__dirname, 'seo-engine.js');
const PLACEHOLDER = '__ENGINE_VERSION__';

function commit() {
  const env = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_VERSION || process.env.GIT_COMMIT || '';
  if (env) return env.slice(0, 7);
  try { return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return 'dev'; }
}
const COMMIT = commit();

let cache = null; // { mtimeMs, version, source }
function engine() {
  const st = fs.statSync(ENGINE_PATH);
  if (!cache || cache.mtimeMs !== st.mtimeMs) {
    const raw = fs.readFileSync(ENGINE_PATH, 'utf8');
    const version = COMMIT + '-' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
    cache = { mtimeMs: st.mtimeMs, version, source: raw.split(PLACEHOLDER).join(version) };
  }
  return cache;
}
module.exports = { engineVersion: () => engine().version, engineSource: () => engine().source };
