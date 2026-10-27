import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRebindEntries } from '../src/world-entry-ids.mjs';

const L = (relPath, title, body, uid) => ({ relPath, title, body, uid });
test('rebind matching: same title+body pairs, same title only asks, unmatched local gets a free uid when its old one is taken', () => {
  const locals = [L('a.md', 'A', 'x', '1'), L('b.md', 'B', 'y', '2'), L('c.md', 'C', 'z', '3')];
  const remotes = [{ uid: 10, title: 'A', body: 'x' }, { uid: 11, title: 'B', body: 'changed' }, { uid: 3, title: 'D', body: 'w' }];
  const asked = matchRebindEntries(locals, remotes);
  assert.deepEqual(asked.ambiguous.map(a => a.relPath), ['b.md']);
  assert.deepEqual(asked.changes.map(c => [c.relPath, c.to, c.reason]), [['a.md', 10, 'paired'], ['c.md', 12, 'reassigned']]);
  const paired = matchRebindEntries(locals, remotes, { 'b.md': 'pair' });
  assert.deepEqual(paired.changes.map(c => [c.relPath, c.to]), [['a.md', 10], ['b.md', 11], ['c.md', 12]]);
  assert.deepEqual(paired.remoteOnly.map(r => r.title), ['D']);
  assert.deepEqual(paired.localOnly.map(r => r.relPath), ['c.md']);
  const same = matchRebindEntries([L('a.md', 'A', 'x', '10')], [{ uid: 10, title: 'A', body: 'x' }]);
  assert.deepEqual(same.changes, []);
});