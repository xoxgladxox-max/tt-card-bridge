#!/usr/bin/env node
// skills.mjs — 技能只改一份原件（config.json 的 skillsRoot/skills），同步到 LimCode TEST、Claude Code、~/.agents/skills 和酒馆，并保留每个版本供回档
//
// 用法：
//   node scripts/tt-skills.mjs status                 三处对照：原件 / 版本存档 / LimCode TEST / 酒馆
//   node scripts/tt-skills.mjs deploy                 存档当前版本 → 部署 LimCode TEST → 通知酒馆安装（酒馆需开着）
//   node scripts/tt-skills.mjs versions <技能名>        列出这个技能存过的版本
//   node scripts/tt-skills.mjs rollback <技能名> <版本>  把原件换回某个存档版本（版本号自动往上涨一级），之后再 deploy
//   node scripts/tt-skills.mjs install-script         把 tavern-refresh-script.js 写进酒馆设置（酒馆需关着）
//
// 版本存档：skills-versions/<技能名>/<版本号>/，存过就不再改。同一版本号内容变了会拒绝，要求先涨版本号。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listSourceSkills, readVersion, treeHash, compareVersion, deploy as deployLimcode, inspect, formatReport } from './skill-deploy.mjs';
import { tavernDataRoot, tavernUserDir, isNativeSillyTavern } from './paths.mjs';
import { startBridge, stopBridge, publishSkillJob } from './bridge.mjs';
import { fail } from './safety.mjs';

const exists = p => fs.existsSync(p);

