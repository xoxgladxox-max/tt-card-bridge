#!/usr/bin/env node
// 技能同步：把仓库 skills/cf-* 部署到 LimCode 等技能目录，并比对各处是否最新。
// 用法：
//   node scripts/sync-skills.mjs status <技能目录>...        比对，不改文件
//   node scripts/sync-skills.mjs deploy <技能目录> [--dry-run] 备份后部署，清除改名前的旧目录
// 只处理 cf- 前缀技能和旧名残留；第三方技能（其他目录）一律不碰。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PREFIX = 'cf-';

// 改名前的旧目录名：目标里出现即为残留，deploy 时随整体备份后清除
export const LEGACY_NAMES = [
  'cf-card-workspace', 'cf-character-card-studio',
  'card-lint', 'card-research', 'card-workspace', 'character-card-builder',
  'character-card-studio', 'meta-prompt-rules', 'narrative-style-guide',
  'st-worldbook',
  // 已删除的技能
  'cf-meta-prompt-rules', 'cf-tool-usage-rules', 'cf-web-research-tools', 'tool-usage-rules', 'web-research-tools',
  // 按领域合并的技能
  'cf-card-agent-core', 'cf-card-agent-output', 'cf-card-master-workflow', 'cf-character-card-dispatch',
  'cf-narrative-style-guide', 'cf-st-card-format', 'cf-st-opening-message', 'cf-st-reply-format', 'cf-st-worldbook',
  // 改名后的技能
  'cf-card-lint', 'cf-card-world', 'cf-character-card-builder', 'cf-card-support',
];

