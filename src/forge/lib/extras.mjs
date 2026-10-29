// extras.mjs — 卡里的正则、酒馆助手脚本、角色变量、小白X任务（方案 A，作者认可：“按你的来做吧”）
//   regex/<序号>-<名>.json          一条正则的设置；.html 同名文件是 replaceString（替换成的内容）
//   scripts/<序号>-<名>.json        一个酒馆助手脚本的设置；.js 同名文件是脚本代码 content
//   scripts/variables.json          角色变量 tavern_helper.variables
//   scripts/xiaobaix-tasks.json     小白X 任务 extensions['xiaobaix-tasks']
// 序号是原卡里的位置（从 1 起）。拆的时候没勾、留在 card.md 里的项，装配时按原顺序补进空出来的序号，
// 所以只拆一部分也不会打乱执行顺序。每楼的 stat_data、小白X 变量值属于聊天记录，不在卡里，也不导出。
import fs from 'node:fs/promises';
import path from 'node:path';

export const VARS_FILE = 'scripts/variables.json';
export const XB_FILE = 'scripts/xiaobaix-tasks.json';
export const EXTRA_DIRS = ['regex', 'scripts'];
const KIND_DIR = { regex: 'regex', script: 'scripts' };
const SIDE = { regex: { key: 'replaceString', ext: '.html' }, script: { key: 'content', ext: '.js' } };

export const isExtraKey = key => /^(regex|script):/.test(key) || key === 'vars' || key === 'xbtasks';
export const extraKind = key => key.startsWith('regex:') ? 'regex' : key.startsWith('script:') ? 'script' : key;
// 同步槽位名：有 id 用 id，没有时用名字
export const itemKey = (kind, v) => kind === 'regex' ? `regex:${v?.id ?? v?.scriptName ?? ''}`
  : kind === 'script' ? `script:${v?.id ?? v?.name ?? ''}` : kind;
export const itemLabel = (kind, v, i = 0) => kind === 'regex' ? String(v?.scriptName || `正则 ${i + 1}`)
  : kind === 'script' ? String(v?.name || `脚本 ${i + 1}`) : kind === 'vars' ? '角色变量' : '小白X 任务';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const varsPresent = v => isObj(v) && Object.keys(v).length > 0;
const xbPresent = v => isObj(v) && (Array.isArray(v.tasks) ? v.tasks.length > 0 : Object.keys(v).length > 0);

// 卡里有哪些可以拆的项。空的角色变量、空的小白X任务不算（留在 card.md）
export function listExtras(card) {
  const x = (card?.data ?? card)?.extensions ?? {};
  const items = [];
  (Array.isArray(x.regex_scripts) ? x.regex_scripts : []).forEach((v, i) => items.push({ key: itemKey('regex', v), kind: 'regex', index: i, label: itemLabel('regex', v, i), disabled: v?.disabled === true, value: v }));
  const th = isObj(x.tavern_helper) ? x.tavern_helper : null;
  (Array.isArray(th?.scripts) ? th.scripts : []).forEach((v, i) => items.push({ key: itemKey('script', v), kind: 'script', index: i, label: itemLabel('script', v, i), disabled: v?.enabled === false, value: v }));
  if (varsPresent(th?.variables)) items.push({ key: 'vars', kind: 'vars', index: 0, label: '角色变量', disabled: false, value: th.variables });
  if (xbPresent(x['xiaobaix-tasks'])) items.push({ key: 'xbtasks', kind: 'xbtasks', index: 0, label: '小白X 任务', disabled: false, value: x['xiaobaix-tasks'] });
  return items;
}
// 默认全拆；已停用的正则默认留在卡里
export const defaultKeep = card => listExtras(card).filter(i => i.kind === 'regex' && i.disabled).map(i => i.key);

// 只留下 keep 里的可拆项；其余可拆项不属于卡设置比较，单独按槽位比
export function stripExtras(data, keep = new Set()) {
  const d = { ...data };
  if (isObj(d.extensions)) d.extensions = keptExtensions(d.extensions, keep);
  return d;
}

