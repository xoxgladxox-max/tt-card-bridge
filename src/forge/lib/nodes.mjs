// nodes.mjs — 扫描节点树、解析 frontmatter、提取正文
// 协议依据：docs/spec/node-protocol.md v0.1（已冻结）
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { readExtras } from './extras.mjs';

export const BODY_MARK = '<!-- body -->';
// handoff/ 放进度记录、冻结版本、候选与会话，与 note/ 一样不是节点目录
// 记录/、候选/、待归位/ 是卡工程里放决策记录、待确认内容和酒馆改动的地方（cf-card-project），不是节点
export const SKIP_DIRS = new Set(['note', 'handoff', '.card-forge', 'dist', 'backups', 'node_modules', '.git', '记录', '候选', '待归位']);
// 旧版节点树（v0.1）常用的顶层分类目录，用于识别未迁移的老卡工程
export const LEGACY_NODE_DIRS = new Set(['world', 'character', 'greeting', 'output', 'style']);

const KNOWN_TYPES = new Set([
  'card', 'world', 'location', 'rule', 'item', 'lore',
  'character', 'module', 'corpus', 'style', 'output', 'greeting', 'note',
  'plot', 'wiki', 'event',
]);

export function isKnownType(t) { return KNOWN_TYPES.has(t); }
export const KNOWN_TYPE_LIST = [...KNOWN_TYPES].join('、');

// position 取值（cf-card-format-export 导出规则）：before_char / after_char / @D<n>（n 为不小于 0 的整数）
// 合法返回 { kind, depth? }，非法返回 null；不认识的值绝不退回默认。
export function parsePosition(value) {
  if (value === 'before_char' || value === 'after_char') return { kind: value };
  if (typeof value === 'string') {
    const m = value.match(/^@D(\d+)$/);
    if (m) return { kind: 'depth', depth: Number(m[1]) };
  }
  return null;
}

// YAML 里 @ 是保留字符，不带引号的 `position: @D2` 会让整段 frontmatter 解析失败。
// 旧节点都是这种写法：解析前只给顶层 position 行里 @ 开头的裸值补引号；带引号的原样不动。
export function quoteBarePosition(fmText) {
  return fmText.replace(/^(position[ \t]*:[ \t]*)(@[^\s'"#]*)([ \t]*(?:#.*)?)$/gm, '$1"$2"$3');
}

// 卡工程布局：一张卡一个文件夹
//   card.md                    卡根
//   <字段>.md                  单槽字段（description.md 等），字段为空就不生成
//   message/<n>.md             0 = first_mes，1 起 = 备选开场白
//   world_book/**/<条目>.md    世界书条目，可以建子文件夹分组
// 其余文件（调研.md、记录/、候选/ 等）不参与装配。
export const LAYOUT = { card: 'card.md', message: 'message', book: 'world_book', regex: 'regex', scripts: 'scripts', cover: 'character.png' };
export const FIELD_FILES = {
  description: 'character', personality: 'character', scenario: 'world',
  mes_example: 'corpus', system_prompt: 'output', post_history_instructions: 'output',
};
const MESSAGE_NAME = /^(\d+)\.md$/;

// 文件位置给出的默认设置；文件开头写了的以开头为准
function implied(rel) {
  const parts = rel.split(/[\\/]/), stem = path.basename(rel, '.md');
  if (parts.length === 1) {
    if (rel === LAYOUT.card) return { id: 'card-root', type: 'card' };
    if (Object.hasOwn(FIELD_FILES, stem)) return { id: `fld-${stem}`, type: FIELD_FILES[stem], target: stem, title: stem };
    return null;
  }
  if (parts[0] === LAYOUT.message && parts.length === 2) {
    const m = parts[1].match(MESSAGE_NAME);
    if (!m) return null;
    const n = Number(m[1]);
    return n === 0
      ? { id: 'fld-first_mes', type: 'greeting', target: 'first_mes', title: '开场白' }
      : { id: `greet-alt-${String(n).padStart(2, '0')}`, type: 'greeting', target: 'alternate_greetings', title: `备选${String(n).padStart(2, '0')}`, order: n };
  }
  // 放在 world_book/ 下就是世界书条目：去处由位置定，类型只管排序分组和标签检查
  if (parts[0] === LAYOUT.book) return { id: `wb-${parts.slice(1).join('/').replace(/\.md$/, '')}`, type: 'lore', target: 'character_book', title: stem };
  return null;
}

async function* walk(root, dir = root) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      const top = rel.split(/[\\/]/)[0];
      if (top === LAYOUT.book || (top === LAYOUT.message && rel === LAYOUT.message)) yield* walk(root, full);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const defaults = implied(rel);
      if (defaults) yield { file: full, rel, defaults };
    }
  }
}

