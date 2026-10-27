import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileSyncAdapter } from '../src/file-sync-adapter.mjs';
import { SyncService } from '../src/sync-service.mjs';
import { SyncEngine } from '../src/sync-engine.mjs';
import { createBridgeServer } from '../src/bridge.mjs';
import { atomicJson, digest, BridgeError } from '../src/safety.mjs';
import { embedChara } from '../src/png.mjs';
import { readCardPng } from '../src/slots.mjs';
const exec = promisify(execFile);
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64');
const blank = name => ({ spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '', extensions: {} } });
function files(dir) { const result = {}; const walk = rel => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { const next = path.join(rel, e.name); if (e.isDirectory()) walk(next); else result[next] = fs.readFileSync(path.join(dir, next)).toString('base64'); } }; walk(''); return result; }
async function fixture(t, attach = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-lifecycle-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDir = path.join(root, 'user'), cardsRoot = path.join(root, 'cards');
  fs.mkdirSync(path.join(userDir, 'characters'), { recursive: true }); fs.mkdirSync(path.join(userDir, 'worlds')); fs.mkdirSync(cardsRoot);
  const initial = blank('A'); initial.data.description = 'base'; const png = path.join(userDir, 'characters', 'A.png'); fs.writeFileSync(png, embedChara(image, initial));
  const calls = [];
  const transport = async job => {
    calls.push(job);
    if (job.op === 'create') {
      fs.writeFileSync(path.join(userDir, 'characters', job.avatar), Buffer.from(job.pngBase64, 'base64'));
      if (job.worldName) {
        const entries = Object.fromEntries((job.book?.entries ?? []).map((e, i) => [String(e.id ?? i), { ...(e.extensions ?? {}), uid: e.id ?? i, key: e.keys ?? [], keysecondary: e.secondary_keys ?? [], comment: e.comment ?? e.name ?? '', content: e.content ?? '', constant: Boolean(e.constant), selective: Boolean(e.selective), order: e.insertion_order ?? 100, position: e.extensions?.position ?? (e.position === 'after_char' ? 1 : 0), disable: e.enabled === false }]));
        atomicJson(path.join(userDir, 'worlds', `${job.worldName}.json`), { entries });
      }
      return { id: job.id, avatar: job.avatar, created: true };
    }
    const file = job.avatar ? path.join(userDir, 'characters', job.avatar) : null;
    if (file && digest(fs.readFileSync(file)) !== job.expected.card) return { id: job.id, fatal: 'stale PNG' };
    if (job.op === 'rename') { const avatar = `${job.newName}.png`, card = readCardPng(file); card.data.name = job.newName; fs.writeFileSync(path.join(userDir, 'characters', avatar), embedChara(fs.readFileSync(file), card)); fs.unlinkSync(file); return { id: job.id, avatar }; }
    if (file) fs.writeFileSync(file, embedChara(fs.readFileSync(file), job.card));
    if (job.worldName && job.world) atomicJson(path.join(userDir, 'worlds', `${job.worldName}.json`), job.world);
    const extWorld = job.card?.data?.extensions?.world;
    if (extWorld && job.card?.data?.character_book?.entries) {
      const entries = Object.fromEntries(job.card.data.character_book.entries.map((e, i) => [String(e.id ?? i), { ...(e.extensions ?? {}), uid: e.id ?? i, key: e.keys ?? [], keysecondary: e.secondary_keys ?? [], comment: e.comment ?? e.name ?? '', content: e.content ?? '', constant: Boolean(e.constant), selective: Boolean(e.selective), order: e.insertion_order ?? 100, position: e.extensions?.position ?? (e.position === 'after_char' ? 1 : 0), disable: e.enabled === false }]));
      atomicJson(path.join(userDir, 'worlds', `${extWorld}.json`), { entries });
    }
    return { id: job.id, card: 'written', ...((job.world || extWorld) ? { world: 'written' } : {}) };
  };
  const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const adapter = new FileSyncAdapter({ skillsRoot: config.skillsRoot, userDir, transport, queryResult: async () => ({ pending: true }) });
  const service = new SyncService({ cardsRoot, runtimeRoot: path.join(root, 'runtime'), adapter });
  t.after(() => service.stop());
  if (attach) await service.control({ action: 'attach', cardFile: 'A.png' });
  return { root, userDir, cardsRoot, png, adapter, service, transport, calls, project: attach ? service.getProject('A') : null };
}
async function body(f, value) { await f.adapter.writeBodies(f.project, await f.adapter.snapshot(f.project), [{ key: 'field:description', value }]); }

