import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB_ADD_TIMEOUT_MS,
  NOTIFY_TIMEOUT_MS,
  SEND_TIMEOUT_MS,
  buildWebAddArgv,
  buildNotifyArgv,
  buildSendArgv,
  buildSendPayload,
  formatReference,
  parsePort,
  selectionLines,
} from '../src/actions';

const identity = { tab: '@7', server: 'default' };

test('timeout constants match the verb budgets', () => {
  assert.equal(WEB_ADD_TIMEOUT_MS, 15000);
  assert.equal(NOTIFY_TIMEOUT_MS, 15000);
  assert.equal(SEND_TIMEOUT_MS, 20000);
});

test('buildWebAddArgv renders the exact element sequence with an unsplit target', () => {
  assert.deepEqual(buildWebAddArgv(identity, '/repo/my dir/README.md'), [
    'tab',
    'web',
    'add',
    '@7',
    '/repo/my dir/README.md',
    '--show',
    '-L',
    'default',
  ]);
});

test('buildWebAddArgv renders a port target', () => {
  assert.deepEqual(buildWebAddArgv(identity, ':8080'), [
    'tab',
    'web',
    'add',
    '@7',
    ':8080',
    '--show',
    '-L',
    'default',
  ]);
});

test('buildNotifyArgv renders the presenting message and title', () => {
  assert.deepEqual(buildNotifyArgv('README.md'), [
    'notify',
    'presenting README.md',
    '--title',
    'HexoKit',
  ]);
});

test('buildSendArgv stages via stdin with --no-enter and the server', () => {
  const argv = buildSendArgv(identity, { force: false });
  assert.deepEqual(argv, ['mux', 'send', '@7', '-', '--no-enter', '-L', 'default']);
  assert.ok(!argv.includes('--force'));
});

test('buildSendArgv appends --force only when asked', () => {
  assert.deepEqual(buildSendArgv(identity, { force: true }), [
    'mux',
    'send',
    '@7',
    '-',
    '--no-enter',
    '-L',
    'default',
    '--force',
  ]);
});

test('selectionLines trims an end at column 0 of a later line to the previous line', () => {
  assert.deepEqual(selectionLines({ line: 9, character: 2 }, { line: 12, character: 0 }), {
    startLine: 10,
    endLine: 12,
  });
});

test('selectionLines keeps a mid-line end on its own line', () => {
  assert.deepEqual(selectionLines({ line: 9, character: 0 }, { line: 11, character: 4 }), {
    startLine: 10,
    endLine: 12,
  });
});

test('selectionLines treats an empty cursor selection as its own single line', () => {
  assert.deepEqual(selectionLines({ line: 4, character: 0 }, { line: 4, character: 0 }), {
    startLine: 5,
    endLine: 5,
  });
});

test('formatReference renders a single line as path:N', () => {
  assert.equal(formatReference('src/a.ts', 10, 10), 'src/a.ts:10');
});

test('formatReference renders a range as path:N-M', () => {
  assert.equal(formatReference('src/a.ts', 10, 12), 'src/a.ts:10-12');
});

test('buildSendPayload joins ref and text verbatim, no fences, no trailing newline', () => {
  assert.equal(buildSendPayload('src/a.ts:10-12', 'const x = 1;\n'), 'src/a.ts:10-12\nconst x = 1;\n');
  assert.equal(buildSendPayload('src/a.ts:10', ''), 'src/a.ts:10\n');
});

test('parsePort accepts integers in 1–65535', () => {
  assert.equal(parsePort('1'), 1);
  assert.equal(parsePort('8080'), 8080);
  assert.equal(parsePort('65535'), 65535);
});

test('parsePort trims surrounding whitespace', () => {
  assert.equal(parsePort(' 8080 '), 8080);
});

test('parsePort rejects out-of-range and non-numeric input', () => {
  assert.equal(parsePort('0'), null);
  assert.equal(parsePort('65536'), null);
  assert.equal(parsePort('abc'), null);
  assert.equal(parsePort(''), null);
  assert.equal(parsePort('80.5'), null);
  assert.equal(parsePort('-3'), null);
});
