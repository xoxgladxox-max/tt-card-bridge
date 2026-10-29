// unpack.mjs — 把酒馆里的卡（PNG / JSON）拆成节点工程（以节点工程为准，旧卡先拆成节点）
// 做法：先按字段写节点 → 在内存里装配一次 → 和原卡逐项比对 → 装配不出来的设置原样记进 frontmatter 的 tavern 段 → 再装配一次确认一致。
// 正文（条目内容、描述、开场白等）只放在 <!-- body --> 之后，不进 tavern 段；正文对不上时报告，不另存一份。
// 不改原卡；输出目录必须不存在或为空。
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { extractChara } from '../lib/png.mjs';
import { scanCard, BODY_MARK } from '../lib/nodes.mjs';
import { assemble, entryFromNode } from './build.mjs';
import { fnv1a } from '../lib/fingerprint.mjs';
import { listExtras, defaultKeep, keptExtensions, extraFiles, extraBase } from '../lib/extras.mjs';

// 单槽文字字段 → 文件、类型。布局：字段直接放卡文件夹根目录，开场白放 message/
const FIELD_NODES = {
  description: { file: 'description.md', type: 'character' },
  personality: { file: 'personality.md', type: 'character' },
  scenario: { file: 'scenario.md', type: 'world' },
  mes_example: { file: 'mes_example.md', type: 'corpus' },
  system_prompt: { file: 'system_prompt.md', type: 'output' },
  post_history_instructions: { file: 'post_history_instructions.md', type: 'output' },
  first_mes: { file: 'message/0.md', type: 'greeting' },
};
// 由节点正文决定、不允许进 tavern 段的字段
const BODY_FIELDS = new Set([...Object.keys(FIELD_NODES), 'alternate_greetings', 'character_book']);
const POS_NAME = { 0: 'before_char', 1: 'after_char' };

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function readCardFile(buf) {
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
  if (isPng) {
    const found = extractChara(buf);
    if (!found) throw new Error('PNG 中未找到 chara/ccv3 负载');
    return found.card;
  }
  return JSON.parse(buf.toString('utf8'));
}

// 酒馆世界书文件（worlds/*.json）：顶层有 entries 对象，没有 data/spec
export function isWorldFile(obj) {
  return !!obj && typeof obj === 'object' && !obj.data && !obj.spec && obj.entries && typeof obj.entries === 'object' && !Array.isArray(obj.entries);
}

// 世界书文件 → 只有世界书的卡。条目转换与 SillyTavern 1.17 服务器 convertWorldInfoToCharacterBook 一致
// （src/endpoints/characters.js 第 663 行起，导出卡时把绑定世界书写进卡用的就是它）。
// 卡的 extensions.world 记世界书名，推送时按它写回同名世界书。
export function worldFileToCard(w, name) {
  const entries = [];
  for (const e of Object.values(w.entries)) {
    entries.push({
      id: e.uid, keys: e.key, secondary_keys: e.keysecondary, comment: e.comment, content: e.content,
      constant: e.constant, selective: e.selective, insertion_order: e.order, enabled: !e.disable,
      position: e.position == 0 ? 'before_char' : 'after_char', use_regex: true,
      extensions: {
        ...e.extensions,
        position: e.position, exclude_recursion: e.excludeRecursion, display_index: e.displayIndex,
        probability: e.probability ?? null, useProbability: e.useProbability ?? false, depth: e.depth ?? 4,
        selectiveLogic: e.selectiveLogic ?? 0, outlet_name: e.outletName ?? '', group: e.group ?? '',
        group_override: e.groupOverride ?? false, group_weight: e.groupWeight ?? null,
        prevent_recursion: e.preventRecursion ?? false, delay_until_recursion: e.delayUntilRecursion ?? false,
        scan_depth: e.scanDepth ?? null, match_whole_words: e.matchWholeWords ?? null,
        use_group_scoring: e.useGroupScoring ?? false, case_sensitive: e.caseSensitive ?? null,
        automation_id: e.automationId ?? '', role: e.role ?? 0, vectorized: e.vectorized ?? false,
        sticky: e.sticky ?? null, cooldown: e.cooldown ?? null, delay: e.delay ?? null,
        match_persona_description: e.matchPersonaDescription ?? false,
        match_character_description: e.matchCharacterDescription ?? false,
        match_character_personality: e.matchCharacterPersonality ?? false,
        match_character_depth_prompt: e.matchCharacterDepthPrompt ?? false,
        match_scenario: e.matchScenario ?? false, match_creator_notes: e.matchCreatorNotes ?? false,
        triggers: e.triggers ?? [], ignore_budget: e.ignoreBudget ?? false,
      },
    });
  }
  return { spec: 'chara_card_v2', spec_version: '2.0', data: { name, extensions: { world: name }, character_book: { name, entries } } };
}