test('timeout persists across restart; no clean result and late ack cannot undo local reversion', async t => {
  const f = await fixture(t), stateFile = path.join(f.project.dir, '.card-forge', 'tavern-sync.json'), base = fs.readFileSync(stateFile, 'utf8');
  await body(f, 'older edit'); let pending;
  f.adapter.transport = async job => { pending = job; throw new BridgeError('JOB_TIMEOUT', 'fake timeout', 504); };
  const engine = new SyncEngine(f.adapter);
  await assert.rejects(engine.run(f.project), e => e.code === 'JOB_TIMEOUT');
  await body(f, 'base');
  await assert.rejects(engine.run(f.project), e => e.code === 'OPERATION_PENDING');
  const restarted = new FileSyncAdapter({ skillsRoot: f.adapter.skillsRoot, userDir: f.userDir, transport: f.transport, queryResult: async () => ({ pending: true }) });
  await assert.rejects(new SyncEngine(restarted).run({ dir: f.project.dir, cardFile: 'A.png' }), e => e.code === 'OPERATION_PENDING');
  await f.transport(pending); f.adapter.queryResult = async () => ({ id: pending.id, card: 'written' });
  await assert.rejects(engine.run(f.project), e => e.code === 'OPERATION_REVIEW_REQUIRED');
  assert.equal((await f.adapter.snapshot(f.project)).nodes.slots['field:description'].value, 'base'); assert.equal(fs.readFileSync(stateFile, 'utf8'), base);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.project.dir, '.card-forge', 'operation.json'))).state, 'reviewRequired');
});
test('ordinary acknowledgement also refuses local edits made while waiting', async t => {
  const f = await fixture(t); await body(f, 'sent');
  f.adapter.transport = async job => { await f.transport(job); await body(f, 'edited while waiting'); return { id: job.id, card: 'written' }; };
  await assert.rejects(new SyncEngine(f.adapter).run(f.project), e => e.code === 'OPERATION_REVIEW_REQUIRED');
  assert.equal((await f.adapter.snapshot(f.project)).nodes.slots['field:description'].value, 'edited while waiting');
});
test('reconnectOverwrite cannot push external edits sampled after writeBodies', async t => {
  const f = await fixture(t); await body(f, 'mine'); const remote = readCardPng(f.png); remote.data.description = 'theirs'; fs.writeFileSync(f.png, embedChara(image, remote));
  const original = f.adapter.writeBodies.bind(f.adapter);
  f.adapter.writeBodies = async (p, s, updates) => { const expected = await original(p, s, updates); const current = await f.adapter.snapshot(p); await original(p, current, [{ key: 'field:description', value: 'external edit after choice' }]); return expected; };
  await assert.rejects(f.service.control({ action: 'reconnectOverwrite', projectId: f.project.id }), e => e.code === 'STALE_LOCAL');
  assert.equal(f.calls.length, 0); assert.equal(readCardPng(f.png).data.description, 'theirs');
});
test('automatic sync never creates cards; it only follows and renames the card open in the tavern', async t => {
  const f = await fixture(t, false), dir = path.join(f.cardsRoot, 'B'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'plain folder');
  await f.service.control({ action: 'resume' });
  await f.service.control({ action: 'followCard', cardFile: 'B.png' });
  await f.service.batch('sync', undefined, true); await f.service.batch('sync', undefined, true);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(path.join(dir, 'card.md')), false); assert.equal(fs.existsSync(path.join(dir, '.card-forge')), false);
  assert.equal(fs.existsSync(path.join(f.userDir, 'characters', 'B.png')), false);
  assert.equal((await f.service.status()).projects.some(p => p.id === 'B'), false);
  fs.rmSync(dir, { recursive: true });
  fs.writeFileSync(path.join(f.userDir, 'characters', 'B.png'), embedChara(image, blank('B')));
  await f.service.control({ action: 'attach', cardFile: 'B.png' });
  const key = JSON.parse(fs.readFileSync(path.join(dir, '.card-forge', 'bridge.json'))).projectKey;
  await f.service.batch('sync', undefined, true);
  const renamedDir = path.join(f.cardsRoot, 'C'); fs.renameSync(dir, renamedDir);
  await f.service.batch('sync', undefined, true); const result = await f.service.batch('sync', undefined, true);
  assert.equal(result.results[0].status, 'clean', JSON.stringify(result));
  assert.ok(fs.existsSync(path.join(f.userDir, 'characters', 'C.png'))); assert.equal(f.calls.filter(j => j.op === 'create').length, 0); assert.equal(f.calls.filter(j => j.op === 'rename').length, 1);
  assert.equal((await f.service.status()).activeCardFile, 'C.png');
  assert.equal(JSON.parse(fs.readFileSync(path.join(renamedDir, '.card-forge', 'bridge.json'))).projectKey, key);
  fs.rmSync(renamedDir, { recursive: true }); await f.service.batch('sync', undefined, true); assert.ok(fs.existsSync(path.join(f.userDir, 'characters', 'C.png')));
});
test('same-name local newcomer and detached/paused folders never create or overwrite cards automatically', async t => {
  const f = await fixture(t, false), dir = path.join(f.cardsRoot, 'A'); fs.mkdirSync(dir, { recursive: true });
  await f.service.control({ action: 'resume' }); await f.service.control({ action: 'followCard', cardFile: 'A.png' });
  const result = await f.service.batch('sync', undefined, true);
  assert.deepEqual(result.results, []); assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(path.join(dir, 'card.md')), false);
  atomicJson(path.join(dir, '.card-forge', 'bridge.json'), { cardFile: 'A.png', detached: true }); await f.service.batch('sync', undefined, true); assert.equal(f.calls.length, 0);
});
test('independent world CLI joins active service queue instead of second write path', async t => {
  const f = await fixture(t, false), world = { entries: { 1: { uid: 1, content: 'world body', key: ['key'], keysecondary: [], comment: 'one', order: 100, position: 0 } } };
  const file = path.join(f.userDir, 'worlds', 'Book.json'); atomicJson(file, world);
  const dir = path.join(f.cardsRoot, 'Book'), { unpack } = await f.adapter.libraries(); const unpacked = await unpack.unpackCmd(file, { out: dir }); assert.equal(unpacked.ok, true);
  const token = 'q'.repeat(64), { server } = createBridgeServer({ token, service: f.service }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
  const { stdout } = await exec(process.execPath, ['bin/tt-card.mjs', 'pull', dir, '--book', 'Book'], { cwd: new URL('..', import.meta.url), env: { ...process.env, TAVERN_USER_DIR: f.userDir, TT_BRIDGE_PORT: String(server.address().port), TT_BRIDGE_TOKEN: token }, timeout: 10_000 });
  assert.match(stdout, /clean/); assert.equal(f.service.getProject('Book').targetKind, 'world'); assert.equal(f.service.getProject('Book').cardFile, 'world:Book');
});
test('lifecycle pending status cannot be reported clean by read-only check', async t => {
  const f = await fixture(t), marker = path.join(f.project.dir, '.card-forge', 'bridge.json');
  const binding = JSON.parse(fs.readFileSync(marker, 'utf8')); atomicJson(marker, { ...binding, operation: { id: 'rename-pending', kind: 'rename' } });
  await f.service.control({ action: 'check', projectId: f.project.id });
  const p = (await f.service.status()).projects[0]; assert.equal(p.status, 'operationPending'); assert.equal(p.pendingOperation.id, 'rename-pending');
});
test('pending and review-required targets cannot detach or be taken over from another directory', async t => {
  for (const state of ['pending', 'reviewRequired']) {
    const f = await fixture(t), marker = path.join(f.project.dir, '.card-forge', 'bridge.json');
    atomicJson(path.join(f.project.dir, '.card-forge', 'operation.json'), { jobId: 'late-job', cardFile: 'A.png', state, localHash: 'irrelevant' });
    await assert.rejects(f.service.control({ action: 'detach', projectId: f.project.id }), e => ['OPERATION_PENDING', 'OPERATION_REVIEW_REQUIRED'].includes(e.code));
    atomicJson(marker, { ...JSON.parse(fs.readFileSync(marker, 'utf8')), detached: true });
    await assert.rejects(f.service.control({ action: 'attach', cardFile: 'A.png' }), e => e.code === 'ATTACH_CONFLICT');
    const otherDir = path.join(f.cardsRoot, 'OtherA'); fs.mkdirSync(otherDir, { recursive: true });
    const standalone = new FileSyncAdapter({ skillsRoot: f.adapter.skillsRoot, userDir: f.userDir, cardsRoot: f.cardsRoot, transport: f.transport });
    await assert.rejects(new SyncEngine(standalone).run({ dir: otherDir, cardFile: 'A.png' }), e => e.code === 'TARGET_OCCUPIED');
    assert.equal(f.calls.length, 0);
  }
});
test('unconfirmed rename reserves both source and destination names', async t => {
  const f = await fixture(t), marker = path.join(f.project.dir, '.card-forge', 'bridge.json'), binding = JSON.parse(fs.readFileSync(marker, 'utf8'));
  atomicJson(marker, { ...binding, operation: { id: 'rename-late', kind: 'rename', targetCardFile: 'B.png' } });
  fs.writeFileSync(path.join(f.userDir, 'characters', 'B.png'), embedChara(image, blank('B')));
  await assert.rejects(f.service.control({ action: 'attach', cardFile: 'B.png' }), e => e.code === 'ATTACH_CONFLICT');
  const dir = path.join(f.cardsRoot, 'OtherB'); fs.mkdirSync(dir, { recursive: true });
  await assert.rejects(new SyncEngine(f.adapter).run({ dir, cardFile: 'B.png' }), e => e.code === 'TARGET_OCCUPIED');
  assert.equal((await f.service.status()).unattachedCards, undefined); assert.equal(f.calls.length, 0);
});
test('independent world binding and standalone book sync share unresolved target occupancy', async t => {
  const f = await fixture(t, false), oldDir = path.join(f.cardsRoot, 'OldBook'), newDir = path.join(f.cardsRoot, 'NewBook'); fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, 'card.md'), '---\nid: card-root\ntype: card\nname: NewBook\nbook_only: true\n---\n');
  atomicJson(path.join(oldDir, '.card-forge', 'bridge.json'), { cardFile: 'world:Book', detached: true });
  atomicJson(path.join(oldDir, '.card-forge', 'operation.json'), { jobId: 'late-book', cardFile: 'world:Book', state: 'pending' });
  await assert.rejects(f.service.control({ action: 'bindWorld', projectId: 'NewBook', worldName: 'Book' }), e => e.code === 'TARGET_OCCUPIED');
  await assert.rejects(new SyncEngine(f.adapter).run({ dir: newDir, cardFile: 'world:Book' }), e => e.code === 'TARGET_OCCUPIED');
  assert.equal(f.calls.length, 0);
});
test('panel attachWorld unpacks standalone world, export writes dist without dirtying localRevision, followCard disconnects previous card, and shutdown stops service', async t => {
  const f = await fixture(t), worldFile = path.join(f.userDir, 'worlds', 'Solo.json');
  atomicJson(worldFile, { entries: { 1: { uid: 1, content: 'solo body', key: ['k'], keysecondary: [], comment: 'solo', order: 100, position: 0 } } });
  assert.equal((await f.service.status()).activeWorld, null);
  const beforeStatus = await f.service.control({ action: 'followCard', cardFile: 'A.png', worldName: 'Solo' });
  assert.deepEqual(beforeStatus.activeWorld, { worldName: 'Solo', exists: true, attached: false, projectId: null });
  const attached = await f.service.control({ action: 'attachWorld', worldName: 'Solo' });
  assert.equal(attached.id, 'Solo'); assert.equal(attached.cardFile, 'world:Solo');
  assert.deepEqual((await f.service.status()).activeWorld, { worldName: 'Solo', exists: true, attached: true, projectId: 'Solo' });
  const revBefore = f.adapter.localRevision(f.project);
  const exported = await f.service.control({ action: 'export', projectId: f.project.id });
  assert.ok(fs.existsSync(path.join(exported.outDir, 'A.json')));
  assert.ok(fs.existsSync(path.join(exported.outDir, 'A.png')));
  assert.equal(f.adapter.localRevision(f.project), revBefore);

  const skillsRes = await f.service.control({ action: 'skillsStatus' });
  assert.ok(Array.isArray(skillsRes.skills));
  assert.ok(typeof skillsRes.summary === 'string' && skillsRes.summary.includes('Agent 全局提示词原件'));

  // followCard 只记住当前打开的卡，不改其他卡文件夹里的任何文件；被切走的卡从 live 断开
  fs.writeFileSync(path.join(f.userDir, 'characters', 'B.png'), embedChara(image, blank('B')));
  await f.service.control({ action: 'attach', cardFile: 'B.png' });
  assert.equal(f.service.live.has('A'), true);
  const aBefore = files(f.project.dir);
  const followB = await f.service.control({ action: 'followCard', cardFile: 'B.png' });
  assert.equal(followB.activeCardFile, 'B.png');
  assert.equal(f.service.live.has('A'), false);
  assert.deepEqual(files(f.project.dir), aBefore);

  // setCardsRoot 拒绝指向单张卡目录（含旧版 world/character 目录或 card.md）
  const legacyCardDir = path.join(f.cardsRoot, 'LegacySample');
  fs.mkdirSync(path.join(legacyCardDir, 'world', '示例世界'), { recursive: true });
  fs.mkdirSync(path.join(legacyCardDir, 'character', '示例角色'), { recursive: true });
  fs.writeFileSync(path.join(legacyCardDir, 'world', '示例世界', 'index.md'), '---\nid: w1\ntype: world\n---\n<!-- body -->\nworld\n');
  fs.writeFileSync(path.join(legacyCardDir, 'character', '示例角色', 'index.md'), '---\nid: c1\ntype: character\n---\n<!-- body -->\nchar\n');
  await assert.rejects(f.service.control({ action: 'setCardsRoot', cardsRoot: legacyCardDir }), e => e.code === 'INVALID_CARDS_ROOT');
  assert.equal(fs.existsSync(path.join(legacyCardDir, 'card.md')), false);

  const nextCardsRoot = path.join(path.dirname(f.cardsRoot), 'custom-cards-root');
  let savedRoot = null; f.service.onCardsRootChange = r => { savedRoot = r; };
  const switched = await f.service.control({ action: 'setCardsRoot', cardsRoot: nextCardsRoot });
  assert.equal(switched.cardsRoot, nextCardsRoot);
  assert.equal(savedRoot, nextCardsRoot);
  assert.equal((await f.service.status()).cardsRoot, nextCardsRoot);
  let shut = false; f.service.onShutdown = () => { shut = true; };
  const stopping = await f.service.control({ action: 'shutdown' });
  assert.equal(stopping.stopping, true);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(shut, true);
});