export function parseNodeFile(raw, relPath) {
  // Windows 自带工具（PowerShell 5 的 Set-Content -Encoding UTF8、记事本旧版）写的 UTF-8 文件开头带 BOM，
  // 不去掉的话整个节点会报「缺少 frontmatter」
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const problems = [];
  let frontmatter = {};
  let rest = raw;

  // 没有开头设置的散文件：整个文件就是正文，设置按文件位置给默认值
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch) {
    const body = raw.replaceAll('\r\n', '\n').replace(/^\s+/, '').replace(/\s+$/, '') + '\n';
    return { frontmatter, body, problems, status: null, confirm: null, loose: true };
  } else {
    try {
      frontmatter = YAML.parse(quoteBarePosition(fmMatch[1]), { logLevel: 'silent', uniqueKeys: false }) ?? {};
      if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
        problems.push({ rule: 'P0', message: 'frontmatter 不是键值表' });
        frontmatter = {};
      }
    } catch (err) {
      problems.push({ rule: 'P0', message: `frontmatter YAML 解析失败：${err.message}` });
      frontmatter = {};
    }
    rest = raw.slice(fmMatch[0].length);
  }

  // body 标记：恰好一次
  const markCount = rest.split(BODY_MARK).length - 1;
  let body = '';
  if (markCount === 0) {
    problems.push({ rule: 'P1', message: `缺少正文边界标记 ${BODY_MARK}（旧节点请人工补标记，工具不猜）` });
  } else if (markCount > 1) {
    problems.push({ rule: 'P2', message: `正文边界标记出现 ${markCount} 次，只能有一次` });
  } else {
    body = rest.slice(rest.indexOf(BODY_MARK) + BODY_MARK.length)
    .replaceAll('\r\n', '\n')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '') + '\n';
  }

  // 状态只从工序段（body 标记之前）提取，正文里出现「状态」二字不算
  const head = markCount >= 1 ? rest.slice(0, rest.indexOf(BODY_MARK)) : rest;
  const sm = head.match(/^\s*-\s*状态[：:]\s*(\S+)/m);
  const status = sm ? sm[1] : null;
  // 确认方式：作者确认 / 作者委托（……），同样只从工序段取
  const cm = head.match(/^\s*-\s*确认方式[：:]\s*(.+?)\s*$/m);
  const confirm = cm ? cm[1] : null;

  return { frontmatter, body, problems, status, confirm, loose: false };
}

async function detectLegacyHints(root) {
  const hints = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return hints; }
  for (const e of entries) {
    if (e.isFile() && e.name === 'index.md') hints.push('index.md');
    else if (e.isDirectory() && LEGACY_NODE_DIRS.has(e.name)) {
      try {
        const sub = await fs.readdir(path.join(root, e.name), { withFileTypes: true });
        if (sub.some(s => (s.isFile() && s.name === 'index.md') || s.isDirectory())) hints.push(`${e.name}/`);
      } catch {}
    }
  }
  return hints.sort();
}

export async function scanCard(rootDir) {
  const abs = path.resolve(rootDir);
  const nodes = [];
  for await (const { file, rel: relPath, defaults } of walk(abs)) {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = parseNodeFile(raw, relPath);
    const { body, problems, status, confirm, loose } = parsed;
    const frontmatter = { ...defaults, ...parsed.frontmatter };
    nodes.push({
      relPath,
      loose,
      // 按文件位置给的默认设置；idImplied 表示文件里没写 id，同步时会补上固定 id（改文件名不变条目）
      implied: defaults,
      idImplied: parsed.frontmatter.id === undefined || parsed.frontmatter.id === null || parsed.frontmatter.id === '',
      dir: path.dirname(relPath),
      stem: path.basename(relPath, '.md'),
      id: frontmatter.id ?? null,
      type: frontmatter.type ?? null,
      keys: Array.isArray(frontmatter.keys) ? frontmatter.keys.map(String) : [],
      secondary: Array.isArray(frontmatter.secondary) ? frontmatter.secondary.map(String) : [],
      // 没写 → 默认；写了但非法 → 原值保留，由协议 P12/P13 报 error 并拒绝构建
      position: frontmatter.position ?? 'before_char',
      // 没写 → null，世界书条目由 assignOrders 按组和节点树自动编号；写了是手动覆盖
      order: frontmatter.order ?? null,
      constant: frontmatter.constant === true,
      target: frontmatter.target ?? null,
      recursion: frontmatter.recursion === true,
      nodeStatus: status,
      nodeConfirm: confirm,
      frontmatter,
      body,
      problems,
    });
  }
  nodes.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-CN'));
  const legacyHints = await detectLegacyHints(abs);
  // regex/、scripts/ 里拆出来的正则、脚本、变量、小白X任务（不是节点，装配时合回 extensions）
  return { rootDir: abs, nodes, legacyHints, extras: await readExtras(abs) };
}