// 世界书文件里有、转成卡内嵌格式时会丢的字段（角色过滤等）。推送时酒馆扩展会保留旧文件里的这些字段
const WORLD_ONLY_KEYS = ['characterFilter', 'characterFilterNames', 'characterFilterTags', 'characterFilterExclude'];
function worldOnlyFields(w) {
  const hit = new Map();
  for (const e of Object.values(w.entries)) for (const k of WORLD_ONLY_KEYS) {
    const v = e[k];
    const empty = v == null || v === false || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.values(v).some(x => Array.isArray(x) ? x.length : x));
    if (!empty) hit.set(k, (hit.get(k) ?? 0) + 1);
  }
  return [...hit].map(([k, n]) => `${k}（${n} 条）`);
}

// 拆出来的正文要能原样装回：解析器会去掉首尾空白、把 CRLF 换成 LF
function bodyRoundTrips(text) {
  return !text.includes('\r') && text === text.trim() && !text.includes(BODY_MARK);
}

export function safeDirName(s, used = new Set()) {
  let base = String(s || '未命名').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 60) || '未命名';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}`;
  used.add(name.toLowerCase());
  return name;
}

export function nodeText(fm, body, source) {
  const head = YAML.stringify(fm, { lineWidth: 0 }).trimEnd();
  return `---\n${head}\n---\n\n## 工序\n- 来源：${source}\n- 状态：草稿\n\n${BODY_MARK}\n${body}\n`;
}

// 条目 → frontmatter（只写节点协议已有的字段；其余差异第二遍补进 tavern）
export function entryFrontmatter(e, nodeId) {
  const ext = e.extensions ?? {};
  const fm = { id: nodeId, type: 'lore', target: 'character_book', title: String(e.comment ?? '') };
  if (e.keys?.length) fm.keys = e.keys.map(String);
  if (e.secondary_keys?.length) fm.secondary = e.secondary_keys.map(String);
  fm.position = ext.position === 4 ? `@D${ext.depth ?? 4}` : (POS_NAME[ext.position] ?? (e.position === 'after_char' ? 'after_char' : 'before_char'));
  if (typeof e.insertion_order === 'number') fm.order = e.insertion_order;
  if (e.constant === true) fm.constant = true;
  if (ext.exclude_recursion === false) fm.recursion = true;
  if (ext.ignore_budget === true) fm.ignore_budget = true;
  return fm;
}

// 原条目与装配结果的差异 → tavern 覆盖段（正文、标题以外）
export function entryOverride(orig, built) {
  const ov = {};
  const lost = [];
  for (const k of new Set([...Object.keys(orig), ...Object.keys(built)])) {
    if (k === 'extensions' || k === 'content') continue;
    if (!(k in orig)) { lost.push(k); continue; }
    if (!same(orig[k], built[k])) ov[k] = orig[k];
  }
  const oe = orig.extensions ?? {}, be = built.extensions ?? {};
  const ext = {};
  for (const k of new Set([...Object.keys(oe), ...Object.keys(be)])) {
    if (!(k in oe)) { lost.push(`extensions.${k}`); continue; }
    if (!same(oe[k], be[k])) ext[k] = oe[k];
  }
  if (Object.keys(ext).length) ov.extensions = ext;
  return { ov, lost };
}

