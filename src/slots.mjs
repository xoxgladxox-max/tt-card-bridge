// slots.mjs — 把一张卡拆成可对照的「槽位」：卡字段、备选开场白、世界书条目、正则和脚本
// 节点工程和酒馆两边用同一套槽位名，pull 和 push 靠它判断哪边改过。
//   field:<字段名>     description、personality、scenario、first_mes、mes_example、system_prompt、post_history_instructions
//   greeting:<序号>    备选开场白，按节点 order 排序后的位置
//   entry:<条目 uid>   世界书条目；节点里 tavern.id 优先，没有时与装配一致用 fnv1a(节点 id)
//   regex:<id> / script:<id> / vars / xbtasks   正则、酒馆助手脚本、角色变量、小白X任务（整项 JSON）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseChunks } from './png.mjs';
import { tavernCharDir, tavernUserDir } from './paths.mjs';
import { contained, segment, readJson, atomicJson } from './safety.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORGE_ROOT = path.join(ROOT, 'src', 'forge');
export const forge = rel => import(pathToFileURL(path.join(FORGE_ROOT, rel.replace(/^src[\\/]/, ''))).href);
// 正则、脚本、变量的拆分规则直接用内置 forge 模块，不依赖外部技能仓库
export const extrasLib = await forge('lib/extras.mjs');
// 键名排序后的 JSON：正则、脚本等整项比对，键顺序不算差异
const sortKeys = o => Array.isArray(o) ? o.map(sortKeys) : (o && typeof o === 'object') ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sortKeys(o[k])])) : o;
export const stableJson = v => JSON.stringify(sortKeys(v), null, 2);
// 可拆项槽位：regex:<id>、script:<id>、vars、xbtasks，值是整项 JSON
export function extraSlots(card) {
  const slots = {};
  for (const item of extrasLib.listExtras(card)) slots[item.key] = { value: stableJson(item.value), label: `${{ regex: '正则', script: '脚本', vars: '', xbtasks: '' }[item.kind]}${item.kind === 'vars' || item.kind === 'xbtasks' ? '' : '：'}${item.label}`, extraKind: item.kind };
  return slots;
}
export const extraOrder = card => extrasLib.listExtras(card).map(i => i.key);

const FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions'];
const norm = s => String(s ?? '').replaceAll('\r\n', '\n').trim();
export const slotHash = s => crypto.createHash('sha256').update(norm(s)).digest('hex').slice(0, 16);

// 条目设置：只比对会影响触发和插入的几项，统一成世界书文件的写法
const settingsOfWorld = e => JSON.stringify([e.key ?? [], e.keysecondary ?? [], !!e.constant, !e.disable, e.order, e.position, e.depth ?? 4, e.scanDepth ?? null, e.probability ?? 100]);
const settingsOfBook = e => JSON.stringify([e.keys ?? [], e.secondary_keys ?? [], !!e.constant, e.enabled !== false, e.insertion_order, e.extensions?.position ?? (e.position === 'before_char' ? 0 : 1), e.extensions?.depth ?? 4, e.extensions?.scan_depth ?? null, e.extensions?.probability ?? 100]);

export function readSlotsFromNodes(scan, fingerprint, nodesLib) {
  const { fnv1a } = fingerprint;
  const { defaultTarget } = nodesLib;
  const slots = {};
  const greetings = [];
  for (const n of scan.nodes) {
    if (n.type === 'card' || n.type === 'note') continue;
    const t = defaultTarget(n, scan);
    const base = { value: norm(n.body), relPath: n.relPath, label: String(n.frontmatter?.title ?? path.basename(n.dir)) };
    if (FIELDS.includes(t)) slots[`field:${t}`] = base;
    else if (t === 'alternate_greetings') greetings.push({ n, base });
    else if (t === 'character_book') {
      const id = n.frontmatter?.tavern?.id ?? fnv1a(n.id);
      slots[`entry:${id}`] = { ...base, node: n };
    }
  }
  greetings.sort((a, b) => (a.n.order ?? 100) - (b.n.order ?? 100));
  greetings.forEach((g, i) => { slots[`greeting:${i}`] = g.base; });
  return { slots };
}

