import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { SyncService } from '../src/sync-service.mjs';
import { createMcpHandler, createMcpTools, TOOLS } from '../src/mcp.mjs';
import { createBridgeServer } from '../src/bridge.mjs';

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-mcp-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
class StubAdapter {
  calls = [];
  listWorlds() { return []; }
  async libraries() {
    return {
      nodes: { scanCard: async dir => ({ dir }) },
      protocol: { validateNodes: () => ({ errors: [{ node: 'world_book\\a.md', rule: 'P1', message: 'bad' }], warnings: [{ node: 'card.md', rule: 'W1', message: 'warn' }] }) },
    };
  }
}
function fixture(t) {
  const root = temp(t), cardsRoot = path.join(root, 'cards');
  fs.mkdirSync(path.join(cardsRoot, 'A', 'world_book'), { recursive: true });
  fs.writeFileSync(path.join(cardsRoot, 'A', 'card.md'), 'line1\r\nline2\r\n');
  const adapter = new StubAdapter();
  const service = new SyncService({ cardsRoot, runtimeRoot: path.join(root, 'runtime'), adapter });
  const calls = [];
  service.control = async body => { calls.push(body); return { ok: true, body }; };
  return { root, cardsRoot, service, tools: createMcpTools(service), calls };
}
const rejects = (p, code) => assert.rejects(p, e => e.code === code);

test('read returns hash; write requires matching baseHash without creating backups', async t => {
  const { tools, cardsRoot } = fixture(t);
  const r = await tools.read_file({ path: 'A/card.md' });
  assert.equal(r.totalLines, 3);
  await rejects(tools.write_file({ path: 'A/card.md', content: 'x' }), 'BASE_HASH_REQUIRED');
  await rejects(tools.write_file({ path: 'A/card.md', content: 'x', baseHash: 'wrong' }), 'HASH_MISMATCH');
  const w = await tools.write_file({ path: 'A/card.md', content: 'new', baseHash: r.hash });
  assert.equal(w.created, false);
  assert.equal('backupId' in w, false);
  assert.equal(fs.readFileSync(path.join(cardsRoot, 'A', 'card.md'), 'utf8'), 'new');
  const created = await tools.write_file({ path: 'A/world_book/n.md', content: 'n' });
  assert.equal(created.created, true);
});

test('paths stay inside shared root; internal dirs and project folders are protected', async t => {
  const { tools } = fixture(t);
  await rejects(tools.read_file({ path: '../x' }), 'INVALID_PATH');
  await rejects(tools.read_file({ path: 'C:/Windows/win.ini' }), 'INVALID_PATH');
  await rejects(tools.write_file({ path: 'A/.card-forge/bridge.json', content: '{}' }), 'FORBIDDEN_PATH');
  await rejects(tools.write_file({ path: 'backups/x.md', content: '' }), 'FORBIDDEN_PATH');
  await rejects(tools.delete({ path: 'A' }), 'FORBIDDEN_PATH');
  await rejects(tools.move({ from: 'A', to: 'B' }), 'FORBIDDEN_PATH');
  const listed = await tools.list_files({ depth: 3 });
  assert.ok(listed.entries.some(e => e.path === 'A/card.md'));
  assert.ok(!listed.entries.some(e => e.path.includes('.card-forge') || e.path.startsWith('backups')));
});

test('apply_patch keeps CRLF, needs unique match; move and delete check baseHash directly', async t => {
  const { tools, cardsRoot } = fixture(t);
  const file = path.join(cardsRoot, 'A', 'card.md');
  let { hash } = await tools.read_file({ path: 'A/card.md' });
  await rejects(tools.apply_patch({ path: 'A/card.md', baseHash: hash, edits: [{ oldText: 'line', newText: 'x' }] }), 'PATCH_NOT_UNIQUE');
  const p = await tools.apply_patch({ path: 'A/card.md', baseHash: hash, edits: [{ oldText: 'line1\nline2', newText: 'L1\nL2' }] });
  assert.equal(fs.readFileSync(file, 'utf8'), 'L1\r\nL2\r\n');
  await tools.create_dir({ path: 'A/world_book/地点' });
  const mv = await tools.move({ from: 'A/card.md', to: 'A/world_book/地点/c.md', baseHash: p.hash });
  assert.deepEqual(mv, { from: 'A/card.md', to: 'A/world_book/地点/c.md' });
  const movedFile = path.join(cardsRoot, 'A', 'world_book', '地点', 'c.md');
  assert.ok(fs.existsSync(movedFile));
  const del = await tools.delete({ path: 'A/world_book/地点/c.md', baseHash: p.hash });
  assert.deepEqual(del, { path: 'A/world_book/地点/c.md', deleted: true });
  assert.equal(fs.existsSync(movedFile), false);
});

