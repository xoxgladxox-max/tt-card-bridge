// extras.mjs — 卡里的正则、酒馆助手脚本、角色变量、小白X任务（方案 A，作者认可：“按你的来做吧”）
//   regex/<序号>-<名>.json          一条正则的设置；.html 同名文件是 replaceString（替换成的内容）
//   scripts/<序号>-<名>.json        一个酒馆助手脚本的设置；.js 同名文件是脚本代码 content
//   scripts/variables.json          角色变量 tavern_helper.variables
//   scripts/xiaobaix-tasks.json     小白X 任务 extensions['xiaobaix-tasks']
//   variables/                      小白X 变量 3.0 规则包 extensions['lwb-state3']，目录与小白X 离线工具 state3 unpack 相同：
//     definition.json、functions/<名>.js、tools/<名>.js、scripts/<prepare|calculate|committed>.js
// 序号是原卡里的位置（从 1 起）。拆的时候没勾、留在 card.md 里的项，装配时按原顺序补进空出来的序号，
// 所以只拆一部分也不会打乱执行顺序。每楼的 stat_data、小白X 变量值属于聊天记录，不在卡里，也不导出。
import fs from 'node:fs/promises';
import path from 'node:path';

export const VARS_FILE = 'scripts/variables.json';
export const XB_FILE = 'scripts/xiaobaix-tasks.json';
export const XB_TPL_JSON = 'scripts/xiaobaix-template.json';
export const XB_TPL_HTML = 'scripts/xiaobaix-template.html';
export const XB_VARS_FILE = 'scripts/xiaobaix-variables.json';
export const EXTRA_DIRS = ['regex', 'scripts', 'variables'];
// 小白X 变量 3.0：卡里存的是规则包的 JSON 字符串。目录映射沿用小白X 的对外格式契约（LittleWhiteBox docs/user/variables-v3-external.md）
export const STATE3_EXTENSION = 'lwb-state3';
export const STATE3_DIR = 'variables';
const STATE3_DEFINITION = `${STATE3_DIR}/definition.json`;
const STATE3_SOURCES = { functions: `${STATE3_DIR}/functions`, tools: `${STATE3_DIR}/tools`, scripts: `${STATE3_DIR}/scripts` };
const STATE3_PHASES = new Set(['prepare', 'calculate', 'committed']);
const STATE3_NAME = /^[a-zA-Z0-9_-]+$/;
const KIND_DIR = { regex: 'regex', script: 'scripts' };
const SIDE = { regex: { key: 'replaceString', ext: '.html' }, script: { key: 'content', ext: '.js' } };

export const isExtraKey = key => /^(regex|script):/.test(key) || key === 'vars' || key === 'xbtasks' || key === 'xbtemplate' || key === 'xbvars' || key === 'state3';
export const extraKind = key => key.startsWith('regex:') ? 'regex' : key.startsWith('script:') ? 'script' : key;
// 同步槽位名：有 id 用 id，没有时用名字
export const itemKey = (kind, v) => kind === 'regex' ? `regex:${v?.id ?? v?.scriptName ?? ''}`
  : kind === 'script' ? `script:${v?.id ?? v?.name ?? ''}` : kind;
export const itemLabel = (kind, v, i = 0) => kind === 'regex' ? String(v?.scriptName || `正则 ${i + 1}`)
  : kind === 'script' ? String(v?.name || `脚本 ${i + 1}`)
  : kind === 'vars' ? '角色变量'
  : kind === 'xbtemplate' ? '小白X 模板'
  : kind === 'xbvars' ? '小白X 变量'
  : kind === 'state3' ? '小白X 变量 3.0 规则'
  : '小白X 任务';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isThTuple = v => Array.isArray(v) && v.every(it => Array.isArray(it) && typeof it[0] === 'string');