// 节点这边的条目设置要装配后才知道（tavern 段会覆盖默认值），由调用方传入装配结果补上
// 正则、脚本等也从装配结果取；拆成文件的记下文件位置，留在 card.md 的记 kept
export function attachNodeSettings(nodeSlots, assembledCard, scan = null) {
  for (const [i, e] of (assembledCard.data?.character_book?.entries ?? []).entries()) {
    const s = nodeSlots.slots[`entry:${e.id}`];
    if (s) {
      s.settings = settingsOfBook(e);
      s.builtEntry = e;
      s.displayIndex = i;
    }
  }
  const ex = scan?.extras ?? { regex: [], scripts: [], vars: null, xbtasks: null };
  const fileOf = new Map([...ex.regex, ...ex.scripts].map(f => [f.key, f]));
  if (ex.vars) fileOf.set('vars', { ...ex.vars, base: null });
  if (ex.xbtasks) fileOf.set('xbtasks', { ...ex.xbtasks, base: null });
  for (const [key, slot] of Object.entries(extraSlots(assembledCard))) {
    const f = fileOf.get(key);
    nodeSlots.slots[key] = f ? { ...slot, relPath: f.files[0], files: f.files, base: f.base } : { ...slot, relPath: 'card.md', kept: true };
  }
  return nodeSlots;
}

export function readCardPng(pngPath) {
  let v2 = null, v3 = null;
  for (const c of parseChunks(Buffer.isBuffer(pngPath) ? pngPath : fs.readFileSync(pngPath))) {
    if (c.type !== 'tEXt') continue;
    const nul = c.data.indexOf(0);
    const kw = c.data.toString('latin1', 0, nul);
    if (kw !== 'chara' && kw !== 'ccv3') continue;
    const json = JSON.parse(Buffer.from(c.data.toString('latin1', nul + 1), 'base64').toString('utf8'));
    if (kw === 'ccv3') v3 = json; else v2 = json;
  }
  const card = v3 ?? v2;
  if (!card) throw new Error(`这个 PNG 里没有角色卡数据：${pngPath}`);
  return card;
}

export function readSlotsFromCard(card, { worldRaw = null } = {}) {
  const d = card.data ?? card, slots = {};
  for (const f of FIELDS) slots[`field:${f}`] = { value: norm(d[f]), label: f };
  (d.alternate_greetings ?? []).forEach((g, i) => { slots[`greeting:${i}`] = { value: norm(g), label: `备选开场白 ${i + 1}` }; });
  if (worldRaw !== null) {
    for (const e of Object.values(JSON.parse(worldRaw).entries ?? {})) slots[`entry:${e.uid}`] = { value: norm(e.content), label: e.comment || `条目 ${e.uid}`, settings: settingsOfWorld(e) };
  } else {
    for (const e of d.character_book?.entries ?? []) slots[`entry:${e.id}`] = { value: norm(e.content), label: e.comment || `条目 ${e.id}`, settings: settingsOfBook(e) };
  }
  Object.assign(slots, extraSlots(card));
  return { slots };
}

export function tryWorldFilePath(name, userDir = tavernUserDir()) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  for (const cand of [name, trimmed]) {
    try {
      const p = contained(path.join(userDir, 'worlds'), `${segment(cand, '世界书名')}.json`);
      if (fs.existsSync(p)) return { worldName: trimmed, filePath: p, exists: true };
    } catch { /* ignore invalid segment */ }
  }
  try {
    const p = contained(path.join(userDir, 'worlds'), `${segment(trimmed, '世界书名')}.json`);
    return { worldName: trimmed, filePath: p, exists: false };
  } catch {
    return null;
  }
}

