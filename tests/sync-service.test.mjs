import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { SyncEngine, compareSnapshot } from '../src/sync-engine.mjs';
import { SyncService, normalizeState, DEFAULT_STATE } from '../src/sync-service.mjs';
import { FileSyncAdapter } from '../src/file-sync-adapter.mjs';
import { JobQueue, createBridgeServer } from '../src/bridge.mjs';
import { connection } from '../src/connection.mjs';
import { slotHash, readCardPng } from '../src/slots.mjs';
import { atomicJson, contained, hashObject, digest, SerialQueue } from '../src/safety.mjs';
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
  node = 'base'; remote = 'base'; base = slotHash('base'); writes = 0; pushes = 0; saved = 0; issues = []; failPush = false;
  async snapshot() {
    const data = { nodes: { slots: { 'field:description': { value: this.node, label: 'description', relPath: 'index.md' } } }, tavern: { slots: { 'field:description': { value: this.remote, label: 'description' } } }, baseline: this.base === undefined ? null : { slots: { 'field:description': this.base } }, issues: this.issues, expected: { card: slotHash(this.remote), world: null } };
    return { ...data, revision: hashObject(data) };
  }
  async writeBodies(p, s, updates) { for (const u of updates) { this.node = u.value; this.writes++; } }
  async push() { this.pushes++; if (this.beforePush) await this.beforePush(); if (this.failPush) throw new Error('fake transport failed'); this.remote = this.node; }
  async saveBaseline() { this.saved++; if (this.node === this.remote) this.base = slotHash(this.node); }
  listCards() { return [{ cardFile: 'A.png', name: 'A' }, { cardFile: 'B.png', name: 'B' }]; }
}
function serviceFixture(t, adapter = new MemoryAdapter(), { debounceMs = 10, fallbackMs = 1000, watch = null } = {}) {
  const root = temp(t), cardsRoot = path.join(root, 'cards'), dir = path.join(cardsRoot, 'A');
  fs.mkdirSync(dir, { recursive: true });
  atomicJson(path.join(dir, '.card-forge', 'mirror.json'), { cardFile: 'A.png', hash: 'old-mirror' });
  atomicJson(path.join(dir, '.card-forge', 'tavern-sync.json'), { cardFile: 'A.png', slots: { 'field:description': slotHash('base') } });
  const service = new SyncService({ cardsRoot, runtimeRoot: path.join(root, 'runtime'), adapter, debounceMs, fallbackMs, ...(watch ? { watch } : {}) });
  t.after(() => service.stop());
  return { root, dir, service, adapter };
}