// 留在 card.md 里的 extensions：去掉拆成文件的项。只有确实拆走了东西才删空键
export function keptExtensions(ext, keep) {
  if (!isObj(ext)) return ext;
  const x = structuredClone(ext);
  const filterList = (list, kind) => {
    const left = list.filter(v => keep.has(itemKey(kind, v)));
    return { left, removed: left.length < list.length };
  };
  if (Array.isArray(x.regex_scripts)) {
    const { left, removed } = filterList(x.regex_scripts, 'regex');
    if (removed && !left.length) delete x.regex_scripts; else x.regex_scripts = left;
  }
  if (isObj(x.tavern_helper)) {
    const th = x.tavern_helper; let removedAny = false;
    if (Array.isArray(th.scripts)) {
      const { left, removed } = filterList(th.scripts, 'script');
      removedAny ||= removed;
      if (removed && !left.length) delete th.scripts; else th.scripts = left;
    }
    if (varsPresent(th.variables) && !keep.has('vars')) { delete th.variables; removedAny = true; }
    if (removedAny && !Object.keys(th).length) delete x.tavern_helper;
  }
  if (xbPresent(x['xiaobaix-tasks']) && !keep.has('xbtasks')) delete x['xiaobaix-tasks'];
  return x;
}

const safeName = s => String(s || '未命名').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 50) || '未命名';
export const extraBase = (kind, n, label, width = 2) => `${KIND_DIR[kind]}/${String(n).padStart(width, '0')}-${safeName(label)}`;

// 一项 → { 相对路径: 文件内容 }。base 是不带扩展名的路径（正则、脚本才用）
export function extraFiles(kind, value, base) {
  const json = v => JSON.stringify(v, null, 2) + '\n';
  if (kind === 'vars') return { [VARS_FILE]: json(value) };
  if (kind === 'xbtasks') return { [XB_FILE]: json(value) };
  const side = SIDE[kind];
  if (isObj(value) && typeof value[side.key] === 'string') {
    const { [side.key]: text, ...rest } = value;
    return { [`${base}.json`]: json(rest), [`${base}${side.ext}`]: text };
  }
  return { [`${base}.json`]: json(value) };
}