// 导出去处（原在 build.mjs；protocol 的 P15 也要用，移到这里避免循环引用）
const BOOK_TYPES = new Set(['world', 'location', 'rule', 'item', 'lore', 'module', 'style', 'plot', 'wiki', 'event']);

export function defaultTarget(n, scan) {
  if (n.target) return n.target;
  if (BOOK_TYPES.has(n.type)) return 'character_book';
  if (n.type === 'character') {
    const chars = scan.nodes.filter(x => x.type === 'character' && !x.target);
    const descTaken = scan.nodes.some(x => x.target === 'description');
    if (chars.length === 1 && !descTaken) return 'description';
    return null; // 多角色或冲突时必须显式 target
  }
  return null;
}

// 进世界书的节点（build 与协议检查共用同一口径）
export function bookNodesOf(scan) {
  return scan.nodes.filter(n => n.type !== 'card' && n.type !== 'note' && defaultTarget(n, scan) === 'character_book');
}

// 世界书排序：按组连续编号、不重复，同类内容排在一起
// 组号：世界 1、人物 2、文风 3、输出 4、开场白及其他 5。组内按节点树先父后子；三明治开头在同级最前、收尾在最后。
// plot（剧情）、wiki（设定百科）、event（事件）归「其他」5 组
export const ORDER_GROUP = {
  world: 1, location: 1, rule: 1, item: 1, lore: 1,
  character: 2, module: 2, corpus: 2,
  style: 3, output: 4, greeting: 5, plot: 5, wiki: 5, event: 5,
};
export const orderGroupOf = n => ORDER_GROUP[n.type] ?? 5;

// 节点在树里的位置：文件路径去掉 .md。world_book/人物.md 是 world_book/人物/ 下各条的父节点
const segs = n => n.relPath.replace(/\.md$/, '').split(/[\\/]/);

export function compareTree(a, b, wrapByDir = new Map()) {
  const sa = segs(a), sb = segs(b);
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    if (sa[i] === sb[i]) continue;
    const rank = s => {
      const w = wrapByDir.get(s.slice(0, i + 1).join('/'));
      return w === 'head' ? -1 : w === 'tail' ? 1 : 0;
    };
    return rank(sa) - rank(sb) || sa[i].localeCompare(sb[i], 'zh-CN');
  }
  return sa.length - sb.length; // 父节点在子节点前
}

// 一组超过 99 条时全卡改用四位编号（1001、2001……）
export function orderWidth(bookNodes) {
  const count = {};
  for (const n of bookNodes) count[orderGroupOf(n)] = (count[orderGroupOf(n)] ?? 0) + 1;
  return Object.values(count).some(c => c > 99) ? 1000 : 100;
}

// 返回按最终顺序排好的条目与每条的 order；手写的数字 order 原样保留，自动编号跳过已被手写占用的号
export function assignOrders(bookNodes) {
  const wrapByDir = new Map(bookNodes.filter(n => n.frontmatter.wrap).map(n => [segs(n).join('/'), n.frontmatter.wrap]));
  const tree = [...bookNodes].sort((a, b) => orderGroupOf(a) - orderGroupOf(b) || compareTree(a, b, wrapByDir));
  const width = orderWidth(bookNodes);
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const used = new Set(bookNodes.filter(n => isNum(n.order)).map(n => n.order));
  const next = {};
  const orders = new Map();
  for (const n of tree) {
    if (isNum(n.order)) { orders.set(n, n.order); continue; }
    const g = orderGroupOf(n);
    let k = next[g] ?? g * width + 1;
    while (used.has(k)) k++;
    orders.set(n, k); used.add(k); next[g] = k + 1;
  }
  const rank = new Map(tree.map((n, i) => [n, i]));
  const sorted = [...tree].sort((a, b) => orders.get(a) - orders.get(b) || rank.get(a) - rank.get(b));
  return { sorted, orders, width };
}