const varsPresent = v => isObj(v) && Object.keys(v).length > 0;
const xbPresent = v => isObj(v) && (Array.isArray(v.tasks) ? v.tasks.length > 0 : Object.keys(v).length > 0);
const xbTemplatePresent = v => isObj(v) && (v.enabled === true || Boolean(v.template) || Boolean(v.htmlTemplate));
const lwbPresent = v => isObj(v) && Object.keys(v).length > 0;
// 规则包按小白X 的形状检查：definition 是对象，functions/tools/scripts 是 { 名称: 源码 }。
// 形状不认识的不拆，原样留在 card.md，由小白X 自己报错，不在这里改写
function state3Bundle(stored) {
  if (typeof stored !== 'string' || !stored) return null;
  let bundle;
  try { bundle = JSON.parse(stored); } catch { return null; }
  const sources = v => isObj(v) && Object.entries(v).every(([name, source]) => STATE3_NAME.test(name) && typeof source === 'string');
  if (!isObj(bundle) || !isObj(bundle.definition) || !sources(bundle.functions)) return null;
  if (Object.keys(bundle).some(k => !['definition', 'functions', 'tools', 'scripts'].includes(k))) return null;
  if (bundle.tools !== undefined && !sources(bundle.tools)) return null;
  if (bundle.scripts !== undefined && (!sources(bundle.scripts) || Object.keys(bundle.scripts).some(k => !STATE3_PHASES.has(k)))) return null;
  return bundle;
}
// 写回卡里时整串替换（酒馆按对象合并写卡，存成字符串才能删掉已删除的函数）
const encodeState3 = bundle => JSON.stringify(bundle);

// 统一读取酒馆助手的 3 种存储形态：
// 1) object: extensions.tavern_helper = { scripts: [...], variables: {...} }
// 2) tuple:  extensions.tavern_helper = [ ["scripts", [...]], ["variables", {...}] ]
// 3) legacy: extensions.TavernHelper_scripts = [...]（当 tavern_helper 不存在时）
function readThView(x) {
  if (isObj(x?.tavern_helper)) {
    return { mode: 'object', scripts: Array.isArray(x.tavern_helper.scripts) ? x.tavern_helper.scripts : null, variables: x.tavern_helper.variables };
  }
  if (isThTuple(x?.tavern_helper)) {
    const map = new Map(x.tavern_helper.map(([k, v]) => [k, v]));
    return { mode: 'tuple', scripts: Array.isArray(map.get('scripts')) ? map.get('scripts') : null, variables: map.get('variables') };
  }
  if (Array.isArray(x?.TavernHelper_scripts)) {
    return { mode: 'legacy', scripts: x.TavernHelper_scripts, variables: null };
  }
  return { mode: 'none', scripts: null, variables: null };
}

function nextUniqueKey(base, seen) {
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}#${count}`;
}

// 卡里有哪些可以拆的项。空的角色变量、空的小白X任务不算（留在 card.md）
export function listExtras(card) {
  const x = (card?.data ?? card)?.extensions ?? {};
  const items = [];
  const seen = new Map();
  (Array.isArray(x.regex_scripts) ? x.regex_scripts : []).forEach((v, i) => {
    const key = nextUniqueKey(itemKey('regex', v), seen);
    items.push({ key, kind: 'regex', index: i, label: itemLabel('regex', v, i), disabled: v?.disabled === true, value: v });
  });
  const th = readThView(x);
  (th.scripts ?? []).forEach((v, i) => {
    const key = nextUniqueKey(itemKey('script', v), seen);
    items.push({ key, kind: 'script', index: i, label: itemLabel('script', v, i), disabled: v?.enabled === false, value: v });
  });
  if (varsPresent(th.variables)) items.push({ key: 'vars', kind: 'vars', index: 0, label: '角色变量', disabled: false, value: th.variables });
  if (xbPresent(x['xiaobaix-tasks'])) items.push({ key: 'xbtasks', kind: 'xbtasks', index: 0, label: '小白X 任务', disabled: false, value: x['xiaobaix-tasks'] });
  if (xbTemplatePresent(x['xiaobaix-template'])) items.push({ key: 'xbtemplate', kind: 'xbtemplate', index: 0, label: '小白X 模板', disabled: x['xiaobaix-template']?.enabled === false, value: x['xiaobaix-template'] });
  if (lwbPresent(x.LittleWhiteBox)) items.push({ key: 'xbvars', kind: 'xbvars', index: 0, label: '小白X 变量', disabled: false, value: x.LittleWhiteBox });
  const state3 = state3Bundle(x[STATE3_EXTENSION]);
  if (state3) items.push({ key: 'state3', kind: 'state3', index: 0, label: itemLabel('state3'), disabled: false, value: state3 });
  return items;
}
// 默认全拆（前端卡的手机版状态栏、离线版美化等常以 disabled: true 存放在卡内供切换，若留在 card.md 会把数百 KB 的 HTML 塞进 YAML）
export const defaultKeep = () => [];

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
  const seen = new Map();
  const filterList = (list, kind) => {
    const left = list.filter(v => keep.has(nextUniqueKey(itemKey(kind, v), seen)));
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
  } else if (isThTuple(x.tavern_helper)) {
    // 保留 tuple 数组骨架（如 [["scripts", []], ["variables", {}]]），以便 applyExtras 装回时还原成相同的 tuple 数组形态
    x.tavern_helper = x.tavern_helper.map(([k, v]) => {
      if (k === 'scripts' && Array.isArray(v)) return [k, filterList(v, 'script').left];
      if (k === 'variables' && varsPresent(v) && !keep.has('vars')) return [k, {}];
      return [k, v];
    });
  } else if (Array.isArray(x.TavernHelper_scripts)) {
    // 保留旧版 TavernHelper_scripts 空数组骨架，以便 applyExtras 装回时还原到 TavernHelper_scripts
    x.TavernHelper_scripts = filterList(x.TavernHelper_scripts, 'script').left;
  }
  if (xbPresent(x['xiaobaix-tasks']) && !keep.has('xbtasks')) delete x['xiaobaix-tasks'];
  if (xbTemplatePresent(x['xiaobaix-template']) && !keep.has('xbtemplate')) delete x['xiaobaix-template'];
  if (lwbPresent(x.LittleWhiteBox) && !keep.has('xbvars')) delete x.LittleWhiteBox;
  if (state3Bundle(x[STATE3_EXTENSION]) && !keep.has('state3')) delete x[STATE3_EXTENSION];
  return x;
}

