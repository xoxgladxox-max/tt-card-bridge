import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { SyncEngine, compareSnapshot } from '../src/sync-engine.mjs';
import { SyncService } from '../src/sync-service.mjs';
import { FileSyncAdapter } from '../src/file-sync-adapter.mjs';
import { JobQueue, createBridgeServer } from '../src/bridge.mjs';
import { connection } from '../src/connection.mjs';
import { slotHash, readCardPng } from '../src/slots.mjs';
import { atomicJson, contained, hashObject, digest } from '../src/safety.mjs';
import { embedChara } from '../src/png.mjs';

const basePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-bridge-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function tree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = rel => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { const file = path.join(rel, e.name); if (e.isDirectory()) walk(file); else out[file] = fs.readFileSync(path.join(dir, file)).toString('base64'); } };
  walk(''); return out;
}
class MemoryAdapter {
  node = 'base'; remote = 'base'; base = slotHash('base'); writes = 0; pushes = 0; saved = 0; backupsTaken = 0; issues = []; failPush = false;
  async snapshot() {
    const data = { nodes: { slots: { 'field:description': { value: this.node, label: 'description', relPath: 'index.md' } } }, tavern: { slots: { 'field:description': { value: this.remote, label: 'description' } } }, baseline: this.base === undefined ? null : { slots: { 'field:description': this.base } }, issues: this.issues, expected: { card: slotHash(this.remote), world: null } };
    return { ...data, revision: hashObject(data) };
  }
  async writeBodies(p, s, updates) { for (const u of updates) { this.node = u.value; this.writes++; } }
  async backup() { this.backupsTaken++; return 'backup'; }
  async push() { this.pushes++; if (this.beforePush) await this.beforePush(); if (this.failPush) throw new Error('fake transport failed'); this.remote = this.node; }
  async saveBaseline(p, s) { this.saved++; if (this.node === this.remote) this.base = slotHash(this.node); }
  listCards() { return [{ cardFile: 'A.png', name: 'A' }, { cardFile: 'B.png', name: 'B' }]; }
}
function serviceFixture(t, adapter = new MemoryAdapter()) {
  const root = temp(t), cardsRoot = path.join(root, 'cards'), dir = path.join(cardsRoot, 'A');
  fs.mkdirSync(dir, { recursive: true });
  atomicJson(path.join(dir, '.card-forge', 'mirror.json'), { cardFile: 'A.png', hash: 'old-mirror' });
  atomicJson(path.join(dir, '.card-forge', 'tavern-sync.json'), { cardFile: 'A.png', slots: { 'field:description': slotHash('base') } });
  const service = new SyncService({ cardsRoot, runtimeRoot: path.join(root, 'runtime'), adapter });
  return { root, dir, service, adapter };
}

