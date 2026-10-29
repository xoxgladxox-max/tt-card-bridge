// fingerprint.mjs — 内容指纹与检查记录
// 检查记录回答的是“这份内容当时有没有过检”，不代替作者确认。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const RULES_VERSION = 'protocol-0.1';

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// 稳定数字 id（条目 id 用）：FNV-1a 32bit
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2147483647; // 保持正数且在 JSON 安全范围
}

export function checksDir(rootDir) { return path.join(rootDir, '.card-forge', 'checks'); }
export function reportsDir(rootDir) { return path.join(rootDir, '.card-forge', 'reports'); }

export async function loadCheckRecords(rootDir) {
  const dir = checksDir(rootDir);
  const out = new Map();
  let files = [];
  try { files = await fs.readdir(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      if (rec.nodeId) out.set(rec.nodeId, rec);
    } catch { /* 坏记录按未记录处理 */ }
  }
  return out;
}

export async function writeCheckRecord(rootDir, rec) {
  const dir = checksDir(rootDir);
  await fs.mkdir(dir, { recursive: true });
  const safeName = String(rec.nodeId).replace(/[\\/]+/g, '__');
  const file = path.join(dir, `${safeName}.json`);
  await fs.writeFile(file, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  return file;
}

// fresh | stale | unrecorded
export function checkState(node, records) {
  if (!node.id) return 'unrecorded';
  const rec = records.get(node.id);
  if (!rec) return 'unrecorded';
  if (rec.rulesVersion !== RULES_VERSION) return 'stale';
  return rec.sha256 === sha256Hex(node.body) ? 'fresh' : 'stale';
}