import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installAgentSetup, removeAgentSetup, BRIDGE_MCP_ID, BRIDGE_PROFILE_ID, BRIDGE_TOOL_NAMES } from '../src/tt-agent-setup.mjs';
import { TOOLS } from '../src/mcp.mjs';

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-setup-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('tool names in registration match the MCP server', () => {
  assert.deepEqual([...BRIDGE_TOOL_NAMES].sort(), TOOLS.map(t => t.name).sort());
});

test('install writes only bridge files, backs up previous ones; remove deletes only them', t => {
  const dataRoot = temp(t), tt = path.join(dataRoot, '_tauritavern');
  const regs = path.join(tt, 'mcp', 'registrations'), profs = path.join(tt, 'agent-profiles', 'profiles');
  fs.mkdirSync(regs, { recursive: true }); fs.mkdirSync(profs, { recursive: true });
  fs.writeFileSync(path.join(regs, 'other.json'), '{"id":"other"}');
  fs.writeFileSync(path.join(profs, 'card-builder.json'), '{"id":"card-builder"}');
  const backupDir = path.join(dataRoot, 'bk');
  const r1 = installAgentSetup({ dataRoot, base: 'http://127.0.0.1:18789', token: 'tok', backupDir });
  assert.equal(r1.skipped, false); assert.equal(r1.backups.length, 0);
  const reg = JSON.parse(fs.readFileSync(path.join(regs, `${BRIDGE_MCP_ID}.json`), 'utf8'));
  assert.equal(reg.endpoint, 'http://127.0.0.1:18789/tt-bridge/mcp');
  assert.equal(reg.headers.Authorization, 'Bearer tok');
  const prof = JSON.parse(fs.readFileSync(path.join(profs, `${BRIDGE_PROFILE_ID}.json`), 'utf8'));
  assert.ok(prof.tools.allow.includes(`mcp/${BRIDGE_MCP_ID}:read_file`));
  const r2 = installAgentSetup({ dataRoot, base: 'http://127.0.0.1:18789', token: 'tok2', backupDir });
  assert.equal(r2.backups.length, 2);
  const r3 = removeAgentSetup({ dataRoot, backupDir: path.join(dataRoot, 'bk2') });
  assert.equal(r3.removed.length, 2);
  assert.deepEqual(fs.readdirSync(regs), ['other.json']);
  assert.deepEqual(fs.readdirSync(profs), ['card-builder.json']);
});

test('install skips when TauriTavern agent folders are absent', t => {
  const r = installAgentSetup({ dataRoot: temp(t), base: 'http://x', token: 't', backupDir: 'unused' });
  assert.equal(r.skipped, true);
});