// 技能原件所在的项目（里面有 skills/ 和 skills-versions/）。不放在本项目里，本项目只管连通。
// 顺序：环境变量 TT_SKILLS_ROOT → 本项目 config.json 的 skillsRoot。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawSkillsRoot = process.env.TT_SKILLS_ROOT
  ?? (exists(path.join(ROOT, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).skillsRoot : null);
const SKILLS_ROOT = rawSkillsRoot ? path.resolve(ROOT, rawSkillsRoot) : null;
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (IS_MAIN && (!SKILLS_ROOT || !exists(path.join(SKILLS_ROOT, 'skills')))) {
  console.log(`找不到技能原件。请在 ${path.join(ROOT, 'config.json')} 里写 {"skillsRoot": "<含 skills 文件夹的项目>"}`);
  process.exit(2);
}
const SRC = SKILLS_ROOT ? path.join(SKILLS_ROOT, 'skills') : '';
const ARCHIVE = SKILLS_ROOT ? path.join(SKILLS_ROOT, 'skills-versions') : '';
const DEFAULT_LIMCODE = path.join(process.env.APPDATA ?? '', 'Code', 'User', 'globalStorage', 'your-publisher.limcode-test', 'skills');
const LIMCODE = DEFAULT_LIMCODE;
const TT_SKILLS = path.join(tavernDataRoot(), '_tauritavern', 'skills', 'installed', 'global');
const SCRIPT_NAME = '卡片同步刷新';

// 酒馆里的旧技能名 → 现在的名字；null 表示这个技能已删除，
// 部署时从酒馆删掉，并从 Agent 配置的技能列表里去掉。
export const TAVERN_RENAMES = {
  'card-lint': 'cf-card-review',
  'card-workspace': 'cf-card-oneclick',
  'character-card-builder': 'cf-card-character',
  'character-card-studio': 'cf-card-oneclick',
  'meta-prompt-rules': null,
  'narrative-style-guide': 'cf-card-format-export',
  'st-worldbook': 'cf-card-worldbook',
  'tool-usage-rules': null,
  'web-research-tools': null,
  'cf-meta-prompt-rules': null,
  'cf-tool-usage-rules': null,
  'cf-web-research-tools': null,
  // 按领域合并的技能
  'cf-card-agent-core': null,
  'cf-card-agent-output': null,
  'cf-card-master-workflow': 'cf-card-oneclick',
  'cf-character-card-dispatch': 'cf-card-oneclick',
  'cf-narrative-style-guide': 'cf-card-format-export',
  'cf-st-card-format': 'cf-card-format-export',
  'cf-st-opening-message': 'cf-card-format-export',
  'cf-st-reply-format': 'cf-card-format-export',
  'cf-st-worldbook': 'cf-card-worldbook',
  // 改名后的技能
  'cf-card-lint': 'cf-card-review',
  'cf-card-world': 'cf-card-worldbook',
  'cf-character-card-builder': 'cf-card-character',
  'cf-card-support': 'cf-card-format-export',
};

// 其他支持 SKILL.md 的工具：宿主目录（~/.claude、~/.agents）存在才部署，缺 skills 子目录时新建。
// 只动 cf- 前缀和旧名目录，第三方技能不碰；覆盖前整体备份（skill-deploy.mjs 的 deploy）。
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';
export const EXTRA_TARGETS = [
  { label: 'Claude Code', dir: path.join(HOME, '.claude', 'skills') },
  { label: 'Codex 等通用目录', dir: path.join(HOME, '.agents', 'skills') },
];

export async function deployExtraTargets(srcDir, lines, { targets = EXTRA_TARGETS, skipBackup = false } = {}) {
  const results = [];
  for (const t of targets) {
    lines.push(`== ${t.label}（${t.dir}）`);
    if (!exists(path.dirname(t.dir))) { lines.push('  没有装这个工具（宿主目录不存在），跳过'); results.push({ ...t, skipped: true }); continue; }
    if (!exists(t.dir)) { await fsp.mkdir(t.dir, { recursive: true }); lines.push('  新建 skills 目录'); }
    const r = await deployLimcode(srcDir, t.dir);
    results.push({ ...t, result: r });
    if (!r.ok) { lines.push(`  失败：${r.reason}`); continue; }
    if (skipBackup && r.backup && exists(r.backup)) await fsp.rm(r.backup, { recursive: true, force: true });
    if (r.nothing) { lines.push('  全部最新，无需部署'); continue; }
    if (!skipBackup && r.backup) lines.push(`  备份：${r.backup}`);
    lines.push(`  已更新：${r.updated.join('、') || '无'}`);
    if (r.removed.length) lines.push(`  已清除旧名：${r.removed.join('、')}`);
  }
  return results;
}

async function extraStatusLines(srcDir) {
  const out = [];
  for (const t of EXTRA_TARGETS) {
    if (!exists(t.dir)) { out.push(`${t.label}：目录不存在（${t.dir}）`); continue; }
    out.push(formatReport(t.dir, await inspect(srcDir, t.dir)).text.replace(/^== /, `${t.label}：`));
  }
  return out;
}


// ---------- 版本存档 ----------
function archivedVersions(name) {
  const d = path.join(ARCHIVE, name);
  if (!exists(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    .sort((a, b) => compareVersion(a, b) ?? 0);
}

async function archiveCurrent(name) {
  const src = path.join(SRC, name);
  const ver = await readVersion(src);
  if (!ver) return { name, state: 'error', msg: 'SKILL.md 里没有 metadata.version' };
  const dst = path.join(ARCHIVE, name, ver);
  if (exists(dst)) {
    return await treeHash(src) === await treeHash(dst)
      ? { name, ver, state: 'kept' }
      : { name, ver, state: 'error', msg: `版本 ${ver} 已存档但内容不同，先涨版本号` };
  }
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
  return { name, ver, state: 'archived' };
}

function bumpPatch(ver) {
  const p = ver.split('.').map(Number);
  while (p.length < 3) p.push(0);
  p[2] += 1;
  return p.join('.');
}

// ---------- 酒馆状态（只读文件） ----------
async function tavernState(name) {
  const d = path.join(TT_SKILLS, name);
  if (!exists(d)) return null;
  return { version: await readVersion(d), hash: await treeHash(d) };
}

function tavernRunning() {
  try {
    return execSync('tasklist /FI "IMAGENAME eq tauritavern.exe" /NH', { encoding: 'utf8' }).toLowerCase().includes('tauritavern.exe');
  } catch { return false; }
}

// ---------- 命令 ----------
async function status() {
  const names = await listSourceSkills(SRC);
  console.log('技能                         原件     存档   LimCode TEST   酒馆');
  for (const n of names) {
    const src = path.join(SRC, n);
    const v = await readVersion(src);
    const h = await treeHash(src);
    const arch = archivedVersions(n);
    const archTxt = arch.includes(v) ? '已存' : '未存';
    const lcDir = path.join(LIMCODE, n);
    const lc = exists(lcDir) ? (await treeHash(lcDir) === h ? '最新' : `不同(${await readVersion(lcDir)})`) : '缺';
    const tt = await tavernState(n);
    const ttTxt = !tt ? '缺' : tt.hash === h ? '最新' : `不同(${tt.version ?? '?'})`;
    console.log(`${n.padEnd(28)} ${String(v).padEnd(8)} ${archTxt}   ${lc.padEnd(14)} ${ttTxt}`);
  }
  const leftovers = Object.keys(TAVERN_RENAMES).filter(o => exists(path.join(TT_SKILLS, o)));
  if (leftovers.length) console.log(`酒馆里的旧技能：${leftovers.join('、')}`);
  for (const l of await extraStatusLines(SRC)) console.log(l);
}

async function deployAll() {
  const names = await listSourceSkills(SRC);

  console.log('== 1. 存档当前版本');
  const arch = [];
  for (const n of names) arch.push(await archiveCurrent(n));
  const bad = arch.filter(a => a.state === 'error');
  for (const a of arch) console.log(`  ${a.name}  ${a.ver ?? ''}  ${a.state === 'archived' ? '新存档' : a.state === 'kept' ? '已有' : '失败：' + a.msg}`);
  if (bad.length) { console.log('已停止：存档有问题，LimCode TEST 和酒馆都没有改动。'); return 1; }

  console.log('== 2. LimCode TEST');
  if (!exists(LIMCODE)) { console.log(`  目录不存在：${LIMCODE}，跳过`); }
  else {
    const r = await deployLimcode(SRC, LIMCODE);
    if (!r.ok) { console.log(`  失败：${r.reason}`); return 1; }
    if (r.nothing) console.log('  全部最新，无需部署');
    else {
      console.log(`  备份：${r.backup}`);
      console.log(`  已更新：${r.updated.join('、') || '无'}`);
      if (r.removed.length) console.log(`  已清除旧名：${r.removed.join('、')}`);
      console.log('  需要在 LimCode 设置 → 技能 点「刷新技能」才会在当前会话生效');
    }
  }

  const extraLines = [];
  const extra = await deployExtraTargets(SRC, extraLines);
  for (const l of extraLines) console.log(l);
  if (extra.some(e => e.result && !e.result.ok)) return 1;

  console.log('== 3. 酒馆');
  if (!tavernRunning()) { console.log('  酒馆没开，跳过。打开酒馆后再运行一次 deploy。'); return 0; }
  const todo = [];
  for (const n of names) {
    const tt = await tavernState(n);
    if (!tt || tt.hash !== await treeHash(path.join(SRC, n))) todo.push({ name: n, dir: path.join(SRC, n) });
  }
  const remove = Object.keys(TAVERN_RENAMES).filter(o => exists(path.join(TT_SKILLS, o)));
  if (!todo.length && !remove.length) { console.log('  全部最新，无需同步'); }
  const job = { id: crypto.randomUUID(), install: todo, remove, renames: TAVERN_RENAMES };
  if (!todo.length && !remove.length) job.install = [];
  console.log(`  待安装/替换：${todo.map(t => t.name).join('、') || '无'}`);
  console.log(`  待删除旧技能：${remove.join('、') || '无'}`);
  console.log('  同时检查 Agent 配置里的旧技能名');

  const own = await startBridge(m => console.log('  ' + m));
  console.log('  等酒馆里的扩展 tt-card-bridge 接手（最多 90 秒）……');
  let res;
  try { res = await publishSkillJob(job); } finally { if (own) stopBridge(); }
  if (!res) { console.log('  超时：酒馆没有回应。确认酒馆开着、扩展 tt-card-bridge 已启用且是最新版（tt-card install）。'); return 1; }
  if (res.fatal) { console.log(`  失败：${res.fatal}`); return 1; }
  for (const r of res.results) console.log(`  ${r.name}：${r.error ? '失败 ' + r.error : r.action}${r.version ? ' ' + r.version : ''}`);
  if (res.profileError) console.log(`  Agent 配置改名失败：${res.profileError}`);
  else console.log(`  Agent 配置已改技能名：${res.profiles.length ? res.profiles.join('、') : '无需修改'}`);
  console.log(`  酒馆现有全局技能：${res.final.map(f => f.name).join('、')}`);
  return res.profileError || res.results.some(r => r.error) ? 1 : 0;
}

async function versions(name) {
  const list = archivedVersions(name);
  const cur = await readVersion(path.join(SRC, name));
  if (!list.length) { console.log(`${name} 还没有存档`); return 0; }
  for (const v of list) {
    const d = path.join(ARCHIVE, name, v);
    const st = fs.statSync(d);
    console.log(`  ${v}${v === cur ? '  ← 原件当前' : ''}  存档于 ${st.birthtime.toLocaleString('zh-CN')}`);
  }
  return 0;
}

async function rollback(name, ver) {
  const from = path.join(ARCHIVE, name, ver);
  const src = path.join(SRC, name);
  if (!exists(from)) { console.log(`没有这个存档：${from}`); return 1; }
  const a = await archiveCurrent(name);
  if (a.state === 'error') { console.log(`原件当前内容存档失败：${a.msg}。没有回档。`); return 1; }
  const curVer = await readVersion(src);
  const allVers = [curVer, ...archivedVersions(name)].filter(Boolean).sort((x, y) => compareVersion(x, y) ?? 0);
  const newVer = bumpPatch(allVers[allVers.length - 1]);
  await fsp.rm(src, { recursive: true, force: true });
  await fsp.cp(from, src, { recursive: true });
  const f = path.join(src, 'SKILL.md');
  const text = fs.readFileSync(f, 'utf8').replace(/^(\s+version:\s*["']?)[\d.]+/m, `$1${newVer}`);
  fs.writeFileSync(f, text, 'utf8');
  console.log(`已把原件 ${name} 换回 ${ver} 的内容，版本号记为 ${newVer}（${curVer} 已存档，可再回来）。`);
  console.log('运行 deploy 后，LimCode TEST 和酒馆才会换成这个版本。');
  return 0;
}

async function installScript() {
  if (tavernRunning()) { console.log('酒馆开着时写设置会被酒馆覆盖。先关掉酒馆再运行。'); return 1; }
  const settings = path.join(tavernUserDir(), 'settings.json');
  const bk = `${settings}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(settings, bk);
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  const sc = s.extension_settings?.tavern_helper?.script;
  if (!sc || !Array.isArray(sc.scripts)) { console.log('设置里没有酒馆助手脚本列表，未修改。'); return 1; }
  const content = fs.readFileSync(path.join(ROOT, 'extension', '_old-tavern-helper-script.js'), 'utf8');
  const old = sc.scripts.find(x => x.name === SCRIPT_NAME);
  if (old) { old.content = content; old.enabled = true; }
  else {
    sc.scripts.push({
      type: 'script', enabled: true, name: SCRIPT_NAME, id: crypto.randomUUID(), content,
      info: 'VS Code 同步程序改写角色卡后自动刷新；deploy 技能时在酒馆里安装技能。来源：tt-card-bridge/extension/_old-tavern-helper-script.js',
      button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false },
    });
  }
  fs.writeFileSync(settings, JSON.stringify(s, null, 4), 'utf8');
  const back = JSON.parse(fs.readFileSync(settings, 'utf8')).extension_settings.tavern_helper.script.scripts.find(x => x.name === SCRIPT_NAME);
  console.log(`已${old ? '更新' : '加入'}酒馆助手全局脚本「${SCRIPT_NAME}」，读回长度 ${back.content.length} 字符，启用=${back.enabled}`);
  console.log(`设置备份：${bk}`);
  return 0;
}

export async function inspectSkillsAndAgents({ skillsRoot = SKILLS_ROOT, userDir = tavernUserDir(), limcodeDir = DEFAULT_LIMCODE } = {}) {
  const resolvedRoot = skillsRoot ? path.resolve(ROOT, skillsRoot) : null;
  const srcDir = resolvedRoot ? path.join(resolvedRoot, 'skills') : '';
  if (!srcDir || !exists(srcDir)) fail('SKILLS_ROOT_NOT_FOUND', '找不到技能原件目录 skills/', 404);
  const archDir = path.join(resolvedRoot, 'skills-versions');
  const ttSkillsDir = path.join(path.dirname(userDir), '_tauritavern', 'skills', 'installed', 'global');
  const names = await listSourceSkills(srcDir);
  const skills = [];
  const lines = ['技能                         原件     存档   LimCode TEST   酒馆'];
  for (const n of names) {
    const src = path.join(srcDir, n);
    const v = await readVersion(src);
    const h = await treeHash(src);
    const archList = exists(path.join(archDir, n))
      ? fs.readdirSync(path.join(archDir, n), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
      : [];
    const archTxt = archList.includes(v) ? '已存' : '未存';
    const lcDir = path.join(limcodeDir, n);
    const lc = exists(lcDir) ? (await treeHash(lcDir) === h ? '最新' : `不同(${await readVersion(lcDir)})`) : '缺';
    const ttDir = path.join(ttSkillsDir, n);
    const tt = exists(ttDir) ? { version: await readVersion(ttDir), hash: await treeHash(ttDir) } : null;
    const ttTxt = !tt ? '缺' : tt.hash === h ? '最新' : `不同(${tt.version ?? '?'})`;
    skills.push({ name: n, version: v, archived: archList.includes(v), limcode: lc, tavern: ttTxt });
    lines.push(`${n.padEnd(28)} ${String(v).padEnd(8)} ${archTxt}   ${lc.padEnd(14)} ${ttTxt}`);
  }
  const leftovers = Object.keys(TAVERN_RENAMES).filter(o => exists(path.join(ttSkillsDir, o)));
  if (leftovers.length) lines.push(`酒馆里的旧技能：${leftovers.join('、')}`);
  for (const l of await extraStatusLines(srcDir)) lines.push(l);
  const agentPromptPath = path.join(resolvedRoot, 'docs', 'agent-system', 'global-system-prompt-20261012.txt');
  const agentPrompt = exists(agentPromptPath)
    ? { exists: true, path: agentPromptPath, bytes: fs.statSync(agentPromptPath).size }
    : { exists: false, path: agentPromptPath, bytes: 0 };
  lines.push(`Agent 全局提示词原件：${agentPrompt.exists ? `就绪（${agentPrompt.bytes} bytes）` : '未找到'}`);
  return { skills, leftovers, agentPrompt, summary: lines.join('\n') };
}

export async function deploySkillsAndAgents({
  skillsRoot = SKILLS_ROOT,
  userDir = tavernUserDir(),
  limcodeDir = DEFAULT_LIMCODE,
  publishSkillJobFn = publishSkillJob,
  skipBackup = false,
  acceptDataLossRisk = false,
  backupDir = '',
} = {}) {
  if (skipBackup && !acceptDataLossRisk) {
    fail('CONFIRMATION_REQUIRED', '不备份直接覆盖技能与 Agent 配置前，必须勾选确认自行承担数据丢失责任', 400);
  }
  const resolvedRoot = skillsRoot ? path.resolve(ROOT, skillsRoot) : null;
  const srcDir = resolvedRoot ? path.join(resolvedRoot, 'skills') : '';
  if (!srcDir || !exists(srcDir)) fail('SKILLS_ROOT_NOT_FOUND', '找不到技能原件目录 skills/', 404);
  const archDir = path.join(resolvedRoot, 'skills-versions');
  const ttSkillsDir = path.join(path.dirname(userDir), '_tauritavern', 'skills', 'installed', 'global');
  const names = await listSourceSkills(srcDir);
  const lines = ['== 1. 存档当前版本'];
  const arch = [];
  for (const n of names) {
    const src = path.join(srcDir, n);
    const ver = await readVersion(src);
    if (!ver) { arch.push({ name: n, state: 'error', msg: 'SKILL.md 里没有 metadata.version' }); continue; }
    const dst = path.join(archDir, n, ver);
    if (exists(dst)) {
      arch.push(await treeHash(src) === await treeHash(dst)
        ? { name: n, ver, state: 'kept' }
        : { name: n, ver, state: 'error', msg: `版本 ${ver} 已存档但内容不同，先涨版本号` });
    } else {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
      arch.push({ name: n, ver, state: 'archived' });
    }
  }
  for (const a of arch) lines.push(`  ${a.name}  ${a.ver ?? ''}  ${a.state === 'archived' ? '新存档' : a.state === 'kept' ? '已有' : '失败：' + a.msg}`);
  const bad = arch.filter(a => a.state === 'error');
  if (bad.length) fail('SKILL_ARCHIVE_FAILED', lines.join('\n') + '\n已停止：存档有问题，未改动 LimCode TEST 和酒馆。', 409);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const customBackupRoot = typeof backupDir === 'string' && backupDir.trim() ? path.resolve(backupDir.trim()) : null;
  let customBackupPath = null;
  if (!skipBackup && customBackupRoot) {
    customBackupPath = path.join(customBackupRoot, `skills-agent-backup-${stamp}`);
    await fsp.mkdir(customBackupPath, { recursive: true });
    if (exists(limcodeDir)) await fsp.cp(limcodeDir, path.join(customBackupPath, 'limcode-skills'), { recursive: true });
    if (exists(ttSkillsDir)) await fsp.cp(ttSkillsDir, path.join(customBackupPath, 'tavern-global-skills'), { recursive: true });
    lines.push(`== 自定义位置备份：${customBackupPath}`);
  } else if (skipBackup) {
    lines.push('== 已按用户确认跳过覆盖前备份（数据丢失责任自负）');
  }

  lines.push('== 2. LimCode TEST');
  let limcodeResult = null;
  if (!exists(limcodeDir)) {
    lines.push(`  目录不存在：${limcodeDir}，跳过`);
  } else {
    const r = await deployLimcode(srcDir, limcodeDir);
    if (!r.ok) fail('LIMCODE_DEPLOY_FAILED', `LimCode 技能部署失败：${r.reason}`, 409);
    if (skipBackup && r.backup && exists(r.backup)) await fsp.rm(r.backup, { recursive: true, force: true });
    limcodeResult = r;
    if (r.nothing) lines.push('  全部最新，无需部署');
    else {
      if (!skipBackup && r.backup) lines.push(`  备份：${r.backup}`);
      lines.push(`  已更新：${r.updated.join('、') || '无'}`);
      if (r.removed.length) lines.push(`  已清除旧名：${r.removed.join('、')}`);
    }
  }

  const extra = await deployExtraTargets(srcDir, lines, { skipBackup });

  lines.push('== 3. 酒馆技能与 Agent 配置');
  const todo = [];
  for (const n of names) {
    const ttDir = path.join(ttSkillsDir, n);
    const ttHash = exists(ttDir) ? await treeHash(ttDir) : null;
    if (!ttHash || ttHash !== await treeHash(path.join(srcDir, n))) todo.push({ name: n, dir: path.join(srcDir, n) });
  }
  const remove = Object.keys(TAVERN_RENAMES).filter(o => exists(path.join(ttSkillsDir, o)));
  const job = { id: crypto.randomUUID(), install: todo, remove, renames: TAVERN_RENAMES, sourceSkills: names };
  lines.push(`  待安装/替换技能：${todo.map(t => t.name).join('、') || '无'}`);
  lines.push(`  待清理旧技能：${remove.join('、') || '无'}`);
  const res = await publishSkillJobFn(job);
  if (!res) fail('SKILL_SYNC_TIMEOUT', '酒馆扩展未回应技能与 Agent 同步任务，请确认酒馆正在运行。', 504);
  if (res.fatal) fail('SKILL_SYNC_FAILED', res.fatal, 502);
  for (const r of res.results ?? []) lines.push(`  ${r.name}：${r.error ? '失败 ' + r.error : r.action}${r.version ? ' ' + r.version : ''}`);
  if (res.profileError) lines.push(`  Agent 配置同步失败：${res.profileError}`);
  else {
    lines.push(`  已检查酒馆 Agent：${res.checkedProfiles?.length ? res.checkedProfiles.join('、') : '无'}`);
    lines.push(`  已更新酒馆 Agent：${res.profiles?.length ? res.profiles.join('、') : '全部最新（无需改动）'}`);
  }
  lines.push(`  酒馆现有全局技能：${(res.final ?? []).map(f => f.name).join('、')}`);
  return {
    ok: !res.profileError && !(res.results ?? []).some(r => r.error) && !extra.some(e => e.result && !e.result.ok),
    backupSkipped: Boolean(skipBackup),
    customBackupPath,
    limcode: limcodeResult,
    tavern: res,
    summary: lines.join('\n'),
  };
}

if (IS_MAIN) {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (isNativeSillyTavern() && cmd && cmd !== 'status' && cmd !== 'versions') {
    console.error('技能部署和 Agent 配置只支持 TauriTavern。现在指向的是原生 SillyTavern（TAVERN_USER_DIR 或 config.json 的 tavernUserDir），去掉这个设置再运行。');
    process.exit(1);
  }
  const run = {
    status: () => status().then(() => 0),
    deploy: deployAll,
    versions: () => a1 ? versions(a1) : (console.log('用法：versions <技能名>'), 2),
    rollback: () => a1 && a2 ? rollback(a1, a2) : (console.log('用法：rollback <技能名> <版本>'), 2),
    'install-script': () => (console.log('旧的酒馆助手脚本已改成酒馆扩展。请用：tt-card install'), 2),
  }[cmd];
  if (!run) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n'));
    process.exit(2);
  }
  Promise.resolve(run()).then(code => process.exit(code ?? 0), e => { console.error(e); process.exit(2); });
}
