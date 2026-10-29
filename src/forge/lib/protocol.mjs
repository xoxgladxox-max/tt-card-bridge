// protocol.mjs — 节点协议校验（P 组规则）
// 只校验协议与工程配置；成文质量归 card-lint（Agent 语境审查）。
import YAML from 'yaml';
import { isKnownType, KNOWN_TYPE_LIST, parsePosition, defaultTarget, bookNodesOf, assignOrders, orderGroupOf } from './nodes.mjs';

// 节点状态：协议沿用的四态（docs/spec/node-protocol.md 第 4 节）
export const STATUS_ORDER = ['调研中', '草稿', '已确认', '已落盘'];

// 单槽字段：只允许一个节点指向
const SINGLE_TARGETS = new Set([
  'description', 'personality', 'scenario', 'first_mes',
  'mes_example', 'system_prompt', 'post_history_instructions',
]);

export function validateNodes(scan) {
  const errors = [];
  const warnings = [];
  const push = (list, node, rule, message) =>
    list.push({ node: node ? node.relPath : '(项目)', rule, message });

  // 每个节点自身的解析问题
  for (const n of scan.nodes) {
    for (const p of n.problems) push(errors, n, p.rule, p.message);
  }

  // P3 缺 id / P4 id 重复 / P5 type 未知
  const byId = new Map();
  for (const n of scan.nodes) {
    if (!n.id) push(errors, n, 'P3', '缺少 id（稳定身份）；请人工补 id 后重跑');
    else if (byId.has(n.id)) push(errors, n, 'P4', `id "${n.id}" 与 ${byId.get(n.id).relPath} 重复`);
    else byId.set(n.id, n);
    if (!n.type) push(errors, n, 'P5', '缺少 type');
    else if (!isKnownType(n.type)) push(errors, n, 'P5', `未知 type "${n.type}"：可用类型为 ${KNOWN_TYPE_LIST}。按内容选一个，并把包裹标签、order 一并适配`);
  }

  // P6 单槽 target 冲突
  const targetMap = new Map();
  for (const n of scan.nodes) {
    const t = n.target;
    if (!t || !SINGLE_TARGETS.has(t)) continue;
    if (targetMap.has(t)) push(errors, n, 'P6', `target "${t}" 是单槽字段，${targetMap.get(t).relPath} 已占用`);
    else targetMap.set(t, n);
  }

  // P7 正文为空（card/note 类型豁免）
  for (const n of scan.nodes) {
    if (n.type === 'card' || n.type === 'note') continue;
    if (n.problems.some(p => p.rule === 'P1' || p.rule === 'P2')) continue; // 已报过
    if (!n.body.trim()) push(warnings, n, 'P7', '正文为空');
  }

  // P8 世界书条目永不触发
  for (const n of scan.nodes) {
    if (n.target === 'character_book' && !n.constant && n.keys.length === 0 && n.body.trim()) {
      push(warnings, n, 'P8', 'target=character_book 但 keys 为空且非 constant：永不触发（若有意软禁用请忽略）');
    }
  }

  // P9 编号保留不用（@D 位置由 P12 检查）

  // P12 position 写了但不合法 → error（不退回默认值）
  for (const n of scan.nodes) {
    const raw = n.frontmatter.position;
    if (raw === undefined || raw === null) continue;
    if (!parsePosition(raw)) {
      push(errors, n, 'P12', `position 值 ${JSON.stringify(raw)} 不合法：只接受 before_char、after_char、@D<n>（n 为不小于 0 的整数，如 @D2）`);
    }
  }

  // P13 order 写了但不是数字 → error（没写的由 build 按组和节点树自动编号）
  for (const n of scan.nodes) {
    const raw = n.frontmatter.order;
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      push(errors, n, 'P13', `order 值 ${JSON.stringify(raw)} 不是数字。一个节点只出一个条目；头尾两段（三明治）请拆成两个节点，各写一个数字 order`);
    }
  }

  // P14 单字关键词 → 警告（几乎每轮误触发）；/…/ 正则写法不查
  for (const n of scan.nodes) {
    const single = [...n.keys, ...n.secondary].filter(k => {
      const s = String(k).trim();
      return !s.startsWith('/') && Array.from(s).length === 1;
    });
    if (single.length) {
      push(warnings, n, 'P14', `关键词 ${single.map(k => `「${k}」`).join('')} 只有一个字，几乎每轮都会误触发；换成词，或写成带上下文的正则`);
    }
  }

  // P15 导出去处定不下来 → error（原先要到 build 装配时才抛异常）
  const TARGET_HINT = {
    character: '角色节点要显式写 target: character_book；description 留给本卡元提示词',
    corpus: '要显式写 target：description 或 character_book',
    output: '要显式写 target：description、system_prompt，或 character_book 配 @D 低深度',
    greeting: '要显式写 target：first_mes 或 alternate_greetings',
  };
  for (const n of scan.nodes) {
    if (!isKnownType(n.type) || n.type === 'card' || n.type === 'note') continue;
    if (defaultTarget(n, scan) === null) {
      push(errors, n, 'P15', `导出去处定不下来：${TARGET_HINT[n.type] ?? '要显式写 target'}`);
    }
  }

  // P16 本工作流不用 mes_example；旧工程仍可 build，只警告
  for (const n of scan.nodes) {
    if (n.target === 'mes_example') {
      push(warnings, n, 'P16', 'target=mes_example：本工作流不用酒馆示例对话，台词语料改进 description 或 character_book');
    }
  }

  // P17 酒馆旧字段不写；旧工程仍可 build，只警告
  for (const n of scan.nodes) {
    if (n.target === 'post_history_instructions') {
      push(warnings, n, 'P17', 'target=post_history_instructions：本工作流不写历史指令，输出规范改进 description、system_prompt 或低深度条目');
    }
    if (n.type === 'card') {
      const cn = n.frontmatter.creator_notes;
      if (typeof cn === 'string' && cn.trim()) push(warnings, n, 'P17', 'creator_notes 有内容：本工作流不写作者注释，留空');
      const tags = n.frontmatter.tags;
      if (Array.isArray(tags) && tags.length) push(warnings, n, 'P17', 'tags 有内容：本工作流不写酒馆标签，留空');
    }
  }

  // P18 单独成条的世界书条目：要有带名字的顶层包裹、包裹内 YAML 能解析、写 title（只警告）
  // P18a–e 标签规范（见 docs/spec/node-protocol.md「标签与标题」）
  const book = bookNodesOf(scan);
  const seenTitle = new Map(), seenName = new Map();
  for (const n of book) {
    if (!isKnownType(n.type) || !n.body.trim()) continue;
    const { problems, blocks } = entryShape(n);
    for (const p of problems) push(warnings, n, p.rule, p.message);
    // P18d 标题全卡不重复；同一标签下 name（+part）不重复
    const title = String(n.frontmatter.title ?? n.stem);
    if (seenTitle.has(title)) push(warnings, n, 'P18d', `标题「${title}」与 ${seenTitle.get(title).relPath} 重复：酒馆列表里分不出哪条是哪条`);
    else seenTitle.set(title, n);
    for (const b of blocks) {
      if (!b.attrs.name) continue;
      const k = `${b.tag}|${b.attrs.name}|${b.attrs.part ?? ''}`;
      if (seenName.has(k)) push(warnings, n, 'P18d', `${b.first.slice(0, 40)} 与 ${seenName.get(k).relPath} 重复：同时加载时模型分不清`);
      else seenName.set(k, n);
    }
  }

  // P19 三明治（可选）护栏：wrap: head / tail 的节点免查首尾成对，改查拼得起来的条件（world-info.js 装配与预算行为）
  const { orders, width } = assignOrders(book);
  const wraps = book.filter(n => n.frontmatter.wrap !== undefined);
  // 三明治按所在文件夹成组：world_book/组/开头.md 与 world_book/组/ 下其他条目是一组
  const dirOf = n => n.dir.split(/[\\/]/).join('/');
  const parentOf = dirOf;
  const posKey = n => { const p = parsePosition(n.position); return p ? `${p.kind}:${p.depth ?? ''}` : String(n.position); };
  for (const w of wraps) {
    const kind = w.frontmatter.wrap;
    if (kind !== 'head' && kind !== 'tail') { push(warnings, w, 'P19', `wrap 只能写 head 或 tail，现为 ${JSON.stringify(kind)}`); continue; }
    const par = parentOf(w);
    const inGroup = book.filter(x => x !== w && x.frontmatter.wrap === undefined && (dirOf(x) === par || dirOf(x).startsWith(par + '/')));
    const mate = wraps.find(x => x !== w && parentOf(x) === par && x.frontmatter.wrap === (kind === 'head' ? 'tail' : 'head'));
    if (!mate) push(warnings, w, 'P19', `三明治${kind === 'head' ? '开头' : '收尾'}在同一父目录下没有配对的${kind === 'head' ? '收尾' : '开头'}`);
    if (!w.constant) push(warnings, w, 'P19', '三明治首尾要设 constant: true：靠关键词触发时，中间条目靠递归激活就会没有框');
    if (w.frontmatter.ignore_budget !== true) push(warnings, w, 'P19', '三明治首尾要设 ignore_budget: true：超预算时酒馆先丢 order 小的，开头会先被截掉，首尾配不上');
    const off = inGroup.filter(x => posKey(x) !== posKey(w));
    if (off.length) push(warnings, w, 'P19', `与组内 ${off.map(x => x.relPath).join('、')} 的 position 不同：不在同一位置、同一深度的条目拼不到一起`);
    const o = orders.get(w);
    const bad = inGroup.filter(x => kind === 'head' ? orders.get(x) <= o : orders.get(x) >= o);
    if (bad.length) push(warnings, w, 'P19', `${kind === 'head' ? '开头' : '收尾'} order ${o} 没有${kind === 'head' ? '小' : '大'}于组内所有条目（${bad.map(x => `${x.relPath}=${orders.get(x)}`).join('、')}）`);
  }

  // P20 排序；手写 order 才可能触发
  const GROUP_NAME = { 1: '世界', 2: '人物', 3: '文风', 4: '输出', 5: '开场白及其他' };
  const byOrder = new Map();
  for (const n of book) {
    const o = orders.get(n), g = orderGroupOf(n);
    if (byOrder.has(o)) push(warnings, n, 'P20', `order ${o} 与 ${byOrder.get(o).relPath} 重复：同一位置里谁先谁后就不确定了`);
    else byOrder.set(o, n);
    if (Math.floor(o / width) !== g) push(warnings, n, 'P20', `order ${o} 不在${GROUP_NAME[g]}组（type: ${n.type} → 应为 ${g * width + 1} 起连续编号）：先按内容确认 type 对不对（迁移、拆卡时 type 可能是按目录机械填的）；type 不对就改 type，type 对再改 order 或删掉手写的 order 自动编号`);
  }
  for (const g of [...new Set(book.map(orderGroupOf))]) {
    const nums = book.filter(n => orderGroupOf(n) === g).map(n => orders.get(n)).filter(o => Math.floor(o / width) === g).sort((a, b) => a - b);
    const gap = nums.findIndex((o, i) => o !== g * width + 1 + i);
    if (nums.length && gap !== -1) push(warnings, null, 'P20', `${GROUP_NAME[g]}组 order 不连续（${nums.join('、')}）：应从 ${g * width + 1} 起逐一递增；删掉手写的 order 即可自动编号`);
  }

  // P11 状态值须在协议四态内（没写状态行不报；旧卡不强制迁移，所以只警告）
  for (const n of scan.nodes) {
    if (n.nodeStatus && !STATUS_ORDER.includes(n.nodeStatus)) {
      push(warnings, n, 'P11', `状态「${n.nodeStatus}」不在协议四态内（${STATUS_ORDER.join(' → ')}）`);
    }
  }

  // P22 触发词撞车：一个词挂在多条上，一喊全响
  {
    const keyUse = new Map();
    for (const n of bookNodesOf(scan)) {
      if (n.frontmatter?.constant === true) continue;
      for (const k of n.keys ?? []) {
        const key = String(k).trim();
        if (!key || (key.startsWith('/') && key.endsWith('/'))) continue;
        const kl = key.toLowerCase();
        if (!keyUse.has(kl)) keyUse.set(kl, []);
        keyUse.get(kl).push(n.relPath);
      }
    }
    for (const [k, ns] of keyUse) {
      if (ns.length > 1) push(warnings, null, 'P22', `触发词「${k}」同时挂在 ${ns.join('、')} 上：一喊全响；常用词改成更具体的专名`);
    }
  }

  // P23 世界书条目 tavern.id（uid）不能重复（重复时酒馆 convertCharacterBook 会后者覆盖前者）
  {
    const seenUid = new Map();
    for (const n of book) {
      const uid = n.frontmatter?.tavern?.id;
      if (uid === undefined || uid === null || uid === '') continue;
      const key = String(uid);
      if (seenUid.has(key)) {
        push(errors, n, 'P23', `tavern.id（世界书 uid）${JSON.stringify(uid)} 与 ${seenUid.get(key).relPath} 重复：酒馆导入时会互相覆盖`);
      } else {
        seenUid.set(key, n);
      }
    }
  }

  // P24 UTF-8 乱码替换符 U+FFFD 检查
  for (const n of scan.nodes) {
    const fmStr = JSON.stringify(n.frontmatter ?? {});
    if ((n.body && n.body.includes('\uFFFD')) || fmStr.includes('\uFFFD')) {
      push(errors, n, 'P24', '包含乱码替换符 U+FFFD，文件编码可能损坏');
    }
  }

  // P21 编号保留不用：world_book/ 下可以建子文件夹分组，装配不看目录，不再报嵌套

  // P10 卡根数量与旧版节点树拦截（缺失 card.md 或仍为未迁移的旧版节点树时必须报 error 阻断构建）
  const cards = scan.nodes.filter(n => n.type === 'card');
  const contentNodes = scan.nodes.filter(n => n.type !== 'card' && n.type !== 'note');
  const legacyHintText = scan.legacyHints?.length
    ? `；检测到旧版节点树结构（${scan.legacyHints.join('、')}），请先运行 node src/cli.mjs migrate <旧卡目录> --out <新标准卡目录> 迁移为标准卡工程格式`
    : '';
  if (cards.length === 0) {
    push(errors, null, 'P10', `没有 card 类型节点（缺少 card.md）${legacyHintText}`);
  } else if (contentNodes.length === 0 && scan.legacyHints?.length) {
    push(errors, null, 'P10', `检测到未迁移的旧版节点树结构（${scan.legacyHints.join('、')}）且无标准内容节点，请先运行 node src/cli.mjs migrate <旧卡目录> --out <新标准卡目录> 迁移为标准卡工程格式`);
  }
  if (cards.length > 1) push(errors, null, 'P10', `card 类型节点有 ${cards.length} 个，只允许一个 card.md`);

  return { errors, warnings };
}