const safeName = s => String(s || '未命名').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 50) || '未命名';
export const extraBase = (kind, n, label, width = 2) => `${KIND_DIR[kind]}/${String(n).padStart(width, '0')}-${safeName(label)}`;

// 一项 → { 相对路径: 文件内容 }。base 是不带扩展名的路径（正则、脚本才用）
// 纯剔除型正则（replaceString === ""，如「对AI隐藏变量更新」）只在 .json 保留 replaceString: ""，不生成 0 字节的空 .html 文件
export function extraFiles(kind, value, base) {
  const json = v => JSON.stringify(v, null, 2) + '\n';
  if (kind === 'vars') return { [VARS_FILE]: json(value) };
  if (kind === 'xbtasks') return { [XB_FILE]: json(value) };
  if (kind === 'xbvars') return { [XB_VARS_FILE]: json(value) };
  if (kind === 'state3') {
    const files = { [STATE3_DEFINITION]: json(value.definition) };
    for (const [collection, dir] of Object.entries(STATE3_SOURCES)) {
      for (const [name, source] of Object.entries(value[collection] ?? {})) files[`${dir}/${name}.js`] = source;
    }
    return files;
  }
  if (kind === 'xbtemplate') {
    const htmlKey = isObj(value) && typeof value.template === 'string' ? 'template'
      : (isObj(value) && typeof value.htmlTemplate === 'string' ? 'htmlTemplate' : null);
    if (htmlKey && value[htmlKey].length > 0) {
      const { [htmlKey]: html, ...rest } = value;
      return { [XB_TPL_JSON]: json(rest), [XB_TPL_HTML]: html };
    }
    return { [XB_TPL_JSON]: json(value) };
  }
  const side = SIDE[kind];
  if (isObj(value) && typeof value[side.key] === 'string' && (kind !== 'regex' || value[side.key].length > 0)) {
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

const SINGLETON_FILES = new Set([VARS_FILE, XB_FILE, XB_TPL_JSON, XB_TPL_HTML, XB_VARS_FILE]);

// 读工程里的拆分文件
export async function readExtras(root) {
  const out = { regex: [], scripts: [], vars: null, xbtasks: null, xbtemplate: null, xbvars: null, state3: null };
  for (const kind of ['regex', 'script']) {
    const dir = KIND_DIR[kind], side = SIDE[kind];
    let names;
    try { names = await fs.readdir(path.join(root, dir)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const groups = new Map();
    for (const name of names.sort()) {
      const rel = `${dir}/${name}`;
      if (SINGLETON_FILES.has(rel) || name.startsWith('.')) continue;
      const ext = path.extname(name);
      if (ext !== '.json' && ext !== side.ext) continue;
      const base = rel.slice(0, -ext.length);
      const g = groups.get(base) ?? {};
      g[ext] = rel; groups.set(base, g);
    }
    const seen = new Map();
    for (const [base, g] of groups) {
      if (!g['.json']) throw new Error(`${g[side.ext]}：缺少同名的 .json 设置文件`);
      const value = await readJsonFile(root, g['.json']);
      if (g[side.ext] && isObj(value)) value[side.key] = noBom(await fs.readFile(path.join(root, g[side.ext]), 'utf8'));
      const m = path.posix.basename(base).match(/^(\d+)-/);
      const key = nextUniqueKey(itemKey(kind, value), seen);
      out[kind === 'regex' ? 'regex' : 'scripts'].push({ kind, n: m ? Number(m[1]) : Infinity, base, files: [g['.json'], g[side.ext]].filter(Boolean), value, key });
    }
  }
  if (await exists(path.join(root, VARS_FILE))) out.vars = { files: [VARS_FILE], value: await readJsonFile(root, VARS_FILE) };
  if (await exists(path.join(root, XB_FILE))) out.xbtasks = { files: [XB_FILE], value: await readJsonFile(root, XB_FILE) };
  const hasTplJson = await exists(path.join(root, XB_TPL_JSON));
  const hasTplHtml = await exists(path.join(root, XB_TPL_HTML));
  if (hasTplJson || hasTplHtml) {
    const settings = hasTplJson ? await readJsonFile(root, XB_TPL_JSON) : { enabled: true };
    if (hasTplHtml && isObj(settings)) settings.template = noBom(await fs.readFile(path.join(root, XB_TPL_HTML), 'utf8'));
    out.xbtemplate = { files: [hasTplJson ? XB_TPL_JSON : null, hasTplHtml ? XB_TPL_HTML : null].filter(Boolean), value: settings };
  }
  if (await exists(path.join(root, XB_VARS_FILE))) out.xbvars = { files: [XB_VARS_FILE], value: await readJsonFile(root, XB_VARS_FILE) };
  out.state3 = await readState3(root);
  return out;
}

// variables/ 读回规则包。和小白X 离线工具一样：出现不认识的文件就报错，不悄悄丢掉
async function readState3(root) {
  let names;
  try { names = await fs.readdir(path.join(root, STATE3_DIR)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const known = new Set(['definition.json', ...Object.values(STATE3_SOURCES).map(d => path.posix.basename(d))]);
  for (const name of names) if (!name.startsWith('.') && !known.has(name)) throw new Error(`${STATE3_DIR}/${name}：小白X 变量 3.0 目录只放 definition.json、functions/、tools/、scripts/`);
  if (!(await exists(path.join(root, STATE3_DEFINITION)))) {
    // 同步删掉规则后只剩空目录，算没有规则；有源码却没有定义文件才报错
    const leftover = [];
    for (const dir of Object.values(STATE3_SOURCES)) {
      try { leftover.push(...(await fs.readdir(path.join(root, dir))).filter(n => !n.startsWith('.'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (!leftover.length) return null;
    throw new Error(`${STATE3_DEFINITION}：缺少小白X 变量 3.0 规则定义`);
  }
  const definition = await readJsonFile(root, STATE3_DEFINITION);
  if (!isObj(definition)) throw new Error(`${STATE3_DEFINITION}：规则定义要是 JSON 对象`);
  const bundle = { definition, functions: {} }, files = [STATE3_DEFINITION];
  for (const [collection, dir] of Object.entries(STATE3_SOURCES)) {
    let entries;
    try { entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const sources = {};
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const rel = `${dir}/${entry.name}`, name = entry.name.replace(/\.js$/, '');
      const ok = entry.isFile() && entry.name.endsWith('.js') && STATE3_NAME.test(name) && (collection !== 'scripts' || STATE3_PHASES.has(name));
      if (!ok) throw new Error(`${rel}：文件名不符合小白X 变量 3.0 的目录约定`);
      sources[name] = noBom(await fs.readFile(path.join(root, rel), 'utf8'));
      files.push(rel);
    }
    if (collection === 'functions') bundle.functions = sources;
    else if (Object.keys(sources).length) bundle[collection] = sources;
  }
  return { files, value: bundle };
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
  const has = extras.regex.length || extras.scripts.length || extras.vars || extras.xbtasks || extras.xbtemplate || extras.xbvars || extras.state3;
  if (!has) return data;
  const x = data.extensions = { ...(data.extensions ?? {}) };
  if (extras.regex.length) x.regex_scripts = mergeOrdered(extras.regex, Array.isArray(x.regex_scripts) ? x.regex_scripts : []);
  if (extras.scripts.length || extras.vars) {
    if (isThTuple(x.tavern_helper)) {
      const tuple = x.tavern_helper.map(([k, v]) => [k, v]);
      const idxS = tuple.findIndex(([k]) => k === 'scripts');
      if (extras.scripts.length) {
        const keptS = idxS >= 0 && Array.isArray(tuple[idxS][1]) ? tuple[idxS][1] : [];
        const merged = mergeOrdered(extras.scripts, keptS);
        if (idxS >= 0) tuple[idxS] = ['scripts', merged]; else tuple.push(['scripts', merged]);
      }
      if (extras.vars) {
        const idxV = tuple.findIndex(([k]) => k === 'variables');
        if (idxV >= 0) tuple[idxV] = ['variables', extras.vars.value]; else tuple.push(['variables', extras.vars.value]);
      }
      x.tavern_helper = tuple;
    } else if (x.tavern_helper === undefined && Array.isArray(x.TavernHelper_scripts) && !extras.vars) {
      x.TavernHelper_scripts = mergeOrdered(extras.scripts, x.TavernHelper_scripts);
    } else {
      const th = x.tavern_helper = { ...(isObj(x.tavern_helper) ? x.tavern_helper : {}) };
      if (extras.scripts.length) th.scripts = mergeOrdered(extras.scripts, Array.isArray(th.scripts) ? th.scripts : []);
      if (extras.vars) th.variables = extras.vars.value;
    }
  }
  if (extras.xbtasks) x['xiaobaix-tasks'] = extras.xbtasks.value;
  if (extras.xbtemplate) x['xiaobaix-template'] = extras.xbtemplate.value;
  if (extras.xbvars) x.LittleWhiteBox = extras.xbvars.value;
  if (extras.state3) x[STATE3_EXTENSION] = encodeState3(extras.state3.value);
  return data;
}

// 同步写回：改 card.md 里留着的一项（value 为 null 表示酒馆里删掉了）
export function setKeptItem(ext, key, value) {
  const x = isObj(ext) ? structuredClone(ext) : {};
  const kind = extraKind(key);
  if (kind === 'xbtasks') { x['xiaobaix-tasks'] = value ?? { tasks: [] }; return x; }
  if (kind === 'xbtemplate') { x['xiaobaix-template'] = value ?? { enabled: false, template: '' }; return x; }
  if (kind === 'xbvars') { x.LittleWhiteBox = value ?? {}; return x; }
  if (kind === 'state3') { if (value === null) delete x[STATE3_EXTENSION]; else x[STATE3_EXTENSION] = encodeState3(value); return x; }
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
  const th = readThView(x);
  const scripts = JSON.stringify(th.scripts ?? []);
  const book = JSON.stringify(d.character_book?.entries ?? []) + '\n' + extraText;
  const all = [scripts, book, JSON.stringify(x.regex_scripts ?? []), d.first_mes, ...(d.alternate_greetings ?? []), d.description, d.post_history_instructions].join('\n');
  const out = [];
  if (/MagVarUpdate/i.test(scripts) || /\[InitVar\]|stat_data/.test(book)) {
    const ver = /MagVarUpdate@beta/i.test(scripts) ? 'beta' : /MagVarUpdate/i.test(scripts) ? 'master' : '未见加载脚本';
    out.push({ id: 'mvu', label: `MVU（${ver}）`, hint: '只需要装酒馆助手；MVU 本体由卡里的脚本从 jsdelivr 加载' });
  }
  if (/<state>|xbgetvar|<varevent>|<<taskjs>>/i.test(all) || xbPresent(x['xiaobaix-tasks']) || xbTemplatePresent(x['xiaobaix-template']) || lwbPresent(x.LittleWhiteBox)) {
    // state2：正文 <state> 或读取宏要靠小白X「变量管理 · 2.0 (state)」解析，面板据此对照酒馆实际设置
    const state2 = /<state>|xbgetvar/i.test(all);
    out.push({ id: 'xiaobaix', label: '小白X', hint: state2 ? '需要小白X 3.0 以上，并在小白X 设置里把变量模式切到 2.0 (state)' : '需要小白X 3.0 以上', state2 });
  }
  // 变量 3.0：规则包在 extensions['lwb-state3']，小白X 只在变量模式选 3.0 时运行它
  if (x[STATE3_EXTENSION] !== undefined) out.push({ id: 'xiaobaix_state3', label: '小白X 变量 3.0', hint: '需要小白X，并在「数据互动 → 变量控制」里选 3.0', state3: true });
  if (!out.length && (th.scripts ?? []).length) out.push({ id: 'tavern_helper', label: '仅酒馆助手', hint: '需要装酒馆助手' });
  if (!out.length) out.push({ id: 'none', label: '没有变量框架', hint: '' });
  return out;
}
