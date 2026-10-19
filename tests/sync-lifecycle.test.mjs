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
import { atomicJson, digest, hashObject, BridgeError } from '../src/safety.mjs';
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
    if (job.op === 'create') { const avatar = `${job.fileName}.png`; fs.writeFileSync(path.join(userDir, 'characters', avatar), embedChara(image, blank(job.name))); return { id: job.id, avatar }; }
    const file = job.avatar ? path.join(userDir, 'characters', job.avatar) : null;
    if (file && digest(fs.readFileSync(file)) !== job.expected.card) return { id: job.id, fatal: 'stale PNG' };
    if (job.op === 'rename') { const avatar = `${job.newName}.png`, card = readCardPng(file); card.data.name = job.newName; fs.writeFileSync(path.join(userDir, 'characters', avatar), embedChara(fs.readFileSync(file), card)); fs.unlinkSync(file); return { id: job.id, avatar }; }
    if (job.op === 'restore') { const imported = readCardPng(Buffer.from(job.pngBase64, 'base64')); imported.create_date = 'imported-date'; imported.chat = 'imported-chat'; imported.data.extensions.fav = false; fs.writeFileSync(file, embedChara(image, imported)); if (job.worldName && job.world) atomicJson(path.join(userDir, 'worlds', `${job.worldName}.json`), job.world); return { id: job.id, restored: true, mode: 'import' }; }
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
test('resolve cannot push external edits sampled after the explicit choice', async t => {
  const f = await fixture(t); await body(f, 'mine'); const remote = readCardPng(f.png); remote.data.description = 'theirs'; fs.writeFileSync(f.png, embedChara(image, remote));
  const preview = await f.service.control({ action: 'diff', projectId: f.project.id }), original = f.adapter.writeBodies.bind(f.adapter);
  f.adapter.writeBodies = async (p, s, updates) => { const expected = await original(p, s, updates); const current = await f.adapter.snapshot(p); await original(p, current, [{ key: 'field:description', value: 'external edit after choice' }]); return expected; };
  await assert.rejects(f.service.control({ action: 'resolve', projectId: f.project.id, previewId: preview.previewId, choices: [{ key: 'field:description', source: 'manual', text: 'explicitly chosen merge' }] }), e => e.code === 'STALE_LOCAL');
  assert.equal(f.calls.length, 0); assert.equal(readCardPng(f.png).data.description, 'theirs');
});
test('restore refuses destructive local phase if new node appeared during remote wait', async t => {
  const f = await fixture(t), backupId = await f.adapter.backup(f.project, await f.adapter.snapshot(f.project));
  const preview = await f.service.control({ action: 'restorePreview', projectId: f.project.id, backupId });
  const added = path.join(f.project.dir, 'world_book', 'new.md');
  f.adapter.transport = async job => { const result = await f.transport(job); fs.mkdirSync(path.dirname(added), { recursive: true }); fs.writeFileSync(added, '---\nid: new-note\ntype: lore\n---\n<!-- body -->\nnew author text\n'); return result; };
  await assert.rejects(f.service.control({ action: 'restore', projectId: f.project.id, previewId: preview.previewId, confirm: true }), e => e.code === 'OPERATION_REVIEW_REQUIRED');
  assert.match(fs.readFileSync(added, 'utf8'), /new author text/); assert.equal(f.service.getProject(f.project.id).restoreRequired, true);
  await assert.rejects(new SyncEngine(f.adapter).run({ dir: f.project.dir, cardFile: 'A.png' }), e => e.code === 'RESTORE_REQUIRED');
});
test('old-name backup stays readable but cross-name import restore is refused before mutation', async t => {
  const f = await fixture(t), backupId = await f.adapter.backup(f.project, await f.adapter.snapshot(f.project));
  const marker = path.join(f.project.dir, '.card-forge', 'bridge.json');
  atomicJson(marker, { ...JSON.parse(fs.readFileSync(marker, 'utf8')), cardFile: 'B.png' });
  fs.renameSync(f.png, path.join(f.userDir, 'characters', 'B.png')); f.project = f.service.getProject(f.project.id);
  const preview = await f.service.control({ action: 'restorePreview', projectId: f.project.id, backupId }); assert.equal(preview.canRestore, false);
  const listing = (await f.service.control({ action: 'backups', projectId: f.project.id })).backups[0]; assert.equal(listing.supported, true); assert.equal(listing.restorable, false);
  const before = files(f.root);
  await assert.rejects(f.service.control({ action: 'restore', projectId: f.project.id, previewId: preview.previewId, confirm: true }), e => e.code === 'UNSUPPORTED_RESTORE');
  assert.deepEqual(files(f.root), before); assert.equal(f.calls.length, 0);
});
test('enabled mirror creates stable folders, renames same identity, and never deletes remote cards', async t => {
  const f = await fixture(t, false), dir = path.join(f.cardsRoot, 'B'); fs.mkdirSync(dir, { recursive: true });
  await f.service.batch('sync', undefined, true); assert.equal(f.calls.length, 0);
  await f.service.control({ action: 'resume' });
  await f.service.batch('sync', undefined, true); let result = await f.service.batch('sync', undefined, true);
  assert.equal(result.results[0].status, 'clean', JSON.stringify(result)); assert.ok(fs.existsSync(path.join(f.userDir, 'characters', 'B.png')));
  const key = JSON.parse(fs.readFileSync(path.join(dir, '.card-forge', 'bridge.json'))).projectKey;
  const renamedDir = path.join(f.cardsRoot, 'C'); fs.renameSync(dir, renamedDir);
  result = await f.service.batch('sync', undefined, true); assert.equal(result.results[0].status, 'clean', JSON.stringify(result));
  assert.ok(fs.existsSync(path.join(f.userDir, 'characters', 'C.png'))); assert.equal(f.calls.filter(j => j.op === 'create').length, 1); assert.equal(f.calls.filter(j => j.op === 'rename').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(renamedDir, '.card-forge', 'bridge.json'))).projectKey, key);
  assert.ok(f.adapter.backups(f.service.getProject('C')).some(b => b.supported && b.bindingChanged));
  fs.rmSync(renamedDir, { recursive: true }); await f.service.batch('sync', undefined, true); assert.ok(fs.existsSync(path.join(f.userDir, 'characters', 'C.png')));
});
test('same-name local newcomer and detached/paused folders never create or overwrite cards', async t => {
  const f = await fixture(t, false), dir = path.join(f.cardsRoot, 'A'); fs.mkdirSync(dir, { recursive: true });
  await f.service.control({ action: 'resume' }); const result = await f.service.batch('sync', undefined, true);
  assert.equal(result.results[0].error.code, 'ATTACH_CONFLICT'); assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(path.join(dir, 'card.md')), false);
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
test('retired flat sync rejects direct and bin entry without touching fake data', async t => {
  const f = await fixture(t, false), before = files(f.root);
  for (const args of [['src/sync.mjs', 'watch', 'A.png', f.cardsRoot], ['bin/tt-card.mjs', 'sync', 'new', 'B', 'A.png']]) {
    await assert.rejects(exec(process.execPath, args, { cwd: new URL('..', import.meta.url), env: { ...process.env, TAVERN_USER_DIR: f.userDir }, timeout: 10_000 }), e => e.code === 2 && /LEGACY_SYNC_DISABLED/.test(e.stderr));
  }
  assert.deepEqual(files(f.root), before);
});

test('new card initialization refuses author-specified existing world before creating or replacing anything', async t => {
  const f = await fixture(t, false), worldFile = path.join(f.userDir, 'worlds', 'Existing.json');
  atomicJson(worldFile, { entries: { 1: { uid: 1, content: 'must survive' } } });
  const dir = path.join(f.cardsRoot, 'B'); fs.mkdirSync(dir, { recursive: true });
  const root = '---\nid: card-root\ntype: card\nname: B\ntavern:\n  data:\n    extensions:\n      world: Existing\n---\n<!-- body -->\n'; fs.writeFileSync(path.join(dir, 'card.md'), root);
  await f.service.control({ action: 'resume' }); const before = files(f.root);
  await f.service.batch('sync', undefined, true); const result = await f.service.batch('sync', undefined, true);
  assert.equal(result.results[0].error.code, 'WORLD_TARGET_CONFLICT'); assert.equal(f.calls.length, 0); assert.deepEqual(files(f.root), before);
  // Even if another caller has already created a blank card, the common engine denies this authorization.
  fs.writeFileSync(path.join(f.userDir, 'characters', 'B.png'), embedChara(image, blank('B')));
  const project = { dir, cardFile: 'B.png' }, snapshot = await f.adapter.snapshot(project);
  await assert.rejects(new SyncEngine(f.adapter).run(project, { initializeExpected: snapshot.expected }), e => e.code === 'WORLD_TARGET_CONFLICT');
  assert.equal(f.calls.length, 0); assert.match(fs.readFileSync(worldFile, 'utf8'), /must survive/);
});
test('lifecycle pending status cannot be reported clean by read-only check', async t => {
  const f = await fixture(t), marker = path.join(f.project.dir, '.card-forge', 'bridge.json');
  const binding = JSON.parse(fs.readFileSync(marker, 'utf8')); atomicJson(marker, { ...binding, operation: { id: 'rename-pending', kind: 'rename' } });
  await f.service.control({ action: 'check', projectId: f.project.id });
  const p = (await f.service.status()).projects[0]; assert.equal(p.status, 'operationPending'); assert.equal(p.pendingOperation.id, 'rename-pending');
});

test('pending, review-required and failed-restore targets cannot detach or be taken over from another directory', async t => {
  for (const state of ['pending', 'reviewRequired', 'restoreRequired']) {
    const f = await fixture(t), marker = path.join(f.project.dir, '.card-forge', 'bridge.json'), binding = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (state === 'restoreRequired') atomicJson(marker, { ...binding, restoreRequired: true });
    else atomicJson(path.join(f.project.dir, '.card-forge', 'operation.json'), { jobId: 'late-job', cardFile: 'A.png', state, localHash: 'irrelevant' });
    await assert.rejects(f.service.control({ action: 'detach', projectId: f.project.id }), e => ['OPERATION_PENDING', 'OPERATION_REVIEW_REQUIRED', 'RESTORE_REQUIRED'].includes(e.code));
    // Also reserve journals left behind by old versions which allowed detach.
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
  assert.equal((await f.service.status()).unattachedCards.some(c => c.cardFile === 'B.png'), false); assert.equal(f.calls.length, 0);
});
test('independent world binding and standalone book sync share unresolved target occupancy', async t => {
  const f = await fixture(t, false), oldDir = path.join(f.cardsRoot, 'OldBook'), newDir = path.join(f.cardsRoot, 'NewBook'); fs.mkdirSync(newDir, { recursive: true });
  atomicJson(path.join(oldDir, '.card-forge', 'bridge.json'), { cardFile: 'world:Book', detached: true });
  atomicJson(path.join(oldDir, '.card-forge', 'operation.json'), { jobId: 'late-book', cardFile: 'world:Book', state: 'pending' });
  await assert.rejects(f.service.control({ action: 'bindWorld', projectId: 'NewBook', worldName: 'Book' }), e => e.code === 'TARGET_OCCUPIED');
  await assert.rejects(new SyncEngine(f.adapter).run({ dir: newDir, cardFile: 'world:Book' }), e => e.code === 'TARGET_OCCUPIED');
  assert.equal(f.calls.length, 0);
});

test('panel attachWorld unpacks standalone world, export writes dist without dirtying localRevision, and shutdown stops service', async t => {
  const f = await fixture(t), worldFile = path.join(f.userDir, 'worlds', 'Solo.json');
  atomicJson(worldFile, { entries: { 1: { uid: 1, content: 'solo body', key: ['k'], keysecondary: [], comment: 'solo', order: 100, position: 0 } } });
  const beforeStatus = await f.service.status();
  assert.ok(beforeStatus.unattachedWorlds.some(w => w.worldName === 'Solo'));
  const attached = await f.service.control({ action: 'attachWorld', worldName: 'Solo' });
  assert.equal(attached.id, 'Solo'); assert.equal(attached.cardFile, 'world:Solo');
  assert.equal((await f.service.status()).unattachedWorlds.some(w => w.worldName === 'Solo'), false);
  const revBefore = f.adapter.localRevision(f.project);
  const exported = await f.service.control({ action: 'export', projectId: f.project.id });
  assert.ok(fs.existsSync(path.join(exported.outDir, 'A.json')));
  assert.ok(fs.existsSync(path.join(exported.outDir, 'A.png')));
  assert.equal(f.adapter.localRevision(f.project), revBefore);
  const customExportDir = path.join(f.cardsRoot, '_custom_export');
  const exportedCustom = await f.service.control({ action: 'export', projectId: f.project.id, outDir: customExportDir });
  assert.equal(exportedCustom.outDir, customExportDir);
  assert.ok(fs.existsSync(path.join(customExportDir, 'A.json')));
  assert.ok(fs.existsSync(path.join(customExportDir, 'A.png')));
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

test('custom backupDir writes external backup copy, and skipBackup requires explicit acceptDataLossRisk', async t => {
  const f = await fixture(t);
  const customBackupDir = path.join(path.dirname(f.cardsRoot), 'custom-backups');
  const setRes = await f.service.control({ action: 'setBackupDir', backupDir: customBackupDir });
  assert.equal(setRes.backupDir, customBackupDir);
  assert.equal((await f.service.status()).backupDir, customBackupDir);

  await body(f, 'updated with custom backup');
  const syncWithBackup = await f.service.control({ action: 'sync', projectId: f.project.id, direction: 'push' });
  const firstResult = syncWithBackup.results[0];
  assert.equal(firstResult.status, 'clean');
  assert.ok(firstResult.backupId);
  assert.equal(firstResult.backupSkipped, false);
  const exportedBackupFolder = path.join(customBackupDir, 'A', firstResult.backupId);
  assert.ok(fs.existsSync(path.join(exportedBackupFolder, 'snapshot.json')));
  assert.ok(fs.existsSync(path.join(exportedBackupFolder, 'A.png')));

  await body(f, 'updated without backup');
  const rejected = await f.service.control({ action: 'sync', projectId: f.project.id, direction: 'push', skipBackup: true, acceptDataLossRisk: false });
  assert.equal(rejected.results[0].error.code, 'CONFIRMATION_REQUIRED');

  const syncNoBackup = await f.service.control({ action: 'sync', projectId: f.project.id, direction: 'push', skipBackup: true, acceptDataLossRisk: true });
  assert.equal(syncNoBackup.results[0].status, 'clean');
  assert.equal(syncNoBackup.results[0].backupId, null);
  assert.equal(syncNoBackup.results[0].backupSkipped, true);

  const skillsRes = await f.service.control({ action: 'skillsStatus' });
  assert.ok(Array.isArray(skillsRes.skills));
  assert.ok(typeof skillsRes.summary === 'string' && skillsRes.summary.includes('Agent 全局提示词原件'));

  // setAutoBackup requires acceptDataLossRisk when disabling
  await assert.rejects(f.service.control({ action: 'setAutoBackup', enabled: false, acceptDataLossRisk: false }), e => e.code === 'CONFIRMATION_REQUIRED');
  const disabledAuto = await f.service.control({ action: 'setAutoBackup', enabled: false, acceptDataLossRisk: true });
  assert.equal(disabledAuto.autoBackupBeforeOverwrite, false);
  const reenabledAuto = await f.service.control({ action: 'setAutoBackup', enabled: true });
  assert.equal(reenabledAuto.autoBackupBeforeOverwrite, true);

  // followCard resumes the active attached card and pauses other attached cards
  fs.writeFileSync(path.join(f.userDir, 'characters', 'B.png'), embedChara(image, blank('B')));
  await f.service.control({ action: 'attach', cardFile: 'B.png' });
  const followB = await f.service.control({ action: 'followCard', cardFile: 'B.png' });
  assert.equal(followB.projects.find(p => p.id === 'B').paused, false);
  assert.equal(followB.projects.find(p => p.id === 'A').paused, true);
  const followUnattached = await f.service.control({ action: 'followCard', cardFile: 'Unattached.png' });
  assert.equal(followUnattached.projects.find(p => p.id === 'B').paused, true);
  assert.equal(followUnattached.projects.find(p => p.id === 'A').paused, true);

  // importFromWorkspace：新格式散文件（没有开头设置）直接按文件位置装配并导入酒馆；调研.md 不进卡
  const looseDir = path.join(f.cardsRoot, 'LooseCard');
  fs.mkdirSync(path.join(looseDir, 'message'), { recursive: true });
  fs.mkdirSync(path.join(looseDir, 'world_book'), { recursive: true });
  fs.writeFileSync(path.join(looseDir, 'description.md'), '这是散乱角色描述正文\n', 'utf8');
  fs.writeFileSync(path.join(looseDir, 'message', '0.md'), '这是散乱开场白正文\n', 'utf8');
  fs.writeFileSync(path.join(looseDir, 'world_book', '基地设定.md'), '这是散乱世界书条目正文\n', 'utf8');
  fs.writeFileSync(path.join(looseDir, '调研.md'), '这是不该塞进卡里的调研笔记\n', 'utf8');
  const imported = await f.service.control({ action: 'importFromWorkspace', projectId: 'LooseCard' });
  assert.equal(imported.project.attached, true);
  assert.equal(imported.project.status, 'clean');
  assert.equal(fs.readFileSync(path.join(looseDir, '调研.md'), 'utf8'), '这是不该塞进卡里的调研笔记\n');
  assert.equal(fs.readFileSync(path.join(looseDir, 'description.md'), 'utf8'), '这是散乱角色描述正文\n');
  const createdCard = readCardPng(path.join(f.userDir, 'characters', 'LooseCard.png'));
  assert.equal(createdCard.data.description, '这是散乱角色描述正文');
  assert.equal(createdCard.data.first_mes, '这是散乱开场白正文');
  assert.equal(createdCard.data.character_book.entries[0].content, '这是散乱世界书条目正文');
  assert.ok(!JSON.stringify(createdCard).includes('调研笔记'));

  // setCardsRoot 拒绝指向单张卡目录（含旧版 world/character 目录或 card.md），且旧版节点目录不会自动写空 card.md
  const legacyCardDir = path.join(f.cardsRoot, 'LegacySample');
  fs.mkdirSync(path.join(legacyCardDir, 'world', '示例世界'), { recursive: true });
  fs.mkdirSync(path.join(legacyCardDir, 'character', '示例角色'), { recursive: true });
  fs.writeFileSync(path.join(legacyCardDir, 'world', '示例世界', 'index.md'), '---\nid: w1\ntype: world\n---\n<!-- body -->\nworld\n');
  fs.writeFileSync(path.join(legacyCardDir, 'character', '示例角色', 'index.md'), '---\nid: c1\ntype: character\n---\n<!-- body -->\nchar\n');
  await assert.rejects(f.service.control({ action: 'setCardsRoot', cardsRoot: legacyCardDir }), e => e.code === 'INVALID_CARDS_ROOT');
  await assert.rejects(f.service.control({ action: 'importFromWorkspace', projectId: 'LegacySample' }), e => e.code === 'LEGACY_PROJECT');
  assert.equal(fs.existsSync(path.join(legacyCardDir, 'card.md')), false);
});