const noBom = s => s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
async function readJsonFile(root, rel) {
  const raw = noBom(await fs.readFile(path.join(root, rel), 'utf8'));
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${rel}：JSON 解析失败：${e.message}`); }
}
const exists = async file => { try { await fs.access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

// 读工程里的拆分文件
export async function readExtras(root) {
  const out = { regex: [], scripts: [], vars: null, xbtasks: null };
  for (const kind of ['regex', 'script']) {
    const dir = KIND_DIR[kind], side = SIDE[kind];
    let names;
    try { names = await fs.readdir(path.join(root, dir)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const groups = new Map();
    for (const name of names.sort()) {
      const rel = `${dir}/${name}`;
      if (rel === VARS_FILE || rel === XB_FILE || name.startsWith('.')) continue;
      const ext = path.extname(name);
      if (ext !== '.json' && ext !== side.ext) continue;
      const base = rel.slice(0, -ext.length);
      const g = groups.get(base) ?? {};
      g[ext] = rel; groups.set(base, g);
    }
    for (const [base, g] of groups) {
      if (!g['.json']) throw new Error(`${g[side.ext]}：缺少同名的 .json 设置文件`);
      const value = await readJsonFile(root, g['.json']);
      if (g[side.ext] && isObj(value)) value[side.key] = noBom(await fs.readFile(path.join(root, g[side.ext]), 'utf8'));
      const m = path.posix.basename(base).match(/^(\d+)-/);
      out[kind === 'regex' ? 'regex' : 'scripts'].push({ kind, n: m ? Number(m[1]) : Infinity, base, files: [g['.json'], g[side.ext]].filter(Boolean), value, key: itemKey(kind, value) });
    }
  }
  if (await exists(path.join(root, VARS_FILE))) out.vars = { files: [VARS_FILE], value: await readJsonFile(root, VARS_FILE) };
  if (await exists(path.join(root, XB_FILE))) out.xbtasks = { files: [XB_FILE], value: await readJsonFile(root, XB_FILE) };
  return out;
}

// 文件项按序号放；留在卡里的项按原顺序补进空出来的序号
export function mergeOrdered(fileItems, kept) {
  const taken = new Set(fileItems.map(f => f.n).filter(Number.isFinite));
  const placed = [];
  let next = 1;
  for (const value of kept) {
    while (taken.has(next)) next++;
    placed.push({ n: next, value }); taken.add(next);
  }
  return [...placed, ...fileItems].sort((a, b) => a.n - b.n).map(x => x.value);
}

// 装配：把拆分文件合回卡的 extensions（card.md 里的设置已先盖上）
export function applyExtras(data, extras) {
  if (!extras) return data;
  const has = extras.regex.length || extras.scripts.length || extras.vars || extras.xbtasks;
  if (!has) return data;
  const x = data.extensions = { ...(data.extensions ?? {}) };
  if (extras.regex.length) x.regex_scripts = mergeOrdered(extras.regex, Array.isArray(x.regex_scripts) ? x.regex_scripts : []);
  if (extras.scripts.length || extras.vars) {
    const th = x.tavern_helper = { ...(isObj(x.tavern_helper) ? x.tavern_helper : {}) };
    if (extras.scripts.length) th.scripts = mergeOrdered(extras.scripts, Array.isArray(th.scripts) ? th.scripts : []);
    if (extras.vars) th.variables = extras.vars.value;
  }
  if (extras.xbtasks) x['xiaobaix-tasks'] = extras.xbtasks.value;
  return data;
}

// 同步写回：改 card.md 里留着的一项（value 为 null 表示酒馆里删掉了）
export function setKeptItem(ext, key, value) {
  const x = isObj(ext) ? structuredClone(ext) : {};
  const kind = extraKind(key);
  if (kind === 'xbtasks') { x['xiaobaix-tasks'] = value ?? { tasks: [] }; return x; }
  const th = () => (x.tavern_helper = isObj(x.tavern_helper) ? x.tavern_helper : {});
  if (kind === 'vars') { th().variables = value ?? {}; return x; }
  const list = kind === 'regex' ? (x.regex_scripts = Array.isArray(x.regex_scripts) ? x.regex_scripts : [])
    : (th().scripts = Array.isArray(x.tavern_helper.scripts) ? x.tavern_helper.scripts : []);
  const i = list.findIndex(v => itemKey(kind, v) === key);
  if (value === null) { if (i >= 0) list.splice(i, 1); }
  else if (i >= 0) list[i] = value; else list.push(value);
  return x;
}

// 变量框架识别（可以同时命中多个）。只看卡里的内容，不联网；extraText 是卡绑定的外置世界书原文
export function detectFrameworks(card, extraText = '') {
  const d = card?.data ?? card ?? {}, x = d.extensions ?? {};
  const scripts = JSON.stringify(x.tavern_helper?.scripts ?? []);
  const book = JSON.stringify(d.character_book?.entries ?? []) + '\n' + extraText;
  const all = [scripts, book, JSON.stringify(x.regex_scripts ?? []), d.first_mes, ...(d.alternate_greetings ?? []), d.description, d.post_history_instructions].join('\n');
  const out = [];
  if (/MagVarUpdate/i.test(scripts) || /\[InitVar\]|stat_data/.test(book)) {
    const ver = /MagVarUpdate@beta/i.test(scripts) ? 'beta' : /MagVarUpdate/i.test(scripts) ? 'master' : '未见加载脚本';
    out.push({ id: 'mvu', label: `MVU（${ver}）`, hint: '只需要装酒馆助手；MVU 本体由卡里的脚本从 jsdelivr 加载' });
  }
  if (/<state>|xbgetvar|<varevent>/i.test(all) || xbPresent(x['xiaobaix-tasks'])) {
    out.push({ id: 'xiaobaix', label: '小白X', hint: '需要小白X 3.0 以上，并在小白X 设置里把变量模式切到 2.0 (state)' });
  }
  if (!out.length && (x.tavern_helper?.scripts ?? []).length) out.push({ id: 'tavern_helper', label: '仅酒馆助手', hint: '需要装酒馆助手' });
  if (!out.length) out.push({ id: 'none', label: '没有变量框架', hint: '' });
  return out;
}
