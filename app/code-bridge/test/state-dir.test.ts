import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stateDir } from '../src/state-dir';

function withBase(fn: (base: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-state-dir-test-'));
  try {
    fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('stateDir: fresh install (neither home exists) resolves the hexokit dir', () => {
  withBase((base) => {
    assert.equal(stateDir({ XDG_STATE_HOME: base }), path.join(base, 'hexokit', 'cb'));
  });
});

test('stateDir: legacy-only home keeps resolving the run-kit dir', () => {
  withBase((base) => {
    fs.mkdirSync(path.join(base, 'run-kit'));
    assert.equal(stateDir({ XDG_STATE_HOME: base }), path.join(base, 'run-kit', 'cb'));
  });
});

test('stateDir: an existing hexokit home wins over the legacy one', () => {
  withBase((base) => {
    fs.mkdirSync(path.join(base, 'hexokit'));
    assert.equal(stateDir({ XDG_STATE_HOME: base }), path.join(base, 'hexokit', 'cb'));
    fs.mkdirSync(path.join(base, 'run-kit'));
    assert.equal(stateDir({ XDG_STATE_HOME: base }), path.join(base, 'hexokit', 'cb'));
  });
});

test('stateDir: XDG_STATE_HOME unset falls back to ~/.local/state', () => {
  withBase((base) => {
    const home = path.join(base, 'home');
    fs.mkdirSync(path.join(home, '.local', 'state', 'run-kit'), { recursive: true });
    assert.equal(
      stateDir({}, () => home),
      path.join(home, '.local', 'state', 'run-kit', 'cb'),
    );
  });
});
