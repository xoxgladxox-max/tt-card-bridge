// build.mjs — 从已确认主源装配 Character Card V2 JSON / PNG
// 不生成新设定；协议有 error 时拒绝构建；构建失败不覆盖旧成品。
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { scanCard, parsePosition, defaultTarget, assignOrders, bookNodesOf, quoteBarePosition } from '../lib/nodes.mjs';
import { validateNodes, formatReport } from '../lib/protocol.mjs';
import { sha256Hex, fnv1a } from '../lib/fingerprint.mjs';
import { embedChara } from '../lib/png.mjs';
import { applyExtras } from '../lib/extras.mjs';

const POSITION_NUM = { before_char: 0, after_char: 1 };

export { defaultTarget }; // 实现移到 lib/nodes.mjs，这里保留原导出

// @D<n>：extensions.position=4（按深度）+ depth=n，顶层 position 照参考成品写 before_char
function positionFields(n) {
  const pos = parsePosition(n.position);
  if (!pos) throw new Error(`${n.relPath}：position ${JSON.stringify(n.position)} 不合法（应先被协议 P12 拦下）`);
  if (pos.kind === 'depth') return { top: 'before_char', ext: 4, depth: pos.depth };
  return { top: pos.kind, ext: POSITION_NUM[pos.kind], depth: 4 };
}

export function entryFromNode(n, displayIndex, order) {
  const pos = positionFields(n);
  return {
    id: fnv1a(n.id),
    keys: n.keys,
    secondary_keys: n.secondary,
    comment: String(n.frontmatter?.title ?? n.stem).slice(0, 100),
    content: n.body.replace(/\n$/, ''),
    constant: n.constant,
    selective: n.secondary.length > 0,
    insertion_order: order,
    enabled: true,
    position: pos.top,
    use_regex: true,
    extensions: {
      position: pos.ext,
      exclude_recursion: !n.recursion,
      display_index: displayIndex,
      probability: 100,
      useProbability: true,
      depth: pos.depth,
      selectiveLogic: 0,
      outlet_name: '',
      group: '',
      group_override: false,
      group_weight: 100,
      prevent_recursion: !n.recursion,
      delay_until_recursion: false,
      scan_depth: null,
      match_whole_words: null,
      use_group_scoring: false,
      case_sensitive: null,
      automation_id: '',
      role: 0,
      vectorized: false,
      sticky: 0,
      cooldown: 0,
      delay: 0,
      match_persona_description: false,
      match_character_description: false,
      match_character_personality: false,
      match_character_depth_prompt: false,
      match_scenario: false,
      match_creator_notes: false,
      triggers: [],
      // 三明治首尾要设预算豁免：酒馆超预算时先丢 order 小的，开头会先被截掉（world-info.js 预算检查）
      ignore_budget: n.frontmatter.ignore_budget === true,
    },
  };
}

// tavern 段：从酒馆旧卡拆出来、节点协议没有对应字段的设置（如 scan_depth、probability、enabled），原样盖在装配结果上。
// 只盖设置，不盖正文：content 与单槽文字字段始终以 <!-- body --> 为准。
const BODY_ONLY = new Set(['content', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'alternate_greetings', 'character_book']);
const BOOK_BODY_ONLY = new Set(['entries']);
function applyOverride(obj, ov, skipKeys = BODY_ONLY) {
  if (!ov || typeof ov !== 'object') return obj;
  for (const [k, v] of Object.entries(ov)) {
    if (skipKeys.has(k)) continue;
    if (k === 'extensions' && v && typeof v === 'object' && !Array.isArray(v)) obj.extensions = { ...(obj.extensions ?? {}), ...v };
    else obj[k] = v;
  }
  return obj;
}

export function entryWithOverride(n, displayIndex, order) {
  return applyOverride(entryFromNode(n, displayIndex, order), n.frontmatter.tavern);
}