export function readSlotsFromTavern(cardFile, { userDir = tavernUserDir(), requireWorld = false } = {}) {
  if (cardFile.startsWith('world:')) return readSlotsFromWorldBook(cardFile.slice(6), { userDir });
  segment(cardFile, '卡文件名');
  const png = fs.readFileSync(contained(path.join(userDir, 'characters'), cardFile));
  const card = readCardPng(png);
  const d = card.data ?? card;
  const rawWorldName = typeof d.extensions?.world === 'string' ? d.extensions.world : '';
  const trimmedWorldName = rawWorldName.trim();
  if (typeof d.extensions?.world === 'string' && d.extensions.world !== trimmedWorldName) {
    d.extensions.world = trimmedWorldName;
  }
  const resolved = trimmedWorldName ? tryWorldFilePath(rawWorldName, userDir) : null;
  const worldName = resolved ? resolved.worldName : (trimmedWorldName || '');
  const wf = resolved?.filePath ?? null;
  if (requireWorld && trimmedWorldName && (!wf || !fs.existsSync(wf))) throw new Error(`绑定世界书不存在：${trimmedWorldName}`);
  let source, worldRaw = null;
  if (wf && fs.existsSync(wf)) {
    worldRaw = fs.readFileSync(wf, 'utf8');
    source = `卡「${cardFile}」+ 卡绑定的世界书「${worldName}」`;
  } else {
    source = worldName ? `卡「${cardFile}」+ 内嵌世界书（绑定的「${worldName}」不存在）` : `卡「${cardFile}」+ 内嵌世界书（没有绑定世界书）`;
  }
  return { ...readSlotsFromCard(card, { worldRaw }), source, worldName, card, png, worldRaw };
}

// 独立世界书（不属于任何卡）：只有条目槽位。卡标识写成 world:<世界书名>，同步记录也用它
export const worldFilePath = (name, userDir = tavernUserDir()) => contained(path.join(userDir, 'worlds'), `${segment(typeof name === 'string' ? name.trim() : name, '世界书名')}.json`);
export function readSlotsFromWorldBook(worldName, { userDir = tavernUserDir() } = {}) {
  const wf = worldFilePath(worldName, userDir);
  if (!fs.existsSync(wf)) throw new Error(`酒馆里没有这本世界书：${wf}`);
  const worldRaw = fs.readFileSync(wf, 'utf8');
  const w = JSON.parse(worldRaw);
  const slots = {};
  for (const e of Object.values(w.entries ?? {})) slots[`entry:${e.uid}`] = { value: norm(e.content), label: e.comment || `条目 ${e.uid}`, settings: settingsOfWorld(e) };
  return { slots, source: `独立世界书「${worldName}」`, worldName, worldRaw };
}

// 同步记录：每个槽位上次两边一致时的内容指纹
const stateFile = projDir => contained(projDir, '.card-forge/tavern-sync.json');
export function loadSyncState(projDir, cardFile) {
  const s = readJson(stateFile(projDir));
  return s?.cardFile === cardFile ? s : null;
}
// pending：放进「待归位」的槽位 → { file: 待归位文件相对路径, tavern: 当时酒馆内容指纹 }
// settings：世界书条目上次两边一致时的设置指纹 { node, tavern }，用于判断是哪一边改了触发词/开关/顺序/深度等设置
export function saveSyncState(projDir, cardFile, slots, pending = {}, settings = undefined) {
  atomicJson(stateFile(projDir), {
    cardFile,
    savedAt: new Date().toISOString(),
    slots,
    pending,
    ...(settings ? { settings } : {}),
  });
}

// 待归位的处理状态。作者删掉待归位文件，就算已经处理完：
//   resolved：文件已删、酒馆那条之后没再改过 → pull 不再重新生成，push 以节点为准
//   open：文件还在 → 还没处理
// 文件删了但酒馆那条之后又改了，两边都不算，按新的改动重新判断。
export function pendingStatus(projDir, state, tavernSlots) {
  const resolved = new Set(), open = new Set();
  for (const [k, p] of Object.entries(state?.pending ?? {})) {
    if (fs.existsSync(contained(projDir, String(p.file).replaceAll('\\', '/')))) { open.add(k); continue; }
    const t = tavernSlots[k];
    const now = t ? slotHash(t.value) : null;
    if (now === p.tavern) resolved.add(k);
  }
  return { resolved, open };
}
