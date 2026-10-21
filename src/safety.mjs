import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stable, canonicalJson } from '../extension/protocol.js';
export { stable };

export class BridgeError extends Error {
  constructor(code, message, status = 409, details) { super(message); this.code = code; this.status = status; this.details = details; }
}
export const fail = (code, message, status = 409, details) => { throw new BridgeError(code, message, status, details); };
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const hashObject = value => digest(canonicalJson(value));
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function segment(value, label = '名称') {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(value) || /[. ]$/.test(value) || value.startsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) fail('INVALID_PATH', `${label}不是安全的单层名称`, 400);
  return value;
}
export function contained(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) fail('INVALID_PATH', '只接受根目录内的相对路径', 400);
  const base = path.resolve(root), target = path.resolve(base, relative);
  if (!target.startsWith(base + path.sep)) fail('INVALID_PATH', '路径越界', 400);
  // Reject symlinks/junctions at every existing component, including the configured root.
  let current = path.parse(base).root;
  for (const part of path.relative(current, target).split(path.sep)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('INVALID_PATH', '不跟随符号链接或目录联接', 400); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}
// 参与装配的卡工程文件，与 card-forge-lab src/lib/nodes.mjs 的 implied() 同一口径：
// card.md、根目录字段 .md、message/<n>.md、world_book/**/*.md。调研.md、记录/ 等不算
const FIELD_FILES = new Set(['card', 'description', 'personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions']);
export function isCardFile(rel) {
  const parts = rel.split('/');
  // regex/、scripts/ 下拆出来的正则、脚本、变量文件（只收一层）
  if (parts.length === 2 && parts[0] === 'regex') return /\.(json|html)$/.test(parts[1]);
  if (parts.length === 2 && parts[0] === 'scripts') return /\.(json|js)$/.test(parts[1]);
  if (!parts.at(-1).endsWith('.md')) return false;
  if (parts.length === 1) return FIELD_FILES.has(parts[0].slice(0, -3));
  if (parts[0] === 'message') return parts.length === 2 && /^\d+\.md$/.test(parts[1]);
  return parts[0] === 'world_book';
}
export function nodeFiles(dir, skip = new Set(['backups', '待归位', '记录', '候选', 'note', 'handoff', 'node_modules', 'dist', '.git', '.card-forge'])) {
  const files = [];
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) fail('INVALID_PATH', `工程含链接：${next}`, 400);
      if (e.isDirectory()) { if (!rel ? ['message', 'world_book', 'regex', 'scripts'].includes(e.name) : next.startsWith('world_book/')) walk(next); }
      else if (isCardFile(next)) files.push(next);
    }
  };
  walk('');
  return files;
}
// 按卡分开排队：同一张卡的任务依次执行，不同卡互不等待。
// key 为 null 的是全局任务（换目录、关后台等），要等所有卡的任务做完，之后的任务也等它做完。
export class SerialQueue {
  tails = new Map();
  globalTail = Promise.resolve();
  active = new Map();
  size = 0;
  #seq = 0;
  get current() { return this.active.size ? this.active.values().next().value : null; }
  get tail() { return Promise.all([this.globalTail, ...this.tails.values()]).then(() => {}); }
  busy(key) { return (this.pending.get(key) ?? 0) > 0; }
  pending = new Map();
  run(label, fn, key = null) {
    const id = ++this.#seq;
    const previous = key === null ? Promise.all([this.globalTail, ...this.tails.values()]) : Promise.all([this.globalTail, this.tails.get(key)]);
    this.size++;
    if (key !== null) this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    const result = previous.then(async () => {
      this.active.set(id, label && typeof label === 'object' ? { ...label, queueKey: key } : label);
      try { return await fn(); } finally {
        this.active.delete(id); this.size--;
        if (key !== null) { const n = this.pending.get(key) - 1; if (n > 0) this.pending.set(key, n); else this.pending.delete(key); }
      }
    });
    const settled = result.catch(() => {});
    if (key === null) this.globalTail = settled;
    else {
      this.tails.set(key, settled);
      settled.then(() => { if (this.tails.get(key) === settled) this.tails.delete(key); });
    }
    return result;
  }
}