export function assemble(scan, opts = {}) {
  const card = scan.nodes.find(n => n.type === 'card');
  const name = opts.name ?? card?.frontmatter?.name ?? path.basename(scan.rootDir);

  const single = {};
  const greetings = [];
  const bookNodes = [];
  for (const n of scan.nodes) {
    if (n.type === 'card' || n.type === 'note') continue;
    const t = defaultTarget(n, scan);
    if (t === 'character_book') { bookNodes.push(n); continue; }
    if (t === 'alternate_greetings') { greetings.push(n); continue; }
    if (t && ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions'].includes(t)) {
      single[t] = n.body.replace(/\n$/, '');
      continue;
    }
    if (!t) throw new Error(`${n.relPath}：无法确定导出归属（多角色或 corpus 请显式写 target）`);
  }
  greetings.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const { sorted: bookSorted, orders } = assignOrders(bookNodes);

  const data = {
    name,
    description: single.description ?? '',
    personality: single.personality ?? '',
    scenario: single.scenario ?? '',
    first_mes: single.first_mes ?? '',
    mes_example: single.mes_example ?? '',
    creator_notes: card?.frontmatter?.creator_notes ?? '',
    system_prompt: single.system_prompt ?? '',
    post_history_instructions: single.post_history_instructions ?? '',
    alternate_greetings: greetings.map(g => g.body.replace(/\n$/, '')),
    tags: Array.isArray(card?.frontmatter?.tags) ? card.frontmatter.tags.map(String) : [],
    creator: card?.frontmatter?.creator ?? '',
    character_version: String(card?.frontmatter?.version ?? '1.0'),
    extensions: {},
  };
  // 支持 card.md 写在 frontmatter 顶层或 <!-- body --> YAML 里的扩展与世界书名（world / world_book_name / extensions.world / tavern.data.extensions.world）
  let bodyMeta = null;
  const rawBody = card?.body?.trim() ?? '';
  if (rawBody && /^(world|world_book_name|extensions|tavern|character_version)\s*:/m.test(rawBody)) {
    try {
      const parsed = YAML.parse(rawBody, { logLevel: 'silent', uniqueKeys: false });
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bodyMeta = parsed;
    } catch { /* body 不是 YAML 时忽略 */ }
  }
  const cfm = { ...(bodyMeta ?? {}), ...(card?.frontmatter ?? {}) };
  if (cfm.character_version !== undefined && card?.frontmatter?.version === undefined) data.character_version = String(cfm.character_version);
  if (cfm.extensions && typeof cfm.extensions === 'object' && !Array.isArray(cfm.extensions)) {
    data.extensions = { ...data.extensions, ...structuredClone(cfm.extensions) };
  }
  const explicitWorld = cfm.tavern?.data?.extensions?.world ?? cfm.extensions?.world ?? cfm.world ?? cfm.world_book_name ?? cfm.tavern?.book?.name;
  const bookName = (typeof explicitWorld === 'string' && explicitWorld.trim()) ? explicitWorld.trim() : name;
  if (bookNodes.length) {
    data.character_book = {
      name: bookName,
      entries: bookSorted.map((n, i) => entryWithOverride(n, i, orders.get(n))),
    };
    applyOverride(data.character_book, card?.frontmatter?.tavern?.book, BOOK_BODY_ONLY);
  } else if (card?.frontmatter?.tavern?.data && Object.hasOwn(card.frontmatter.tavern.data, 'character_book') && card.frontmatter.tavern.data.character_book === null) {
    data.character_book = null;
  }
  applyOverride(data, card?.frontmatter?.tavern?.data);
  if (explicitWorld !== undefined) {
    data.extensions.world = typeof explicitWorld === 'string' ? explicitWorld.trim() : '';
  }
  // regex/、scripts/ 里的拆分文件合回 extensions（card.md 里留着的项按原顺序补位）
  applyExtras(data, scan.extras);

  const out = {
    spec: card?.frontmatter?.tavern?.spec ?? 'chara_card_v2',
    spec_version: card?.frontmatter?.tavern?.spec_version ?? '2.0',
    data,
    // 顶层 V1 镜像：旧前端兼容
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
  };
  return { card: out, bookCount: bookNodes.length, usedNodes: scan.nodes.filter(n => n.type !== 'card' && n.type !== 'note') };
}

// backupRef = { root, dir: null }；一次 build 内所有产物共享同一备份目录
async function backupIfExists(file, backupRef) {
  try {
    await fs.access(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null; // 只有"确实不存在"才算无旧文件
    throw e; // 权限等错误必须暴露，不得静默跳过备份
  }
  if (!backupRef.dir) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    let dir = path.join(backupRef.root, ts);
    for (let i = 2; ; i++) {
      try { await fs.mkdir(dir, { recursive: true }); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        dir = path.join(backupRef.root, `${ts}-${i}`);
      }
    }
    backupRef.dir = dir;
  }
  const dest = path.join(backupRef.dir, path.basename(file));
  await fs.copyFile(file, dest);
  return dest;
}

async function assignMissingBookTavernIds(scan) {
  const book = bookNodesOf(scan);
  if (!book.length) return [];
  const { sorted } = assignOrders(book);
  const usedUids = new Set();
  let maxUid = -1;
  for (const n of sorted) {
    const uid = n.frontmatter?.tavern?.id;
    if (uid !== undefined && uid !== null && uid !== '') {
      usedUids.add(String(uid));
      const num = Number(uid);
      if (Number.isInteger(num) && num > maxUid) maxUid = num;
    }
  }
  const assigned = [];
  for (const n of sorted) {
    if (n.loose) continue;
    const cur = n.frontmatter?.tavern?.id;
    if (cur !== undefined && cur !== null && cur !== '') continue;
    let nextUid = maxUid + 1;
    while (usedUids.has(String(nextUid))) nextUid++;
    maxUid = nextUid;
    usedUids.add(String(nextUid));
    n.frontmatter.tavern = { ...(n.frontmatter.tavern ?? {}), id: nextUid };
    const abs = path.join(scan.rootDir, n.relPath);
    const raw = await fs.readFile(abs, 'utf8');
    const hasBom = raw.charCodeAt(0) === 0xfeff;
    const clean = hasBom ? raw.slice(1) : raw;
    const fmMatch = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n?)/);
    if (fmMatch) {
      const eol = fmMatch[0].includes('\r\n') ? '\r\n' : '\n';
      const parsedFm = YAML.parse(quoteBarePosition(fmMatch[1])) ?? {};
      parsedFm.tavern = { ...(parsedFm.tavern ?? {}), id: nextUid };
      const newFmText = YAML.stringify(parsedFm, { lineWidth: 0 }).trimEnd().replace(/\r?\n/g, eol);
      const updated = (hasBom ? '\uFEFF' : '') + `---${eol}${newFmText}${eol}---${fmMatch[2]}` + clean.slice(fmMatch[0].length);
      await fs.writeFile(abs, updated, 'utf8');
      assigned.push({ relPath: n.relPath, uid: nextUid });
    }
  }
  return assigned;
}