test('new service paused; legacy baseline retained; check/diff/status are read-only', async t => {
  const { root, service, adapter } = serviceFixture(t);
  adapter.node = 'local'; const before = tree(root);
  assert.equal((await service.status()).paused, true);
  assert.equal((await service.status()).projects[0].attached, true);
  assert.equal((await service.status()).unattachedCards, undefined);
  await assert.rejects(service.control({ action: 'check' }), e => e.code === 'PROJECT_REQUIRED');
  await service.control({ action: 'check', projectId: 'A' }); await service.control({ action: 'diff', projectId: 'A' });
  assert.deepEqual(tree(root), before); assert.equal(adapter.writes + adapter.pushes + adapter.saved, 0);
});
test('three-way sync pulls remote and pushes local with one comparison', async () => {
  const adapter = new MemoryAdapter(), engine = new SyncEngine(adapter);
  adapter.remote = 'remote'; await engine.run({}); assert.equal(adapter.node, 'remote'); assert.equal(adapter.base, slotHash('remote'));
  adapter.node = 'local'; await engine.run({}); assert.equal(adapter.remote, 'local'); assert.equal(adapter.base, slotHash('local'));
});
test('no baseline or two changed sides never silently overwrite', async () => {
  for (const base of [undefined, slotHash('base')]) {
    const a = new MemoryAdapter(); a.base = base; a.node = 'mine'; a.remote = 'theirs';
    await assert.rejects(new SyncEngine(a).run({}), e => e.code === 'CONFLICT');
    assert.equal(a.writes + a.pushes + a.saved + a.backupsTaken, 0);
  }
});
test('settings and structural differences explicitly block even force', async () => {
  const a = new MemoryAdapter(); a.node = 'mine'; a.issues = [{ kind: 'settings', message: 'different binding' }];
  await assert.rejects(new SyncEngine(a).run({}, { direction: 'push', force: true }), e => e.code === 'UNSUPPORTED_DIFFERENCE');
  assert.equal(a.pushes, 0);
  const s = await a.snapshot(); s.nodes.slots['entry:42'] = { value: 'new', label: 'new' };
  assert.ok(compareSnapshot(s).issues.some(i => i.kind === 'removed'));
});
test('failed transport is surfaced and leaves baseline dirty', async t => {
  const { adapter, service } = serviceFixture(t); adapter.node = 'local'; adapter.failPush = true;
  const result = await service.control({ action: 'sync', projectId: 'A' });
  assert.equal(result.results[0].status, 'error'); assert.match(result.results[0].error.message, /fake transport/);
  assert.equal(adapter.base, slotHash('base')); assert.equal(adapter.saved, 0); assert.equal((await service.status()).projects[0].status, 'error');
});
test('pull does not mark still-local changes as synchronized', async () => {
  const a = new MemoryAdapter(); a.node = 'local'; const base = a.base;
  const result = await new SyncEngine(a).run({}, { direction: 'pull' });
  assert.equal(result.status, 'pending'); assert.equal(a.base, base); assert.equal(a.remote, 'base');
});
test('preview stale check and explicit manual conflict decision', async t => {
  const { service, adapter } = serviceFixture(t); adapter.node = 'mine'; adapter.remote = 'theirs';
  let preview = await service.control({ action: 'diff', projectId: 'A' }); adapter.remote = 'newer';
  await assert.rejects(service.control({ action: 'resolve', projectId: 'A', previewId: preview.previewId, choices: [{ key: 'field:description', source: 'project' }] }), e => e.code === 'STALE_PREVIEW');
  assert.equal(adapter.writes + adapter.pushes, 0);
  preview = await service.control({ action: 'diff', projectId: 'A' });
  await service.control({ action: 'resolve', projectId: 'A', previewId: preview.previewId, choices: [{ key: 'field:description', source: 'manual', text: 'merged' }] });
  assert.equal(adapter.node, 'merged'); assert.equal(adapter.remote, 'merged'); assert.equal(adapter.base, slotHash('merged'));
});
test('pause lets an in-flight write finish and blocks future automatic work', async t => {
  const { service, adapter } = serviceFixture(t); adapter.node = 'local';
  let release, entered; const started = new Promise(r => entered = r); const gate = new Promise(r => release = r);
  adapter.beforePush = async () => { entered(); await gate; };
  await service.control({ action: 'followCard', cardFile: 'A.png' });
  await service.control({ action: 'resume' });
  const task = service.queue.run('automatic', () => service.batch('sync', undefined, true));
  await started; await service.control({ action: 'pause' }); assert.equal(adapter.remote, 'base'); release(); await task;
  assert.equal(adapter.remote, 'local'); adapter.node = 'later';
  await service.batch('sync', undefined, true); assert.equal(adapter.remote, 'local');
  await service.control({ action: 'projectPause', projectId: 'A', paused: true }); await service.control({ action: 'resume' });
  await service.batch('sync', undefined, true); assert.equal(adapter.remote, 'local');
});
test('service requests are serialized and queue failures do not swallow the next result', async t => {
  const { service, adapter } = serviceFixture(t); adapter.node = 'local';
  let release, entered; const gate = new Promise(r => release = r), started = new Promise(r => entered = r);
  adapter.beforePush = async () => { entered(); await gate; };
  const first = service.control({ action: 'sync', projectId: 'A' }); await started;
  let secondDone = false; const second = service.control({ action: 'check', projectId: 'A' }).then(x => { secondDone = true; return x; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(secondDone, false); release(); await first; await second;
  await assert.rejects(service.control({ action: 'nonsense' })); assert.ok((await service.control({ action: 'check', projectId: 'A' })).results.length);
});
test('automatic sync touches only the card open in the tavern; no open card means no work', async t => {
  const { service, adapter } = serviceFixture(t); adapter.node = 'local';
  await service.control({ action: 'resume' });
  assert.deepEqual((await service.batch('sync', undefined, true)).results, []); assert.equal(adapter.pushes, 0);
  await service.control({ action: 'followCard', cardFile: 'B.png' });
  assert.deepEqual((await service.batch('sync', undefined, true)).results, []); assert.equal(adapter.pushes, 0);
  await service.control({ action: 'followCard', cardFile: 'A.png' });
  const result = await service.batch('sync', undefined, true);
  assert.deepEqual(result.results.map(r => r.projectId), ['A']); assert.equal(adapter.remote, 'local');
});
test('card and skill jobs share FIFO and cannot overwrite active or duplicate IDs', () => {
  const q = new JobQueue(); q.publish('card', { id: 'one' }); q.publish('skills', { id: 'two' }); q.publish('card', { id: 'three' });
  assert.equal(q.active.job.id, 'one'); assert.throws(() => q.publish('card', { id: 'one' }), e => e.code === 'DUPLICATE_JOB');
  assert.throws(() => q.finish({ id: 'two' }), e => e.code === 'STALE_RESULT');
  assert.throws(() => q.finish({ id: 'one' }), e => e.code === 'UNCLAIMED_RESULT');
  assert.equal(q.claim({ id: 'one', consumerId: 'session-one' }).claimed, true);
  assert.equal(q.claim({ id: 'one', consumerId: 'session-two' }).claimed, false);
  assert.equal(q.claim({ id: 'one', consumerId: 'session-one' }).claimed, true);
  const result = { id: 'one', consumerId: 'session-one', ok: true };
  q.finish(result); q.finish(result); assert.equal(q.active.kind, 'skills');
  q.claim({ id: 'two', consumerId: 'session-two' });
  q.finish({ id: 'two', consumerId: 'session-two', fatal: 'failure' }); assert.equal(q.active.job.id, 'three');
  assert.equal(q.result('two').fatal, 'failure');
});
test('path escape, absolute identifiers and symlinked project are refused', async t => {
  const { service, root, dir } = serviceFixture(t);
  for (const projectId of ['../A', 'Work/../A', 'C:/A', 'Work\\A']) await assert.rejects(service.control({ action: 'diff', projectId }));
  await assert.rejects(service.control({ action: 'attach', cardFile: '../A.png' }), e => e.code === 'INVALID_PATH');
  await assert.rejects(service.control({ action: 'config', cardsRoot: root, pollIntervalMs: 1000 }), e => e.code === 'INVALID_CONFIG');
  const target = path.join(root, 'outside'); fs.mkdirSync(target);
  const link = path.join(dir, 'escape'); fs.symlinkSync(target, link, 'junction');
  assert.throws(() => contained(dir, 'escape/file.md'), e => e.code === 'INVALID_PATH');
});
test('all HTTP endpoints authenticated; origin/body limited; preflight discloses no state', async t => {
  const { server } = createBridgeServer({ token: 'x'.repeat(64), maxBodyBytes: 64, origins: ['tauri://localhost'], service: { status: () => ({ paused: true }), control: b => b } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/tt-bridge`, headers = { Authorization: `Bearer ${'x'.repeat(64)}` };
  for (const route of ['status', 'version', 'skills/result?id=a']) assert.equal((await fetch(`${base}/${route}`)).status, 401);
  assert.equal((await fetch(`${base}/status`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/status`, { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(`${base}/control`, { method: 'POST', headers, body: '{broken' })).status, 400);
  assert.equal((await fetch(`${base}/control`, { method: 'POST', headers, body: JSON.stringify({ content: 'x'.repeat(100) }) })).status, 413);
  assert.equal((await fetch(`${base}/version`, { method: 'OPTIONS', headers: { Origin: 'tauri://localhost' } })).status, 204);
});
test('one persistent token reused; injected token never overwrites configuration', t => {
  const root = temp(t); const a = connection({ root, env: {} }), b = connection({ root, env: {} }); assert.equal(a.token, b.token);
  assert.equal(connection({ root, env: { TT_BRIDGE_TOKEN: 'y'.repeat(64) } }).token, 'y'.repeat(64));
  assert.equal(connection({ root, env: {} }).token, a.token);
});

async function fileFixture(t, withWorld = false) {
  const root = temp(t), cardsRoot = path.join(root, 'cards'), userDir = path.join(root, 'tavern');
  fs.mkdirSync(path.join(userDir, 'characters'), { recursive: true }); fs.mkdirSync(path.join(userDir, 'worlds'), { recursive: true });
  const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'A', description: 'base', personality: '', scenario: '', first_mes: '', mes_example: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], extensions: {} } };
  if (withWorld) { card.data.extensions.world = 'Book'; card.data.character_book = { name: 'Book', entries: [] }; atomicJson(path.join(userDir, 'worlds', 'Book.json'), { entries: { 42: { uid: 42, key: ['key'], keysecondary: [], content: 'external body', comment: 'entry', constant: false, disable: false, order: 100, position: 0, depth: 4 } } }); }
  const pngPath = path.join(userDir, 'characters', 'A.png'); fs.writeFileSync(pngPath, embedChara(basePng, card));
  const transport = async job => {
    if (job.expected.card !== digest(fs.readFileSync(pngPath))) return { id: job.id, fatal: 'stale card' };
    if (job.op === 'restore') {
      const imported = readCardPng(Buffer.from(job.pngBase64, 'base64'));
      imported.create_date = 'imported-date'; imported.chat = 'imported-chat'; imported.fav = false;
      imported.data.create_date = 'imported-date'; imported.data.chat = 'imported-chat'; imported.data.fav = false; imported.data.extensions.fav = false;
      fs.writeFileSync(pngPath, embedChara(basePng, imported));
      if (job.worldName && job.world) atomicJson(path.join(userDir, 'worlds', `${job.worldName}.json`), job.world);
      return { id: job.id, restored: true, mode: 'import' };
    }
    fs.writeFileSync(pngPath, embedChara(fs.readFileSync(pngPath), job.card));
    return { id: job.id, card: 'written' };
  };
  const adapter = new FileSyncAdapter({ skillsRoot: config.skillsRoot, userDir, transport, queryResult: async () => ({ pending: true }) });
  const service = new SyncService({ cardsRoot, runtimeRoot: path.join(root, 'runtime'), adapter });
  return { root, userDir, cardsRoot, adapter, service, pngPath };
}
test('forge attach keeps original PNG, rejects initial same-name directory, and verifies external world', async t => {
  const f = await fileFixture(t, true), original = fs.readFileSync(f.pngPath);
  fs.mkdirSync(path.join(f.cardsRoot, 'A'), { recursive: true });
  await assert.rejects(f.service.control({ action: 'attach', cardFile: 'A.png' }), e => e.code === 'ATTACH_CONFLICT');
  fs.rmdirSync(path.join(f.cardsRoot, 'A'));
  const project = await f.service.control({ action: 'attach', cardFile: 'A.png' }); assert.equal(project.attached, true);
  assert.deepEqual(fs.readFileSync(f.pngPath), original);
  assert.deepEqual(fs.readFileSync(path.join(f.cardsRoot, 'A', '.card-forge', 'originals', 'A.png')), original);
  const diff = await f.service.control({ action: 'diff', projectId: project.id }); assert.equal(diff.clean, true); assert.ok(diff.slots.some(s => s.tavern === 'external body' && s.node === 'external body'));
});
test('attach accepts a fresh Tavern card whose character_book is null', async t => {
  const f = await fileFixture(t);
  const card = readCardPng(f.pngPath); card.data.character_book = null; card.data.extensions.world = '';
  fs.writeFileSync(f.pngPath, embedChara(fs.readFileSync(f.pngPath), card));
  const original = fs.readFileSync(f.pngPath);
  const project = await f.service.control({ action: 'attach', cardFile: 'A.png' }); assert.equal(project.attached, true);
  assert.deepEqual(fs.readFileSync(f.pngPath), original);
  assert.equal((await f.service.control({ action: 'diff', projectId: project.id })).clean, true);
  assert.deepEqual(fs.readdirSync(f.cardsRoot).filter(n => n.startsWith('.attach-')), []);
});
test('import restore requires preview/confirmation, rebuilds actual baseline and stays paused', async t => {
  const f = await fileFixture(t); const p = await f.service.control({ action: 'attach', cardFile: 'A.png' });
  const project = f.service.getProject(p.id), before = await f.adapter.snapshot(project), statePath = path.join(project.dir, '.card-forge', 'tavern-sync.json');
  const backupId = await f.adapter.backup(project, before);
  await f.adapter.writeBodies(project, before, [{ key: 'field:description', value: 'changed' }]);
  await f.service.control({ action: 'sync', projectId: p.id }); assert.equal(readCardPng(f.pngPath).data.description, 'changed');
  const preview = await f.service.control({ action: 'restorePreview', projectId: p.id, backupId });
  await assert.rejects(f.service.control({ action: 'restore', projectId: p.id, previewId: preview.previewId }), e => e.code === 'CONFIRMATION_REQUIRED');
  const result = await f.service.control({ action: 'restore', projectId: p.id, previewId: preview.previewId, confirm: true });
  assert.equal(result.status, 'restored'); assert.equal(result.mode, 'import'); assert.equal(preview.mode, 'import'); assert.equal(preview.canRestore, true); assert.equal(readCardPng(f.pngPath).data.description, 'base');
  const actual = f.adapter.remote(project), state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(state.slots, Object.fromEntries(Object.entries(actual.tavern.slots).map(([key, slot]) => [key, slotHash(slot.value)])));
  assert.deepEqual((await f.adapter.snapshot(project)).rawFiles, before.rawFiles); assert.equal((await f.service.status()).projects[0].paused, true);
  fs.mkdirSync(path.join(f.adapter.backupRoot(project), 'push-old'), { recursive: true });
  const old = (await f.service.control({ action: 'backups', projectId: p.id })).backups.find(b => b.id === 'push-old'); assert.equal(old.supported, false);
});
test('import accepts PNG metadata changes, preserves body/world and aligns only host-owned node metadata', async t => {
  const f = await fileFixture(t, true), original = readCardPng(f.pngPath);
  original.data.create_date = 'old-date'; original.data.chat = 'old-chat'; original.data.fav = true; original.data.extensions.fav = true;
  fs.writeFileSync(f.pngPath, embedChara(basePng, original));
  const p = await f.service.control({ action: 'attach', cardFile: 'A.png' }), project = f.service.getProject(p.id);
  const before = await f.adapter.snapshot(project), backupId = await f.adapter.backup(project, before);
  const changed = readCardPng(f.pngPath); changed.data.description = 'current, not backup'; fs.writeFileSync(f.pngPath, embedChara(basePng, changed));
  atomicJson(path.join(f.userDir, 'worlds', 'Book.json'), { entries: {} });
  const preview = await f.service.control({ action: 'restorePreview', projectId: p.id, backupId });
  const result = await f.service.control({ action: 'restore', projectId: p.id, previewId: preview.previewId, confirm: true });
  const after = await f.adapter.snapshot(project), imported = readCardPng(f.pngPath);
  assert.equal(result.mode, 'import'); assert.equal((await f.service.status()).capabilities.restoreMode, 'import');
  assert.notEqual(digest(fs.readFileSync(f.pngPath)), digest(before.png)); assert.equal(imported.data.description, 'base');
  assert.equal(imported.data.create_date, 'imported-date'); assert.equal(after.card.data.chat, 'imported-chat'); assert.equal(after.card.data.extensions.fav, false);
  assert.equal(after.tavern.slots['entry:42'].value, 'external body'); assert.equal(compareSnapshot(after).clean, true);
  assert.equal(f.service.getProject(p.id).paused, true); assert.ok(result.safetyBackupId);
});
test('import still rejects wrong body, author settings or world data', async t => {
  for (const changedPart of ['description', 'name', 'world']) {
    const f = await fileFixture(t, true), p = await f.service.control({ action: 'attach', cardFile: 'A.png' }), project = f.service.getProject(p.id);
    const before = await f.adapter.snapshot(project), backupId = await f.adapter.backup(project, before), stateFile = path.join(project.dir, '.card-forge', 'tavern-sync.json'), baseline = fs.readFileSync(stateFile, 'utf8');
    const transport = f.adapter.transport;
    f.adapter.transport = async job => {
      const result = await transport(job);
      if (changedPart === 'world') atomicJson(path.join(f.userDir, 'worlds', 'Book.json'), { entries: {} });
      else { const card = readCardPng(f.pngPath); card.data[changedPart] = 'incorrect import'; fs.writeFileSync(f.pngPath, embedChara(basePng, card)); }
      return result;
    };
    const preview = await f.service.control({ action: 'restorePreview', projectId: p.id, backupId });
    await assert.rejects(f.service.control({ action: 'restore', projectId: p.id, previewId: preview.previewId, confirm: true }), e => e.code === 'RESTORE_VERIFY_FAILED');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), baseline); assert.equal(f.service.getProject(p.id).paused, true);
  }
});
test('failed restore keeps card paused and prevents resume/sync until complete recovery', async t => {
  const f = await fileFixture(t); const p = await f.service.control({ action: 'attach', cardFile: 'A.png' }); const project = f.service.getProject(p.id);
  const backupId = await f.adapter.backup(project, await f.adapter.snapshot(project));
  const preview = await f.service.control({ action: 'restorePreview', projectId: p.id, backupId });
  f.adapter.transport = async job => ({ id: job.id, fatal: 'restore unsupported' });
  await assert.rejects(f.service.control({ action: 'restore', projectId: p.id, previewId: preview.previewId, confirm: true }), e => e.code === 'RESTORE_FAILED');
  await assert.rejects(f.service.control({ action: 'projectPause', projectId: p.id, paused: false }), e => e.code === 'RESTORE_REQUIRED');
  const result = await f.service.control({ action: 'sync', projectId: p.id }); assert.equal(result.results[0].error.code, 'RESTORE_REQUIRED');
});

