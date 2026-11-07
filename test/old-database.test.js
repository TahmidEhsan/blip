// Blip has one backend, MongoDB. The hosted SQLite service and its client library it used before are
// gone from the code, the pages' scripts, the docs and the dependencies, and this keeps them from creeping
// back. (The owner's old ./data/blip.db file is left on disk, unread; see README.md.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../server/config.js';

/** Every file under `dir` (relative to the project) with one of `extensions`. */
function filesIn(dir, extensions) {
  const out = [];
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.includes(path.extname(entry.name))) out.push(full);
    }
  };
  walk(path.join(PROJECT_ROOT, dir));
  return out;
}

/** `file:line: text` for every line matching `pattern`. */
function mentions(files, pattern) {
  return files.flatMap((file) => fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line, i) => (pattern.test(line) ? `${path.relative(PROJECT_ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}` : null))
    .filter(Boolean));
}

const OLD_BACKEND = /turso|libsql/i;

describe('the old database is gone', () => {
  it('server/, the pages and their scripts, README.md and SPEC.md never mention it', () => {
    const files = [
      ...filesIn('server', ['.js', '.html']),
      ...filesIn('public', ['.js', '.html', '.css']).filter((f) => !path.relative(PROJECT_ROOT, f).split(path.sep).includes('vendor')),
      path.join(PROJECT_ROOT, 'README.md'),
      path.join(PROJECT_ROOT, 'SPEC.md'),
      path.join(PROJECT_ROOT, 'server.js'),
      path.join(PROJECT_ROOT, 'vercel.json'),
    ];
    assert.ok(files.some((f) => f.endsWith(path.join('assets', 'js', 'api.js'))), 'public/assets/js is scanned');
    assert.deepEqual(mentions(files, OLD_BACKEND), []);
  });

  it('the server reads none of its settings and opens no SQLite file', () => {
    const settings = /\bDB_PATH\b|\bDATABASE_URL\b|\bDATABASE_AUTH_TOKEN\b|\bTURSO_|\bLIBSQL_|node:sqlite|\.db['"`]/;
    assert.deepEqual(mentions([...filesIn('server', ['.js']), path.join(PROJECT_ROOT, 'server.js')], settings), []);
  });

  it('is not a dependency any more', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
    assert.deepEqual(declared.filter((name) => OLD_BACKEND.test(name)), []);
    assert.ok(declared.includes('mongodb'));
    const lock = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package-lock.json'), 'utf8'));
    assert.deepEqual(Object.keys(lock.packages).filter((name) => OLD_BACKEND.test(name)), []);
  });
});
