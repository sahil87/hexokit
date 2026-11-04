import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownsFile, buildBootMarker } from '../src/ownership';

test('ownsFile is true when the pid matches', () => {
  assert.equal(ownsFile('{"hostId":"a","pid":41230}', 41230), true);
});

test('ownsFile is false for a different pid', () => {
  assert.equal(ownsFile('{"hostId":"a","pid":41230}', 1), false);
});

test('ownsFile is false for non-JSON, a missing pid, or a non-numeric pid', () => {
  assert.equal(ownsFile('nope', 1), false);
  assert.equal(ownsFile('{"hostId":"a"}', 1), false);
  assert.equal(ownsFile('{"pid":"41230"}', 41230), false);
  assert.equal(ownsFile('null', 1), false);
});

test('buildBootMarker carries exactly the contract keys', () => {
  const marker = buildBootMarker({
    hostId: '3fa1c9d2e4b0',
    workspaceFile: '/home/u/.local/state/hexokit/code-workspaces/default/@7-3fa1c9.code-workspace',
    identity: { tab: '@7', server: 'default' },
    pid: 41230,
    extVersion: '2.25.0',
    now: new Date('2026-09-10T22:04:59.512Z'),
  });
  assert.deepEqual(marker, {
    hostId: '3fa1c9d2e4b0',
    workspaceFile: '/home/u/.local/state/hexokit/code-workspaces/default/@7-3fa1c9.code-workspace',
    tab: '@7',
    server: 'default',
    pid: 41230,
    extVersion: '2.25.0',
    startedAt: '2026-09-10T22:04:59.512Z',
  });
});