// 节点类型 → 包裹标签（封闭清单，docs/spec/node-protocol.md「补充 · 标签与标题」）；greeting 不加包裹
export const TAG_OF_TYPE = {
  world: 'world', location: 'location', lore: 'lore', rule: 'rule', item: 'item',
  character: 'character', module: 'character', corpus: 'character',
  style: 'style', output: 'output', plot: 'plot', wiki: 'lore', event: 'event',
};
const NEEDS_PART = new Set(['module', 'corpus']);

function parseAttrs(openLine) {
  const attrs = {};
  for (const m of openLine.matchAll(/\s([A-Za-z_][\w-]*)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

// 世界书条目的形状检查：正文由一个或多个配对的顶层标签块组成（配角群这类多块并列也算）；
// 块内若是 YAML 则真解析一遍；是否写了 title；title 不写路径；标签名、name / part 与 title 的关系（P18a–e）
// wrap: head / tail 的三明治首尾只查标题，拼接条件由 P19 查
export function entryShape(n) {
  const problems = [];
  const add = (rule, message) => problems.push({ rule, message });
  const lines = n.body.trim().split(/\r?\n/);
  const blocks = [];
  const wrapped = n.frontmatter.wrap !== undefined;
  let cur = null, bad = null;
  if (!wrapped) for (const line of lines) {
    const t = line.trim();
    if (!cur) {
      if (!t) continue;
      const open = t.match(/^<([^\s<>\/]+)(\s[^<>]*)?>$/);
      if (!open) { bad = t; break; }
      cur = { tag: open[1], first: t, attrs: parseAttrs(t), inner: [] };
    } else if (t === `</${cur.tag}>`) {
      blocks.push(cur); cur = null;
    } else cur.inner.push(line);
  }
  if (!wrapped && (bad !== null || cur || blocks.length === 0)) {
    const first = lines[0].trim(), last = lines[lines.length - 1].trim();
    add('P18', `正文首行「${first.slice(0, 40)}」与尾行「${last.slice(0, 40)}」不是配对的顶层标签；单独成条的内容要有带名字的包裹，开头标签和结尾标签要写成一对，模型才知道这段属于谁`);
    blocks.length = 0;
  }
  const want = TAG_OF_TYPE[n.type];
  for (const b of blocks) {
    const head = b.inner.find(l => l.trim());
    if (head && /^[A-Za-z_][\w-]*:(\s|$)/.test(head)) {
      try { YAML.parse(b.inner.join('\n')); }
      catch (err) { add('P18', `包裹 ${b.first.slice(0, 40)} 内的 YAML 解析失败：${String(err.message).split('\n')[0]}（检查首行是否顶格、缩进是否一致）`); }
    } else if (head && /^\s+[A-Za-z_][\w-]*:(\s|$)/.test(head)) {
      add('P18e', `包裹 ${b.first.slice(0, 40)} 内 YAML 第一层没有顶格：第一层 key 从第 1 列写起，层级才不会错`);
    }
    if (want && b.tag !== want) add('P18a', `${n.type} 节点的包裹标签应为 <${want}>，现为 <${b.tag}>：标签名按节点类型取固定的英文小写词，名字写进 name`);
    if (n.type !== 'output' && n.type !== 'greeting' && !b.attrs.name) add('P18b', `包裹 ${b.first.slice(0, 40)} 没有 name：同类条目同时加载时靠 name 分清是谁、是哪儿`);
    if (NEEDS_PART.has(n.type) && !b.attrs.part) add('P18b', `${n.type} 节点的包裹 ${b.first.slice(0, 40)} 没有 part：写明这段是那个人的哪一部分`);
  }
  const title = n.frontmatter.title;
  if (title === undefined || title === null || !String(title).trim()) {
    add('P18', '没写 title：条目标题会用目录名，酒馆列表里看到的是文件夹名');
  } else {
    const t = String(title);
    if (/[\\/]/.test(t)) add('P18', `title「${t}」里有路径分隔符：标题写给人看的名字，不写路径`);
    // P18c 编号保留不用：标题用最短的自然叫法，
    // 不要求包含 name / part 全称；唯一性由 P18d 查，分不清由 cf-card-review C15 读正文判
  }
  return { problems, blocks };
}

// 旧接口：只返回文字
export function entryShapeProblems(n) {
  return entryShape(n).problems.map(p => p.message);
}

export function formatReport({ errors, warnings }) {
  const lines = [];
  for (const e of errors) lines.push(`  [X] ${e.node} [${e.rule}] ${e.message}`);
  for (const w of warnings) lines.push(`  [!] ${w.node} [${w.rule}] ${w.message}`);
  return lines.join('\n');
}