test('stable world digest is shared with browser and ignores only object order/formatting', async t => {
  const { worldDigest } = await import('../extension/protocol.js');
  const a = { entries: { 1: { key: ['a', 'b'], content: 'x' } }, extra: true };
  const b = { extra: true, entries: { 1: { content: 'x', key: ['a', 'b'] } } };
  assert.equal(await worldDigest(a), hashObject(b));
  assert.notEqual(await worldDigest(a), await worldDigest({ ...b, entries: { 1: { content: 'x', key: ['b', 'a'] } } }));
  const f = await fileFixture(t, true), remote = f.adapter.remote({ cardFile: 'A.png' });
  assert.equal(remote.expected.world, await worldDigest(JSON.parse(remote.worldRaw)));
  assert.equal(remote.expected.worldName, 'Book');
});
test('clean sync does not churn baseline or invalidate diff preview', async t => {
  const f = await fileFixture(t); const p = await f.service.control({ action: 'attach', cardFile: 'A.png' });
  const before = tree(path.join(f.cardsRoot, 'A'));
  const a = await f.service.control({ action: 'diff', projectId: p.id });
  await f.service.control({ action: 'sync', projectId: p.id });
  const b = await f.service.control({ action: 'diff', projectId: p.id });
  assert.equal(a.revision, b.revision); assert.deepEqual(tree(path.join(f.cardsRoot, 'A')), before);
});
test('complete backups restore pending files together with their baseline references', async t => {
  const f = await fileFixture(t); const p = await f.service.control({ action: 'attach', cardFile: 'A.png' }); const project = f.service.getProject(p.id);
  const stateFile = path.join(project.dir, '.card-forge', 'tavern-sync.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.pending = { 'field:description': { file: '待归位/conflict.md', tavern: slotHash('base') } };
  atomicJson(stateFile, state); fs.mkdirSync(path.join(project.dir, '待归位')); fs.writeFileSync(path.join(project.dir, '待归位', 'conflict.md'), 'original conflict');
  const backupId = await f.adapter.backup(project, await f.adapter.snapshot(project));
  fs.unlinkSync(path.join(project.dir, '待归位', 'conflict.md'));
  const preview = await f.service.control({ action: 'restorePreview', projectId: p.id, backupId });
  await f.service.control({ action: 'restore', projectId: p.id, previewId: preview.previewId, confirm: true });
  assert.equal(fs.readFileSync(path.join(project.dir, '待归位', 'conflict.md'), 'utf8'), 'original conflict');
  const restoredState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(restoredState.pending, state.pending); assert.equal(restoredState.cardFile, state.cardFile);
  assert.deepEqual(restoredState.slots, Object.fromEntries(Object.entries(f.adapter.remote(project).tavern.slots).map(([key, slot]) => [key, slotHash(slot.value)])));
});

// New-entry tests use the real forge parser/assembler and common file adapter.
async function newEntryFixture(t, front = '') {
  const f = await fileFixture(t);
  const p = await f.service.control({ action: 'attach', cardFile: 'A.png' });
  const project = f.service.getProject(p.id);
  const file = path.join(project.dir, 'world_book', 'new-entry.md');
  const raw = `---\n# retain this comment\ntype: lore\ntarget: character_book\ntitle: New entry\nkeys: [new]\n${front}---\n\n<!-- body -->\nNew entry body.\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, raw);
  return { ...f, project, file, raw, engine: new SyncEngine(f.adapter) };
}
test('new world file: read-only preview, backed-up ID, push and baseline, no duplicate after rename', async t => {
  const f = await newEntryFixture(t), originalTree = tree(f.project.dir);
  const a = await f.adapter.snapshot(f.project), b = await f.adapter.snapshot(f.project);
  assert.equal(a.idAssignments.length, 1); assert.deepEqual(a.idAssignments, b.idAssignments);
  assert.deepEqual(tree(f.project.dir), originalTree);
  assert.equal(compareSnapshot(a).slots.filter(s => s.newEntry).length, 1);
  const result = await f.engine.run(f.project);
  assert.equal(result.status, 'clean'); assert.equal(result.assignedIds.length, 1);
  const { id, uid, relPath } = result.assignedIds[0], written = fs.readFileSync(f.file, 'utf8');
  assert.equal(written.replace(`id: ${id}\n`, ''), f.raw);
  const backup = JSON.parse(fs.readFileSync(path.join(f.adapter.backupRoot(f.project), result.backupId, 'snapshot.json'), 'utf8'));
  assert.equal(backup.nodes[relPath], f.raw);
  const card = readCardPng(f.pngPath); assert.equal(card.data.character_book.entries.length, 1);
  assert.equal(card.data.character_book.entries[0].id, uid);
  assert.equal(card.data.character_book.entries[0].content, 'New entry body.');
  const state = JSON.parse(fs.readFileSync(path.join(f.project.dir, '.card-forge/tavern-sync.json'), 'utf8'));
  assert.equal(state.slots[`entry:${uid}`], slotHash('New entry body.'));
  const png = fs.readFileSync(f.pngPath); assert.equal((await f.engine.run(f.project)).changed, false);
  fs.renameSync(f.file, path.join(f.project.dir, 'world_book', 'renamed-entry.md'));
  assert.equal((await f.engine.run(f.project)).changed, false);
  assert.deepEqual(fs.readFileSync(f.pngPath), png);
  assert.equal((await f.adapter.snapshot(f.project)).idAssignments.length, 0);
});
test('new entry pull does not push or mark it synchronized; later push uses persisted identity', async t => {
  const f = await newEntryFixture(t), before = fs.readFileSync(f.pngPath);
  const result = await f.engine.run(f.project, { direction: 'pull' });
  assert.equal(result.status, 'pending'); assert.deepEqual(fs.readFileSync(f.pngPath), before);
  const planned = await f.adapter.snapshot(f.project); assert.equal(planned.idAssignments.length, 0);
  const key = Object.keys(planned.nodes.slots).find(k => k.startsWith('entry:'));
  assert.equal(Object.hasOwn(planned.baseline.slots, key), false);
  assert.equal((await f.engine.run(f.project, { direction: 'push' })).status, 'clean');
});
test('existing author id and character fields are not rewritten', async t => {
  const f = await newEntryFixture(t, 'id: author-entry\n');
  const before = await f.adapter.snapshot(f.project); assert.equal(before.idAssignments.length, 0);
  const characterFiles = Object.fromEntries(Object.entries(before.rawFiles).filter(([p]) => p.startsWith('character/')));
  assert.equal((await f.engine.run(f.project)).status, 'clean');
  const after = await f.adapter.snapshot(f.project);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.raw);
  for (const [p, text] of Object.entries(characterFiles)) assert.equal(after.rawFiles[p], text);
});
test('field files without id keep their fixed implied id and are never rewritten', async t => {
  const f0 = await fileFixture(t), p = await f0.service.control({ action: 'attach', cardFile: 'A.png' });
  const f = { ...f0, project: f0.service.getProject(p.id), engine: new SyncEngine(f0.adapter) };
  const field = path.join(f.project.dir, 'personality.md'), raw = 'plain personality body\n';
  fs.writeFileSync(field, raw);
  const result = await f.engine.run(f.project);
  assert.equal(result.status, 'clean', JSON.stringify(result));
  assert.equal(fs.readFileSync(field, 'utf8'), raw);
  assert.equal(readCardPng(f.pngPath).data.personality, 'plain personality body');
});
test('new entry without reliable matching baseline is refused before ID write even with force', async t => {
  for (const state of [null, { cardFile: 'other.png', slots: {} }, { cardFile: 'A.png', slots: { bad: 'invalid-hash' } }]) {
    const f = await newEntryFixture(t), file = path.join(f.project.dir, '.card-forge/tavern-sync.json');
    if (state === null) fs.unlinkSync(file); else atomicJson(file, state);
    const before = tree(f.project.dir), png = fs.readFileSync(f.pngPath);
    await assert.rejects(f.engine.run(f.project, { direction: 'push', force: true }), e => e.code === 'UNSUPPORTED_DIFFERENCE');
    assert.deepEqual(tree(f.project.dir), before); assert.deepEqual(fs.readFileSync(f.pngPath), png);
  }
});
test('remote deletion is not resurrected, including a UID retained after both sides removed it', async t => {
  const f = await newEntryFixture(t); const result = await f.engine.run(f.project);
  const card = readCardPng(f.pngPath); card.data.character_book.entries = [];
  fs.writeFileSync(f.pngPath, embedChara(basePng, card));
  const png = fs.readFileSync(f.pngPath), raw = fs.readFileSync(f.file, 'utf8');
  await assert.rejects(f.engine.run(f.project, { direction: 'push', force: true }), e => e.code === 'UNSUPPORTED_DIFFERENCE');
  assert.deepEqual(fs.readFileSync(f.pngPath), png);
  fs.unlinkSync(f.file); assert.equal((await f.engine.run(f.project)).status, 'clean');
  const s = await f.adapter.snapshot(f.project); assert.ok(s.baseline.slots[`entry:${result.assignedIds[0].uid}`]);
  fs.writeFileSync(f.file, raw);
  await assert.rejects(f.engine.run(f.project), e => e.code === 'UNSUPPORTED_DIFFERENCE');
});
test('duplicate explicit UIDs fail rather than overwrite either entry', async t => {
  const f = await newEntryFixture(t, 'id: author-one\ntavern:\n  id: 77\n');
  const other = path.join(f.project.dir, 'world_book', 'other.md');
  fs.writeFileSync(other, f.raw.replace('author-one', 'author-two'));
  const before = tree(f.project.dir);
  await assert.rejects(f.engine.run(f.project), e => e.code === 'ENTRY_UID_COLLISION');
  assert.deepEqual(tree(f.project.dir), before);
});
test('generated UID avoids remote and historical collisions; explicit occupied UID is rejected', async t => {
  const f = await newEntryFixture(t), libs = await f.adapter.libraries();
  const { planWorldEntryIds } = await import('../src/world-entry-ids.mjs');
  const local = f.adapter.localSnapshot(f.project), snap = await f.adapter.snapshot(f.project);
  const uid = snap.idAssignments[0].uid;
  for (const [remote, baseline] of [[{ [`entry:${uid}`]: { value: 'remote' } }, null], [{}, { slots: { [`entry:${uid}`]: slotHash('old') } }]]) {
    const scan = await libs.nodes.scanCard(f.project.dir);
    const assignments = planWorldEntryIds(scan, local.rawFiles, remote, baseline, libs);
    assert.notEqual(assignments[0].uid, uid);
  }
  fs.writeFileSync(f.file, f.raw.replace('title: New entry', `tavern:\n  id: ${uid}\ntitle: New entry`));
  const scan = await libs.nodes.scanCard(f.project.dir), current = f.adapter.localSnapshot(f.project);
  assert.throws(() => planWorldEntryIds(scan, current.rawFiles, { [`entry:${uid}`]: { value: 'occupied' } }, null, libs), e => e.code === 'ENTRY_UID_COLLISION');
});
test('editing during backup invalidates new-entry plan without replacing author text or pushing', async t => {
  const f = await newEntryFixture(t), backup = f.adapter.backup.bind(f.adapter), png = fs.readFileSync(f.pngPath);
  f.adapter.backup = async (...args) => { const id = await backup(...args); fs.writeFileSync(f.file, f.raw + 'Concurrent edit.\n'); return id; };
  await assert.rejects(f.engine.run(f.project), e => e.code === 'STALE_PREVIEW');
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.raw + 'Concurrent edit.\n');
  assert.deepEqual(fs.readFileSync(f.pngPath), png);
});
test('bad file format pauses only this card with file list, touches nothing', async t => {
  const f = await newEntryFixture(t), png = fs.readFileSync(f.pngPath);
  fs.writeFileSync(f.file, '---\ntype: lore\ntitle: Broken\n---\nno body mark here\n');
  const before = tree(f.project.dir);
  await assert.rejects(f.engine.run(f.project), e => e.code === 'INVALID_FORMAT' && e.details.badFiles.some(b => b.relPath === 'world_book/new-entry.md'));
  assert.deepEqual(tree(f.project.dir), before); assert.deepEqual(fs.readFileSync(f.pngPath), png);
});
test('notes in card root do not change local revision; sync files do', async t => {
  const f = await newEntryFixture(t), rev = f.adapter.localRevision(f.project);
  fs.writeFileSync(path.join(f.project.dir, '笔记.txt'), 'draft');
  fs.mkdirSync(path.join(f.project.dir, '调研')); fs.writeFileSync(path.join(f.project.dir, '调研', 'a.md'), 'x');
  assert.equal(f.adapter.localRevision(f.project), rev);
  fs.writeFileSync(f.file, f.raw + 'more\n');
  assert.notEqual(f.adapter.localRevision(f.project), rev);
});
test('queue: different cards run in parallel, same card in order, global waits for all', async t => {
  const { SerialQueue } = await import('../src/safety.mjs');
  const q = new SerialQueue(), log = [];
  let releaseA; const gateA = new Promise(r => { releaseA = r; });
  const a1 = q.run('a1', async () => { await gateA; log.push('a1'); }, 'a');
  const a2 = q.run('a2', async () => { log.push('a2'); }, 'a');
  await q.run('b1', async () => { log.push('b1'); }, 'b');
  assert.deepEqual(log, ['b1']); assert.equal(q.busy('a'), true); assert.equal(q.busy('b'), false);
  const g = q.run('g', async () => { log.push('g'); });
  const b2 = q.run('b2', async () => { log.push('b2'); }, 'b');
  releaseA(); await Promise.all([a1, a2, g, b2]);
  assert.deepEqual(log, ['b1', 'a1', 'a2', 'g', 'b2']);
  assert.equal(q.size, 0); await q.tail;
});
test('service.json is filled with defaults and bad values are corrected', async () => {
  const { normalizeState, DEFAULT_STATE } = await import('../src/sync-service.mjs');
  assert.deepEqual(normalizeState(null), { ...DEFAULT_STATE });
  const s = normalizeState({ paused: 'no', pollIntervalMs: 5, autoBackupBeforeOverwrite: false, activeCardFile: '  A.png ', assembleRoot: 'D:\\old' });
  assert.equal(s.paused, true); assert.equal(s.pollIntervalMs, 2000); assert.equal(s.autoBackupBeforeOverwrite, false);
  assert.equal(s.activeCardFile, 'A.png'); assert.equal('assembleRoot' in s, false);
});