test('search, file_info and validate tools', async t => {
  const { tools } = fixture(t);
  const s = await tools.search_files({ query: 'LINE2' });
  assert.deepEqual(s.results.map(r => [r.path, r.line]), [['A/card.md', 2]]);
  assert.equal((await tools.file_info({ path: 'A/nope.md' })).exists, false);
  assert.equal((await tools.file_info({ path: 'A' })).type, 'dir');
  const v = await tools.validate_card({ projectId: 'A' });
  assert.equal(v.ok, false); assert.equal(v.errors[0].file, 'world_book/a.md'); assert.equal(v.warnings.length, 1);
  const wb = await tools.validate_worldbook({ projectId: 'A' });
  assert.equal(wb.errors.length, 1); assert.equal(wb.warnings.length, 0);
  await rejects(tools.validate_card({ projectId: 'Z' }), 'PROJECT_NOT_FOUND');
});

test('card tools only disassemble the open card and sync_now delegates to service', async t => {
  const { tools, service, calls } = fixture(t);
  await rejects(tools.disassemble_card({}), 'NO_ACTIVE_CARD');
  service.state.activeCardFile = 'A.png';
  const dis = await tools.disassemble_card({ overwrite: true });
  assert.equal(dis.roundTrip.ok, true);
  assert.ok(Array.isArray(dis.next_actions));
  const syn = await tools.sync_now({ projectId: 'A' });
  assert.ok(Array.isArray(syn.next_actions));
  assert.equal('assemble_card' in tools, false);
  assert.equal('list_backups' in tools, false);
  assert.equal('restore_backup' in tools, false);
  assert.deepEqual(calls.map(c => c.action), ['attach', 'sync']);
  assert.equal(calls[0].cardFile, 'A.png');
  assert.equal(calls[0].overwrite, true);
});

test('writes to the same card wait for that card queue', async t => {
  const { tools, service } = fixture(t);
  let release; const gate = new Promise(r => { release = r; });
  const busy = service.queue.run({ action: 'automatic' }, () => gate, 'a');
  let done = false;
  const w = tools.write_file({ path: 'A/new.md', content: 'x' }).then(r => { done = true; return r; });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(done, false);
  release(); await busy; await w; assert.equal(done, true);
});

test('JSON-RPC: initialize, tools/list, tools/call errors, notifications', async t => {
  const { service } = fixture(t);
  const h = createMcpHandler(service, { version: '1' });
  const init = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal((await h({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  const list = await h({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, TOOLS.length);
  assert.ok(!list.result.tools.some(x => /exec|command|shell/.test(x.name)));
  const bad = await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: '../x' } } });
  assert.equal(bad.result.isError, true); assert.match(bad.result.content[0].text, /INVALID_PATH/);
  const noHash = await h({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'A/card.md', content: 'x' } } });
  assert.equal(noHash.result.isError, true);
  assert.match(noHash.result.content[0].text, /BASE_HASH_REQUIRED/);
  assert.match(noHash.result.content[0].text, /hint/);
  assert.equal((await h({ jsonrpc: '2.0', id: 4, method: 'nope' })).error.code, -32601);
});

test('HTTP /tt-bridge/mcp requires bearer token', async t => {
  const { service } = fixture(t);
  const { server } = createBridgeServer({ token: 'secret', origins: [], service });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/tt-bridge/mcp`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal((await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).status, 401);
  const ok = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer secret' } });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).result.tools.length, TOOLS.length);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer secret' } })).status, 405);
});