// 单条酒馆世界书条目 → 完整 frontmatter（含 tavern 覆盖段），供实时同步在酒馆新建或修改条目设置时写回 .md
export function buildEntryFrontmatter(e, nodeId, { existingType = 'lore', displayIndex = -1 } = {}) {
  const fm = entryFrontmatter(e, nodeId);
  fm.type = existingType || 'lore';
  const syn = {
    id: nodeId,
    stem: fm.title || nodeId,
    frontmatter: fm,
    keys: fm.keys ?? [],
    secondary: fm.secondary ?? [],
    position: fm.position ?? 'before_char',
    order: fm.order,
    constant: fm.constant === true,
    recursion: fm.recursion === true,
    body: String(e.content ?? ''),
  };
  const b = entryFromNode(syn, displayIndex, fm.order ?? e.insertion_order ?? 100);
  const { ov } = entryOverride(e, b);
  if (Object.keys(ov).length) fm.tavern = ov;
  return fm;
}

// 比对用：条目按 id 排序（数组顺序不影响酒馆运行），键名排序
export function normalizeCard(card) {
  const d = structuredClone(card.data ?? card);
  if (d.character_book?.entries) d.character_book.entries.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  const norm = o => Array.isArray(o) ? o.map(norm)
    : (o && typeof o === 'object') ? Object.fromEntries(Object.keys(o).sort().map(k => [k, norm(o[k])])) : o;
  return norm({ spec: card.spec ?? null, spec_version: card.spec_version ?? null, data: d });
}

// added：原卡没有、装配补上的键（build 写死的酒馆默认值）。单独报告，不算不一致
// ws：只差在正文首尾空白或换行符。节点正文解析时会去掉首尾空白，tt-card pull 比对时也忽略它们；单独报告，不算不一致
const wsNorm = s => s.replaceAll('\r\n', '\n').trim();
function diffPaths(a, b, prefix = '', out = [], added = [], ws = []) {
  if (same(a, b)) return out;
  if (a === undefined && b !== undefined) { added.push(prefix.replace(/\[\d+\]/g, '[]')); return out; }
  if (typeof a === 'string' && typeof b === 'string' && wsNorm(a) === wsNorm(b)) { ws.push(prefix); return out; }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, out, added, ws);
  } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => diffPaths(x, b[i], `${prefix}[${i}]`, out, added, ws));
  } else out.push(prefix || '(根)');
  return out;
}