test('new service paused; legacy baseline retained; check/status are read-only', async t => {
  const { root, service, adapter } = serviceFixture(t);
  adapter.node = 'local'; const before = tree(root);
  assert.equal((await service.status()).paused, true);
  assert.equal((await service.status()).projects[0].attached, true);
  assert.equal((await service.status()).unattachedCards, undefined);
  await assert.rejects(service.control({ action: 'check' }), e => e.code === 'PROJECT_REQUIRED');
  const checked = await service.control({ action: 'check', projectId: 'A' });
  assert.equal(checked.results[0].diff.clean, false);
  assert.deepEqual(tree(root), before); assert.equal(adapter.writes + adapter.pushes + adapter.saved, 0);
});
test('three-way sync pulls remote and pushes local with one comparison', async () => {
  const adapter = new MemoryAdapter(), engine = new SyncEngine(adapter);
  adapter.remote = 'remote'; await engine.run({}); assert.equal(adapter.node, 'remote'); assert.equal(adapter.base, slotHash('remote'));
  adapter.node = 'local'; await engine.run({}); assert.equal(adapter.remote, 'local'); assert.equal(adapter.base, slotHash('local'));
});
test('no baseline or two changed sides never silently overwrite; replaceRemote overwrites with local', async () => {
  for (const base of [undefined, slotHash('base')]) {
    const a = new MemoryAdapter(); a.base = base; a.node = 'mine'; a.remote = 'theirs';
    await assert.rejects(new SyncEngine(a).run({}), e => e.code === 'CONFLICT');
    assert.equal(a.writes + a.pushes + a.saved, 0);
    await new SyncEngine(a).run({}, { replaceRemote: true });
    assert.equal(a.remote, 'mine'); assert.equal(a.base, slotHash('mine'));
  }
});
test('settings and structural differences block normal sync; replaceRemote pushes local as truth', async () => {
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
test('pause lets an in-flight write finish and blocks future automatic work', async t => {
  const { service, adapter } = serviceFixture(t);
  await service.control({ action: 'followCard', cardFile: 'A.png' });
  await service.control({ action: 'resume' });
  // 先在一致状态下连上（进入 live）
  assert.equal((await service.batch('sync', undefined, true)).results[0].status, 'clean');
  let release, entered; const started = new Promise(r => entered = r); const gate = new Promise(r => release = r);
  adapter.node = 'local';
  adapter.beforePush = async () => { entered(); await gate; };
  const task = service.batch('sync', undefined, true);
  await started; await service.control({ action: 'pause' }); assert.equal(adapter.remote, 'base'); release(); await task;
  assert.equal(adapter.remote, 'local'); adapter.node = 'later'; adapter.beforePush = null;
  assert.deepEqual((await service.batch('sync', undefined, true)).results, []); assert.equal(adapter.remote, 'local');
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
  assert.deepEqual(result.results.map(r => r.projectId), ['A']); assert.equal(result.results[0].status, 'needsReconnect'); assert.equal(adapter.remote, 'base');
});
test('reconnect rule: clean connects directly and syncs live; dirty pauses as needsReconnect until reconnectOverwrite or reconnectNew', async t => {
  const { service, adapter } = serviceFixture(t); adapter.node = 'local';
  await service.control({ action: 'followCard', cardFile: 'A.png' }); await service.control({ action: 'resume' });
  for (let i = 0; i < 3; i++) {
    const r = await service.batch('sync', undefined, true);
    assert.equal(r.results[0].status, 'needsReconnect');
    assert.deepEqual(r.results[0].diff.changedSlots.map(s => s.kind), ['project']);
  }
  assert.equal(adapter.writes + adapter.pushes + adapter.saved, 0);
  assert.equal(service.logs.filter(l => l.action === 'needsReconnect').length, 1);
  assert.equal((await service.status()).projects[0].status, 'needsReconnect');
  // 选「以本地为准覆盖」后写入并进入持续连着状态（live）
  await service.control({ action: 'reconnectOverwrite', projectId: 'A' });
  assert.equal(adapter.remote, 'local'); assert.equal(adapter.base, slotHash('local'));
  assert.equal((await service.status()).projects[0].status, 'clean');
  // 持续连着时只改一边（本地或酒馆）直接自动同步，不再弹窗
  adapter.node = 'live local';
  let r = await service.batch('sync', undefined, true);
  assert.equal(r.results[0].status, 'clean'); assert.equal(adapter.remote, 'live local');
  adapter.remote = 'live tavern';
  r = await service.batch('sync', undefined, true);
  assert.equal(r.results[0].status, 'clean'); assert.equal(adapter.node, 'live tavern');
  // 连着时两边同时改了：停下进入 needsReconnect
  adapter.node = 'mine'; adapter.remote = 'theirs';
  r = await service.batch('sync', undefined, true);
  assert.equal(r.results[0].status, 'needsReconnect');
  assert.equal(adapter.node, 'mine'); assert.equal(adapter.remote, 'theirs');
  await service.control({ action: 'reconnectOverwrite', projectId: 'A' });
  assert.equal(adapter.remote, 'mine');
  // 暂停或后台重启算断开：断开期间酒馆改过，重连时即使只有一边改了也必须进入 needsReconnect，不能把断开期间酒馆的改动直接写进本地
  await service.control({ action: 'pause' }); adapter.remote = 'offline tavern edit'; await service.control({ action: 'resume' });
  r = await service.batch('sync', undefined, true);
  assert.equal(r.results[0].status, 'needsReconnect'); assert.equal(adapter.node, 'mine');
  const restarted = new SyncService({ cardsRoot: service.cardsRoot, runtimeRoot: service.runtimeRoot, adapter });
  t.after(() => restarted.stop());
  r = await restarted.batch('sync', undefined, true);
  assert.equal(r.results[0].status, 'needsReconnect'); assert.equal(adapter.node, 'mine');
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
test('path escape, absolute identifiers, removed legacy actions and symlinked project are refused', async t => {
  const { service, root, dir } = serviceFixture(t);
  for (const projectId of ['../A', 'Work/../A', 'C:/A', 'Work\\A']) await assert.rejects(service.control({ action: 'check', projectId }), e => e.code === 'INVALID_PATH');
  await assert.rejects(service.control({ action: 'attach', cardFile: '../A.png' }), e => e.code === 'INVALID_PATH');
  for (const action of ['diff', 'resolve', 'backups', 'restorePreview', 'restore', 'rebind', 'buildCard', 'setBackupDir', 'setAutoBackup', 'setBackupKeep']) {
    await assert.rejects(service.control({ action, projectId: 'A' }), e => e.code === 'INVALID_ACTION');
  }
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
  const writeWorldEntries = (worldName, entriesArr) => {
    const entries = Object.fromEntries((entriesArr ?? []).map((e, i) => { const x = e.extensions ?? {}; return [String(e.id ?? i), { uid: e.id ?? i, key: e.keys ?? [], keysecondary: e.secondary_keys ?? [], comment: e.comment ?? e.name ?? '', content: e.content ?? '', constant: Boolean(e.constant), selective: Boolean(e.selective), order: e.insertion_order ?? 100, position: x.position ?? (e.position === 'after_char' ? 1 : 0), disable: e.enabled === false, excludeRecursion: Boolean(x.exclude_recursion), preventRecursion: Boolean(x.prevent_recursion), delayUntilRecursion: Boolean(x.delay_until_recursion), probability: x.probability ?? 100, useProbability: Boolean(x.useProbability), depth: x.depth ?? 4, selectiveLogic: x.selectiveLogic ?? 0, outletName: x.outlet_name ?? '', group: x.group ?? '', groupOverride: Boolean(x.group_override), groupWeight: x.group_weight ?? 100, scanDepth: x.scan_depth ?? null, caseSensitive: x.case_sensitive ?? null, matchWholeWords: x.match_whole_words ?? null, useGroupScoring: Boolean(x.use_group_scoring), automationId: x.automation_id ?? '', role: x.role ?? 0, vectorized: Boolean(x.vectorized), displayIndex: x.display_index ?? i, sticky: x.sticky ?? null, cooldown: x.cooldown ?? null, delay: x.delay ?? null, matchPersonaDescription: Boolean(x.match_persona_description), matchCharacterDescription: Boolean(x.match_character_description), matchCharacterPersonality: Boolean(x.match_character_personality), matchCharacterDepthPrompt: Boolean(x.match_character_depth_prompt), matchScenario: Boolean(x.match_scenario), matchCreatorNotes: Boolean(x.match_creator_notes), triggers: x.triggers ?? [], ignoreBudget: Boolean(x.ignore_budget) }]; }));
    atomicJson(path.join(userDir, 'worlds', `${worldName}.json`), { entries });
  };
  const transport = async job => {
    if (job.op === 'create') {
      const target = path.join(userDir, 'characters', job.avatar);
      fs.writeFileSync(target, Buffer.from(job.pngBase64, 'base64'));
      if (job.worldName) writeWorldEntries(job.worldName, job.book?.entries ?? []);
      return { id: job.id, avatar: job.avatar, created: true };
    }
    const targetPng = job.avatar ? path.join(userDir, 'characters', job.avatar) : pngPath;
    if (job.expected?.card !== digest(fs.readFileSync(targetPng))) return { id: job.id, fatal: 'stale card' };
    fs.writeFileSync(targetPng, embedChara(fs.readFileSync(targetPng), job.card));
    const extWorld = job.card?.data?.extensions?.world;
    if (extWorld && job.card?.data?.character_book?.entries) writeWorldEntries(extWorld, job.card.data.character_book.entries);
    return { id: job.id, card: 'written' };
  };
  const adapter = new FileSyncAdapter({ skillsRoot: config.skillsRoot, userDir, transport, queryResult: async () => ({ pending: true }) });
  const service = new SyncService({ cardsRoot, runtimeRoot: path.join(root, 'runtime'), adapter });
  t.after(() => service.stop());
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
  const diff = (await f.service.control({ action: 'check', projectId: project.id })).results[0].diff;
  assert.equal(diff.clean, true); assert.ok(diff.slots.some(s => s.tavern === 'external body' && s.node === 'external body'));
});
test('attach accepts a fresh Tavern card whose character_book is null', async t => {
  const f = await fileFixture(t);
  const card = readCardPng(f.pngPath); card.data.character_book = null; card.data.extensions.world = '';
  fs.writeFileSync(f.pngPath, embedChara(fs.readFileSync(f.pngPath), card));
  const original = fs.readFileSync(f.pngPath);
  const project = await f.service.control({ action: 'attach', cardFile: 'A.png' }); assert.equal(project.attached, true);
  assert.deepEqual(fs.readFileSync(f.pngPath), original);
  assert.equal((await f.service.control({ action: 'check', projectId: project.id })).results[0].diff.clean, true);
  assert.deepEqual(fs.readdirSync(f.cardsRoot).filter(n => n.startsWith('.attach-')), []);
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
test('clean sync does not churn baseline or invalidate revision', async t => {
  const f = await fileFixture(t); const p = await f.service.control({ action: 'attach', cardFile: 'A.png' });
  const before = tree(path.join(f.cardsRoot, 'A'));
  const a = (await f.service.control({ action: 'check', projectId: p.id })).results[0].diff;
  await f.service.control({ action: 'sync', projectId: p.id });
  const b = (await f.service.control({ action: 'check', projectId: p.id })).results[0].diff;
  assert.equal(a.revision, b.revision); assert.deepEqual(tree(path.join(f.cardsRoot, 'A')), before);
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
test('new world file: read-only preview, assigned ID, push and baseline, no duplicate after rename', async t => {
  const f = await newEntryFixture(t), originalTree = tree(f.project.dir);
  const a = await f.adapter.snapshot(f.project), b = await f.adapter.snapshot(f.project);
  assert.equal(a.idAssignments.length, 1); assert.deepEqual(a.idAssignments, b.idAssignments);
  assert.deepEqual(tree(f.project.dir), originalTree);
  assert.equal(compareSnapshot(a).slots.filter(s => s.newEntry).length, 1);
  const result = await f.engine.run(f.project);
  assert.equal(result.status, 'clean'); assert.equal(result.assignedIds.length, 1);
  assert.equal('backupId' in result, false);
  const { id, uid } = result.assignedIds[0], written = fs.readFileSync(f.file, 'utf8');
  assert.equal(written.replace(`id: ${id}\n`, ''), f.raw);
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
test('one-sided entry deletion syncs cleanly; modified entry deleted on one side still blocks', async t => {
  const f = await newEntryFixture(t); const result = await f.engine.run(f.project);
  const uid = result.assignedIds[0].uid;
  // 酒馆把刚同步好的那条删了（本地未改）：自动同步删除本地文件
  const card = readCardPng(f.pngPath); card.data.character_book.entries = [];
  fs.writeFileSync(f.pngPath, embedChara(basePng, card));
  assert.equal((await f.engine.run(f.project)).status, 'clean');
  assert.equal(fs.existsSync(f.file), false);
  const s = await f.adapter.snapshot(f.project); assert.ok(s.baseline.slots[`entry:${uid}`]);
  // 已在历史基线里删过的同一 UID 改了正文再写回来：与基线不同，算冲突阻断
  fs.writeFileSync(f.file, `---\nid: ${result.assignedIds[0].id}\ntype: lore\ntarget: character_book\ntitle: New entry\nkeys: [new]\n---\n\n<!-- body -->\nChanged after remote delete.\n`);
  await assert.rejects(f.engine.run(f.project), e => e.code === "UNSUPPORTED_DIFFERENCE");
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
  const kept = planWorldEntryIds(scan, current.rawFiles, { [`entry:${uid}`]: { value: 'occupied' } }, { slots: { [`entry:${uid}`]: slotHash('old') } }, libs);
  assert.equal(kept.length, 1); assert.equal(String(kept[0].uid), String(uid)); assert.match(kept[0].text, /\nid: world-/);
  fs.writeFileSync(path.join(f.project.dir, 'world_book', 'copy.md'), fs.readFileSync(f.file, 'utf8').replace('New entry body.', 'Copy body.'));
  const scan2 = await libs.nodes.scanCard(f.project.dir), current2 = f.adapter.localSnapshot(f.project);
  assert.throws(() => planWorldEntryIds(scan2, current2.rawFiles, {}, null, libs), e => e.code === 'ENTRY_UID_COLLISION');
});
test('concurrent edit before writeBodies invalidates new-entry plan without replacing author text or pushing', async t => {
  const f = await newEntryFixture(t), writeBodies = f.adapter.writeBodies.bind(f.adapter), png = fs.readFileSync(f.pngPath);
  f.adapter.writeBodies = async (...args) => { fs.writeFileSync(f.file, f.raw + 'Concurrent edit.\n'); return writeBodies(...args); };
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
test('queue: different cards run in parallel, same card in order, global waits for all', async () => {
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
test('service.json is filled with defaults and legacy backup/polling keys are ignored', () => {
  assert.deepEqual(normalizeState(null), { ...DEFAULT_STATE });
  const s = normalizeState({ paused: 'no', pollIntervalMs: 5, autoBackupBeforeOverwrite: false, backupKeep: 10, activeCardFile: '  A.png ', activeWorldName: ' Book ', assembleRoot: 'D:\\old' });
  assert.deepEqual(s, { paused: true, activeCardFile: 'A.png', activeWorldName: 'Book' });
});
test('bidirectional real-time sync covers worldbook entry settings, Tavern-created entries, and alternate greetings', async t => {
  const f = await fileFixture(t, true);
  const p = await f.service.control({ action: 'attach', cardFile: 'A.png' });
  const project = f.service.getProject(p.id);
  const engine = new SyncEngine(f.adapter);
  const worldPath = path.join(f.userDir, 'worlds', 'Book.json');

  const w1 = JSON.parse(fs.readFileSync(worldPath, 'utf8'));
  w1.entries[42].key = ['key', 'tavern-kw'];
  w1.entries[42].constant = true;
  w1.entries[42].order = 150;
  fs.writeFileSync(worldPath, JSON.stringify(w1, null, 2));
  assert.equal((await engine.run(project)).status, 'clean');
  const entryMdPath = path.join(project.dir, 'world_book', 'entry.md');
  const md1 = fs.readFileSync(entryMdPath, 'utf8');
  assert.match(md1, /tavern-kw/);
  assert.match(md1, /constant:\s*true/);
  assert.match(md1, /order:\s*150/);

  const w2 = JSON.parse(fs.readFileSync(worldPath, 'utf8'));
  w2.entries[99] = { uid: 99, key: ['remote-new'], keysecondary: [], content: 'Created in Tavern.', comment: 'TavernAdded', constant: false, disable: false, order: 160, position: 0, depth: 4 };
  fs.writeFileSync(worldPath, JSON.stringify(w2, null, 2));
  assert.equal((await engine.run(project)).status, 'clean');
  const newMdPath = path.join(project.dir, 'world_book', 'TavernAdded.md');
  assert.equal(fs.existsSync(newMdPath), true);
  assert.match(fs.readFileSync(newMdPath, 'utf8'), /Created in Tavern\./);

  const c3 = readCardPng(f.pngPath);
  c3.data.alternate_greetings = ['Hello from Tavern alt greeting!'];
  fs.writeFileSync(f.pngPath, embedChara(basePng, c3));
  assert.equal((await engine.run(project)).status, 'clean');
  const greet1Path = path.join(project.dir, 'message', '1.md');
  assert.equal(fs.existsSync(greet1Path), true);
  assert.match(fs.readFileSync(greet1Path, 'utf8'), /Hello from Tavern alt greeting!/);
});
test('deleted card: status says cardMissing, automatic sync marks onlyNew once and writes nothing, manual sync explains', async t => {
  const adapter = new MemoryAdapter();
  adapter.listCards = () => [{ cardFile: 'B.png', name: 'B' }];
  const { service } = serviceFixture(t, adapter);
  const p = (await service.status()).projects[0];
  assert.equal(p.status, 'cardMissing');
  assert.equal(p.missingCardFile, 'A.png');
  service.state.activeCardFile = 'A.png'; service.state.paused = false;
  adapter.node = 'local';
  for (let i = 0; i < 3; i++) {
    const r = await service.batch('sync', 'A', true);
    assert.equal(r.results[0].status, 'needsReconnect');
    assert.equal(r.results[0].onlyNew, true);
  }
  assert.equal(service.logs.filter(l => l.action === 'needsReconnect').length, 1);
  assert.equal(adapter.writes + adapter.pushes + adapter.saved, 0);
  const manual = await service.control({ action: 'sync', projectId: 'A' });
  assert.equal(manual.results[0].error.code, 'CARD_MISSING');
  await assert.rejects(service.control({ action: 'reconnectOverwrite', projectId: 'A' }), e => e.code === 'CARD_MISSING');
});
test('connect and reconnectNew / reconnectOverwrite: unattached creates new card+world avoiding name clashes; dirty reconnect offers overwrite or new card', async t => {
  const f = await fileFixture(t, true);
  // 1. 还没进过酒馆的本地工程（名字 A、世界书名 Book 都和酒馆里现有的重名）→ 点「连接」新建 A 2.png 和 Book 2，旧卡和旧世界书不动
  const bDir = path.join(f.cardsRoot, 'A');
  fs.mkdirSync(path.join(bDir, 'world_book'), { recursive: true });
  fs.writeFileSync(path.join(bDir, 'card.md'), '---\nid: card-root\ntype: card\nname: A\ntavern:\n  data:\n    extensions:\n      world: Book\n---\n\n<!-- body -->\n');
  fs.writeFileSync(path.join(bDir, 'description.md'), 'new local card\n');
  fs.writeFileSync(path.join(bDir, "world_book", "entry.md"), "---\nid: wb-1\ntype: lore\ntarget: character_book\ntitle: NewEntry\nkeys: [k]\norder: 100\nposition: before_char\ntavern:\n  id: 1\n---\n\n<!-- body -->\nnew world body\n");
  const oldPng = fs.readFileSync(f.pngPath);
  const oldWorld = fs.readFileSync(path.join(f.userDir, 'worlds', 'Book.json'), 'utf8');

  const connected = await f.service.control({ action: 'connect', projectId: 'A' });
  assert.equal(connected.cardFile, 'A 2.png');
  assert.equal(connected.worldName, 'Book 2');
  assert.equal(connected.status, 'clean');
  // 旧卡 A.png、旧世界书 Book.json 完全没动；本地 card.md 里的 world: Book 也没被篡改（worldOverride 记在 bridge.json）
  assert.deepEqual(fs.readFileSync(f.pngPath), oldPng);
  assert.equal(fs.readFileSync(path.join(f.userDir, 'worlds', 'Book.json'), 'utf8'), oldWorld);
  assert.match(fs.readFileSync(path.join(bDir, 'card.md'), 'utf8'), /world: Book\n/);
  assert.equal(readCardPng(path.join(f.userDir, 'characters', 'A 2.png')).data.description, 'new local card');
  assert.ok(fs.existsSync(path.join(f.userDir, 'worlds', 'Book 2.json')));

  // 2. 断开期间酒馆改了 A 2.png：点「连接」停在 needsReconnect；选「以本地为准覆盖」把本地写进 A 2.png；选「新建卡」再建 A 3.png 和 Book 3
  await f.service.control({ action: 'pause' });
  const c2Path = path.join(f.userDir, 'characters', 'A 2.png');
  const c2 = readCardPng(c2Path); c2.data.description = 'tavern offline edit';
  fs.writeFileSync(c2Path, embedChara(basePng, c2));
  await f.service.control({ action: 'resume' });
  const dirtyConnect = await f.service.control({ action: 'connect', projectId: 'A' });
  assert.equal(dirtyConnect.status, 'needsReconnect');
  assert.equal(readCardPng(c2Path).data.description, 'tavern offline edit');

  const overwritten = await f.service.control({ action: 'reconnectOverwrite', projectId: 'A' });
  assert.equal(overwritten.status, 'clean');
  assert.equal(readCardPng(c2Path).data.description, 'new local card');

  const asNew = await f.service.control({ action: 'reconnectNew', projectId: 'A' });
  assert.equal(asNew.cardFile, 'A 3.png');
  assert.equal(asNew.worldName, 'Book 3');
  assert.ok(fs.existsSync(path.join(f.userDir, 'characters', 'A 3.png')));
  assert.ok(fs.existsSync(path.join(f.userDir, 'worlds', 'Book 3.json')));
});
test('overwrite attach keeps non-card files (records, candidates, notes, research) without creating backups', async t => {
  const f = await fileFixture(t, true);
  const p = await f.service.control({ action: 'attach', cardFile: 'A.png' });
  const dir = path.join(f.cardsRoot, p.id);
  for (const [rel, text] of [['记录/决策.md', 'd'], ['候选/entry/旧节点.md', 'c'], ['note/n.md', 'n'], ['调研.md', 'r']]) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  await assert.rejects(f.service.control({ action: 'attach', cardFile: 'A.png' }), e => e.code === 'ATTACH_CONFLICT' && e.details.keepGroups.some(g => g.path === '记录/') && e.details.keepGroups.some(g => g.path === '调研.md') && e.details.replaceCount > 0);
  await f.service.control({ action: 'attach', cardFile: 'A.png', overwrite: true });
  assert.equal(fs.readFileSync(path.join(dir, '记录', '决策.md'), 'utf8'), 'd');
  assert.equal(fs.readFileSync(path.join(dir, '候选', 'entry', '旧节点.md'), 'utf8'), 'c');
  assert.equal(fs.readFileSync(path.join(dir, 'note', 'n.md'), 'utf8'), 'n');
  assert.equal(fs.readFileSync(path.join(dir, '调研.md'), 'utf8'), 'r');
  assert.equal(fs.existsSync(path.join(f.cardsRoot, 'backups')), false);
  assert.equal((await f.service.control({ action: 'check', projectId: p.id })).results[0].diff.clean, true);
});
test('realtime watcher and changeStamp trigger automatic sync when local or tavern files change', async t => {
  const f = await fileFixture(t, true);
  const p = await f.service.control({ action: 'attach', cardFile: 'A.png' });
  await f.service.control({ action: 'followCard', cardFile: 'A.png' });
  await f.service.control({ action: 'resume' });
  f.service.debounceMs = 15;
  const project = f.service.getProject(p.id);
  const stamp0 = f.adapter.changeStamp(project);
  fs.writeFileSync(path.join(project.dir, 'description.md'), 'realtime edit\n');
  const stamp1 = f.adapter.changeStamp(project);
  assert.notEqual(stamp1, stamp0);
  f.service.schedule(p.id);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(readCardPng(f.pngPath).data.description, 'realtime edit');
});
test('handles duplicate-named cards, missing bound worldbook fallback, trailing-space world names, and character_book.description', async t => {
  const f = await fileFixture(t, true);
  // 1. 同名卡 A1.png（卡内 data.name 仍为 'A'，且 character_book 含 description，extensions.world 指向不存在的世界书，回退使用内嵌世界书）
  const dupCard = structuredClone(readCardPng(f.pngPath));
  dupCard.data.name = 'A';
  dupCard.data.extensions = { world: 'MissingWorldBook ' };
  dupCard.data.character_book = {
    name: 'MissingWorldBook',
    description: '世界书级说明文本',
    entries: [{ id: 7, keys: ['k'], secondary_keys: [], comment: '内嵌条目', content: '内嵌正文', constant: false, selective: true, insertion_order: 100, enabled: true, position: 'before_char', extensions: { position: 0, depth: 4, role: 0 } }],
  };
  const dupPngPath = path.join(f.userDir, 'characters', 'A1.png');
  fs.writeFileSync(dupPngPath, embedChara(basePng, dupCard));

  // 同时拆解 A.png 和同名卡 A1.png，互不冲突
  const p0 = await f.service.control({ action: 'attach', cardFile: 'A.png' });
  const p1 = await f.service.control({ action: 'attach', cardFile: 'A1.png' });
  assert.equal(p0.id, 'A');
  assert.equal(p1.id, 'A1');
  assert.equal((await f.service.control({ action: 'check', projectId: 'A1' })).results[0].diff.clean, true);

  // 2. 世界书名末尾带空格（extensions.world = 'Book ' 匹配 worlds/Book.json）
  const spaceCard = structuredClone(readCardPng(f.pngPath));
  spaceCard.data.name = 'A';
  spaceCard.data.extensions = { world: 'Book ' };
  const spacePngPath = path.join(f.userDir, 'characters', 'A2.png');
  fs.writeFileSync(spacePngPath, embedChara(basePng, spaceCard));
  const p2 = await f.service.control({ action: 'attach', cardFile: 'A2.png' });
  assert.equal(p2.id, 'A2');
  assert.equal((await f.service.control({ action: 'check', projectId: 'A2' })).results[0].diff.clean, true);
});