export const STATE_LABEL = {
  current: '最新',
  missing: '缺失',
  outdated: '过期',
  'target-newer': '目标较新（拒绝降级）',
  'same-version-diff': '内容不同但版本号相同（先涨版本号）',
};
const BLOCKING = new Set(['target-newer', 'same-version-diff']);
const NEEDS_COPY = new Set(['missing', 'outdated']);

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFiles(abs, base));
    else if (e.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

export async function treeHash(dir) {
  const h = crypto.createHash('sha256');
  for (const rel of await listFiles(dir)) {
    const fh = crypto.createHash('sha256').update(await fs.readFile(path.join(dir, rel))).digest('hex');
    h.update(`${rel}\0${fh}\n`);
  }
  return h.digest('hex');
}

export async function readVersion(skillDir) {
  let raw;
  try { raw = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'); } catch { return null; }
  const fm = raw.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^\s+version:\s*["']?(\d+(?:\.\d+)*)/m);
  return m ? m[1] : null;
}

export function compareVersion(a, b) {
  if (!a || !b) return null;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export async function listSourceSkills(sourceDir) {
  const names = [];
  for (const e of await fs.readdir(sourceDir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith(PREFIX) && await exists(path.join(sourceDir, e.name, 'SKILL.md'))) {
      names.push(e.name);
    }
  }
  return names.sort();
}

export async function inspect(sourceDir, targetDir) {
  const rows = [];
  for (const name of await listSourceSkills(sourceDir)) {
    const src = path.join(sourceDir, name);
    const tgt = path.join(targetDir, name);
    const row = { name, srcVersion: await readVersion(src), tgtVersion: null, state: 'missing' };
    if (await exists(tgt)) {
      row.tgtVersion = await readVersion(tgt);
      if (await treeHash(src) === await treeHash(tgt)) {
        row.state = 'current';
      } else {
        const cmp = compareVersion(row.srcVersion, row.tgtVersion);
        if (cmp === null) row.state = row.tgtVersion ? 'same-version-diff' : 'outdated';
        else row.state = cmp > 0 ? 'outdated' : cmp < 0 ? 'target-newer' : 'same-version-diff';
      }
    }
    rows.push(row);
  }
  const legacy = [];
  for (const n of LEGACY_NAMES) if (await exists(path.join(targetDir, n))) legacy.push(n);
  return { rows, legacy };
}

export function formatReport(targetDir, { rows, legacy }) {
  const lines = [`== ${targetDir}`];
  for (const r of rows) {
    const v = r.tgtVersion && r.tgtVersion !== r.srcVersion
      ? `${r.tgtVersion} → ${r.srcVersion}`
      : (r.srcVersion ?? '无版本号');
    lines.push(`  ${STATE_LABEL[r.state]}  ${r.name}  ${v}`);
  }
  if (legacy.length) lines.push(`  旧名残留：${legacy.join('、')}`);
  const ok = rows.every(r => r.state === 'current') && !legacy.length;
  lines.push(ok ? '  结论：全部最新' : '  结论：需要部署');
  return { text: lines.join('\n'), ok };
}

function stamp(now) {
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}_${String(now.getMilliseconds()).padStart(3, '0')}`;
}

async function countFiles(dir) { return (await listFiles(dir)).length; }

export async function deploy(sourceDir, targetDir, { dryRun = false, now = new Date() } = {}) {
  if (!await exists(targetDir)) return { ok: false, reason: `目标目录不存在：${targetDir}` };
  const before = await inspect(sourceDir, targetDir);
  const blocked = before.rows.filter(r => BLOCKING.has(r.state));
  if (blocked.length) {
    return { ok: false, reason: '拒绝部署：' + blocked.map(r => `${r.name}（${STATE_LABEL[r.state]}）`).join('；'), before };
  }
  const todo = before.rows.filter(r => NEEDS_COPY.has(r.state)).map(r => r.name);
  if (!todo.length && !before.legacy.length) return { ok: true, nothing: true, before };
  if (dryRun) return { ok: true, dryRun: true, todo, remove: before.legacy, before };

  const baseBackup = path.join(path.dirname(targetDir), `${path.basename(targetDir)}.backup_sync_${stamp(now)}`);
  let backup = baseBackup;
  for (let i = 2; await exists(backup); i++) backup = `${baseBackup}-${i}`;
  await fs.cp(targetDir, backup, { recursive: true, errorOnExist: true, force: false });
  if (await countFiles(backup) !== await countFiles(targetDir)) {
    return { ok: false, reason: `备份文件数不符，已停止，未改动目标：${backup}`, before };
  }

  for (const name of todo) {
    const tgt = path.join(targetDir, name);
    await fs.rm(tgt, { recursive: true, force: true });
    await fs.cp(path.join(sourceDir, name), tgt, { recursive: true });
  }
  for (const name of before.legacy) await fs.rm(path.join(targetDir, name), { recursive: true, force: true });

  const after = await inspect(sourceDir, targetDir);
  const ok = after.rows.every(r => r.state === 'current') && !after.legacy.length;
  return { ok, backup, updated: todo, removed: before.legacy, before, after, reason: ok ? null : '部署后核对不一致' };
}

async function main(argv) {
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
  const [cmd, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  const targets = rest.filter(a => a !== '--dry-run');

  if (cmd === 'status' && targets.length) {
    let allOk = true;
    for (const t of targets) {
      if (!await exists(t)) { console.log(`== ${t}\n  目录不存在`); allOk = false; continue; }
      const { text, ok } = formatReport(t, await inspect(sourceDir, t));
      console.log(text);
      allOk &&= ok;
    }
    return allOk ? 0 : 1;
  }

  if (cmd === 'deploy' && targets.length === 1) {
    const r = await deploy(sourceDir, targets[0], { dryRun });
    if (r.before) console.log(formatReport(targets[0], r.before).text);
    if (!r.ok) { console.log(`失败：${r.reason}`); return 1; }
    if (r.nothing) {
      console.log('无需部署：全部最新。');
    } else if (r.dryRun) {
      console.log(`演练：将更新 ${r.todo.join('、') || '无'}；将清除旧名 ${r.remove.join('、') || '无'}。未改动任何文件。`);
    } else {
      console.log(`备份：${r.backup}`);
      console.log(`已更新：${r.updated.join('、') || '无'}`);
      console.log(`已清除旧名：${r.removed.join('、') || '无'}`);
      console.log('核对：全部最新');
      console.log('提醒：在 LimCode 设置 → 技能 点「刷新技能」生效。');
    }
    return 0;
  }

  console.log('用法：\n  node scripts/sync-skills.mjs status <技能目录>...\n  node scripts/sync-skills.mjs deploy <技能目录> [--dry-run]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e); process.exit(2); });
}