export async function unpackCmd(file, opts = {}) {
  if (!opts.out) return { ok: false, report: 'unpack 需要 --out <新节点工程目录>' };
  const out = path.resolve(opts.out);
  try {
    if ((await fs.readdir(out)).length) return { ok: false, report: `输出目录不为空，拒绝覆盖：${out}` };
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  let card = readCardFile(await fs.readFile(file));
  const notes = [];
  let bookOnly = null; // 独立世界书时为世界书名
  if (isWorldFile(card)) {
    bookOnly = String(opts.name ?? path.basename(file, path.extname(file)));
    const lost = worldOnlyFields(card);
    if (lost.length) notes.push(`世界书文件独有、节点里不记录的字段：${lost.join('、')}。推送时按酒馆里的旧文件保留`);
    card = worldFileToCard(card, bookOnly);
  }
  if (card.spec && !['chara_card_v2', 'chara_card_v3'].includes(card.spec)) return { ok: false, report: `未支持的 spec "${card.spec}"` };
  const d = card.data ?? card;
  const name = String(d.name ?? path.basename(file, path.extname(file)));
  const source = bookOnly
    ? `酒馆世界书「${path.basename(file)}」（unpack ${new Date().toISOString().slice(0, 10)}）`
    : `酒馆卡「${path.basename(file)}」（unpack ${new Date().toISOString().slice(0, 10)}）`;
  const files = new Map(); // 相对路径 → { fm, body }

  // 卡根
  const cardFm = { id: 'card-root', type: 'card', name };
  if (bookOnly) cardFm.book_only = true; // 独立世界书：只推送世界书，不写卡
  if (d.creator) cardFm.creator = String(d.creator);
  if (d.character_version !== undefined) cardFm.version = String(d.character_version);
  if (Array.isArray(d.tags) && d.tags.length) cardFm.tags = d.tags.map(String);
  if (d.creator_notes) cardFm.creator_notes = String(d.creator_notes);
  files.set('card.md', { fm: cardFm, body: '' });

  // 单槽字段
  for (const [field, spec] of Object.entries(FIELD_NODES)) {
    const text = String(d[field] ?? '');
    if (!text) continue;
    if (!bodyRoundTrips(text)) notes.push(`${field}：正文首尾有空白、含 CR 或含 body 标记，装回时会有差异`);
    files.set(spec.file, { fm: { id: `fld-${field}`, type: spec.type, target: field, title: field === 'first_mes' ? '开场白' : field }, body: text });
  }
  (d.alternate_greetings ?? []).forEach((g, i) => {
    const text = String(g ?? '');
    const num = String(i + 1).padStart(2, '0');
    if (!bodyRoundTrips(text)) notes.push(`备选开场白 ${num}：正文首尾有空白、含 CR 或含 body 标记，装回时会有差异`);
    files.set(`message/${i + 1}.md`, { fm: { id: `greet-alt-${num}`, type: 'greeting', target: 'alternate_greetings', title: `备选${num}`, order: i + 1 }, body: text });
  });

  // 世界书条目：拆的时候分不出类型，先记 lore；一条一个 world_book/<条目名>.md
  const entries = d.character_book?.entries ?? [];
  const used = new Set();
  const entryNode = new Map(); // 原条目 → 相对路径
  for (const [i, e] of entries.entries()) {
    const nodeId = `wb-${e.id ?? i}`;
    const rel = `world_book/${safeDirName(e.comment || nodeId, used)}.md`;
    const text = String(e.content ?? '');
    if (!bodyRoundTrips(text)) notes.push(`条目「${e.comment}」：正文首尾有空白、含 CR 或含 body 标记，装回时会有差异`);
    files.set(rel, { fm: entryFrontmatter(e, nodeId), body: text });
    entryNode.set(nodeId, { rel, orig: e });
  }

  // 正则、酒馆助手脚本、角色变量、小白X任务：opts.keep 里的留在 card.md，其余拆成 regex/、scripts/ 下的文件
  const keep = new Set(Array.isArray(opts.keep) ? opts.keep : defaultKeep(card));
  const extraOut = new Map();
  const extraItems = listExtras(card);
  const width = Math.max(2, String(extraItems.length).length);
  for (const item of extraItems) {
    if (keep.has(item.key)) continue;
    const base = item.kind === 'regex' || item.kind === 'script' ? extraBase(item.kind, item.index + 1, item.label, width) : null;
    for (const [rel, text] of Object.entries(extraFiles(item.kind, item.value, base))) extraOut.set(rel, text);
  }

  const writeAll = async () => {
    for (const [rel, { fm, body }] of files) {
      const abs = path.join(out, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, nodeText(fm, body, source), 'utf8');
    }
    for (const [rel, text] of extraOut) {
      const abs = path.join(out, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, text, 'utf8');
    }
  };

  // 第一遍：写节点、装配，找出装配不出来的设置
  await writeAll();
  const { card: c1 } = assemble(await scanCard(out));
  const lostKeys = new Set();
  // build 的条目 id = fnv1a(节点 id)，按它把装配结果对回原条目
  const byNode = new Map((c1.data.character_book?.entries ?? []).map(e => [e.id, e]));
  for (const [nodeId, { rel, orig }] of entryNode) {
    const b = byNode.get(fnv1a(nodeId));
    if (!b) { notes.push(`条目「${orig.comment}」装配后没找到`); continue; }
    const { ov, lost } = entryOverride(orig, b);
    lost.forEach(k => lostKeys.add(k));
    if (Object.keys(ov).length) files.get(rel).fm.tavern = ov;
  }

  // 卡级：spec、data 里非正文字段、世界书本身的设置
  const cardOv = {};
  if (card.spec && card.spec !== c1.spec) cardOv.spec = card.spec;
  if (card.spec_version && card.spec_version !== c1.spec_version) cardOv.spec_version = card.spec_version;
  const dataOv = {};
  for (const k of Object.keys(d)) {
    if (k === 'character_book' && d.character_book === null && !entries.length) {
      dataOv.character_book = null;
      continue;
    }
    if (BODY_FIELDS.has(k)) continue;
    if (k === 'extensions') {
      // 拆成文件的项不再重复记在 card.md；未知扩展字段（如 depth_prompt）照原样留着
      const kept = keptExtensions(d.extensions, keep);
      if (kept && Object.keys(kept).length) dataOv.extensions = kept;
      continue;
    }
    if (!same(d[k], c1.data[k])) dataOv[k] = d[k];
  }
  for (const k of Object.keys(c1.data)) if (!(k in d)) lostKeys.add(`data.${k}`);
  if (Object.keys(dataOv).length) cardOv.data = dataOv;
  if (d.character_book) {
    const { entries: _e, ...bookRest } = d.character_book;
    const { entries: _b, ...builtBook } = c1.data.character_book ?? {};
    const bookOv = {};
    for (const k of Object.keys(bookRest)) if (!same(bookRest[k], builtBook[k])) bookOv[k] = bookRest[k];
    if (Object.keys(bookOv).length) cardOv.book = bookOv;
  }
  if (Object.keys(cardOv).length) files.get('card.md').fm.tavern = cardOv;

  // 第二遍：带 tavern 段重写，装配，与原卡比对
  await fs.rm(out, { recursive: true, force: true });
  await writeAll();
  const built = assemble(await scanCard(out)).card;
  const added = [], wsOnly = [];
  const diffs = diffPaths(normalizeCard(card), normalizeCard(built), '', [], added, wsOnly);

  const withOv = [...files.values()].filter(f => f.fm.tavern && f.fm.type !== 'card').length;
  const lines = [];
  lines.push(`unpack：${file}${bookOnly ? `（独立世界书「${bookOnly}」，卡根只记世界书名；推送、拉回用 tt-card 的 --book）` : ''}`);
  lines.push(`输出：${out}`);
  lines.push(`节点：${files.size} 个（世界书条目 ${entries.length}、备选开场白 ${(d.alternate_greetings ?? []).length}、单槽字段 ${Object.values(FIELD_NODES).filter(s => files.has(s.file)).length}、卡根 1）`);
  lines.push(`带 tavern 段的条目：${withOv} 个；卡根 tavern 段：${Object.keys(cardOv).join('、') || '无'}`);
  if (extraItems.length) lines.push(`正则/脚本/变量：共 ${extraItems.length} 项，拆成文件 ${extraItems.filter(i => !keep.has(i.key)).length} 项，留在 card.md ${extraItems.filter(i => keep.has(i.key)).length} 项`);
  lines.push('条目类型一律先记为 lore、放在 world_book/，类型待人工调整；order 原样保留，所以改类型不影响顺序。');
  if (added.length) lines.push(`原卡没有、装配时补上酒馆默认值的键：${[...new Set(added)].join('、')}`);
  for (const n of notes) if (!n.includes('正文首尾有空白')) lines.push(`注意：${n}`);
  const wsNotes = notes.filter(n => n.includes('正文首尾有空白'));
  if (wsOnly.length) lines.push(`只差在正文首尾空白或换行的 ${wsOnly.length} 处（节点正文不保留首尾空白，不算不一致）：${wsOnly.slice(0, 8).join('、')}${wsOnly.length > 8 ? '……' : ''}`);
  else for (const n of wsNotes) lines.push(`注意：${n}`);
  if (diffs.length) {
    lines.push(`往返比对：不一致 ${diffs.length} 处`);
    diffs.slice(0, 30).forEach(p => lines.push(`  ${p}`));
  } else lines.push('往返比对：装配结果与原卡 data 一致（条目按 id 比对；补上的默认键和首尾空白差异见上）');
  lines.push(diffs.length ? 'RESULT : FAIL' : 'RESULT : PASS');
  return {
    ok: diffs.length === 0,
    report: lines.join('\n'),
    roundTrip: {
      ok: diffs.length === 0,
      diffCount: diffs.length,
      diffs: diffs.slice(0, 30),
      addedKeys: [...new Set(added)],
      whitespaceOnlyCount: wsOnly.length,
    },
  };
}