export async function buildCmd(rootDir, opts = {}) {
  const scan = await scanCard(rootDir);
  const { errors, warnings } = validateNodes(scan);
  if (errors.length) {
    return { ok: false, report: `构建拒绝：协议存在 ${errors.length} 处问题\n` + formatReport({ errors, warnings }) };
  }

  await assignMissingBookTavernIds(scan);
  const { card, bookCount, usedNodes } = assemble(scan, opts);
  const distDir = path.join(scan.rootDir, 'dist');
  const backupsDir = path.join(scan.rootDir, 'backups');
  await fs.mkdir(distDir, { recursive: true });

  const safeName = card.data.name.replace(/[\\/:*?"<>|]/g, '_');
  const jsonPath = path.join(distDir, `${safeName}.json`);
  const txtPath = path.join(distDir, `${safeName}.txt`);

  const backups = [];
  const backupRef = { root: backupsDir, dir: null };
  for (const f of [jsonPath, txtPath]) {
    const b = await backupIfExists(f, backupRef);
    if (b) backups.push(b);
  }

  const jsonText = JSON.stringify(card, null, 2) + '\n';
  await fs.writeFile(jsonPath, jsonText, 'utf8');

  const mirror = usedNodes.map(n => `===== ${n.relPath} (${n.id}) =====\n${n.body}`).join('\n');
  await fs.writeFile(txtPath, mirror, 'utf8');

  // PNG（可选）
  let pngPath = null;
  if (opts.png) {
    const cover = await fs.readFile(opts.png);
    const pngBuf = embedChara(cover, card);
    pngPath = path.join(distDir, `${safeName}.png`);
    const b = await backupIfExists(pngPath, backupRef);
    if (b) backups.push(b);
    await fs.writeFile(pngPath, pngBuf);
  }

  // manifest
  const manifest = {
    builtWith: 'card-forge-lab 0.1.0',
    nodes: usedNodes.map(n => ({ id: n.id, source: n.relPath, target: n.target ?? defaultTarget(n, scan), sha256: sha256Hex(n.body) })),
    output: { json: path.relative(scan.rootDir, jsonPath), sha256: sha256Hex(jsonText) },
  };
  const forgeDir = path.join(scan.rootDir, '.card-forge');
  await fs.mkdir(forgeDir, { recursive: true });
  await fs.writeFile(path.join(forgeDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // 有内嵌世界书时调用现有 PowerShell 校验器（项目内副本）
  let worldbookCheck = null;
  if (bookCount > 0) {
    // fileURLToPath 解码中文等非 ASCII 路径；URL.pathname 会留下 %E5… 编码，PowerShell 找不到文件
    const validator = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'cf-card-format-export', 'scripts', 'validate-worldbook.ps1');
    const hasValidator = await fs.access(validator).then(() => true, () => false);
    if (hasValidator) {
      try {
        const out = execFileSync('powershell', ['-NoProfile', '-File', validator, '-Path', jsonPath], { encoding: 'utf8', timeout: 60000 });
        worldbookCheck = out.includes('RESULT : PASS') ? 'PASS' : 'FAIL\n' + out;
      } catch (e) {
        worldbookCheck = 'FAIL\n' + (e.stdout ?? e.message);
      }
    }
  }

  const lines = [];
  lines.push(`build：${card.data.name}`);
  lines.push(`条目：${bookCount} 条世界书；问候语 ${card.data.alternate_greetings.length + (card.data.first_mes ? 1 : 0)} 条`);
  lines.push(`输出：${jsonPath}`);
  if (pngPath) lines.push(`输出：${pngPath}`);
  else lines.push('封面：未指定 --png，本次只出 JSON（要 PNG 卡请加 --png <封面图>）');
  if (backups.length) lines.push(`备份：${backups.length} 个旧文件已移入 backups/`);
  lines.push(`JSON 指纹：${manifest.output.sha256.slice(0, 16)}…`);
  if (warnings.length) lines.push(`警告 ${warnings.length} 处（见 check）`);
  if (worldbookCheck) lines.push(`世界书校验：${worldbookCheck.split('\n')[0]}`);
  const ok = worldbookCheck ? worldbookCheck.startsWith('PASS') : true;
  lines.push(ok ? 'RESULT : PASS' : 'RESULT : FAIL（产物已生成但未通过校验，勿交付）');
  return { ok, report: lines.join('\n'), jsonPath, pngPath };
}