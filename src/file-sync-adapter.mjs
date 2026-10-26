import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readSlotsFromNodes, readSlotsFromCard, readSlotsFromTavern, attachNodeSettings, loadSyncState, saveSyncState, pendingStatus, slotHash, worldFilePath, readCardPng, extrasLib } from './slots.mjs';
import { contained, segment, nodeFiles, isCardFile, readJson, atomicJson, hashObject, digest, fail, stable } from './safety.mjs';
import { discoverProjects, targetOccupied, sameProjectPath, isLegacyNodeDirectory } from './projects.mjs';
import { planWorldEntryIds, assertUniqueEntryUids, isWorldEntryPath, reliableBaseline } from './world-entry-ids.mjs';
import { publishCardJob, getJobResult } from './bridge.mjs';
import { inspectSkillsAndAgents, deploySkillsAndAgents } from './skills.mjs';

const BODY = '<!-- body -->';
const BODY_FIELDS = new Set(['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'alternate_greetings', 'character_book']);
// 正则、脚本、变量、小白X任务按槽位逐项比，不算卡设置
function cardSettings(card) {
  return Object.fromEntries(Object.entries(extrasLib.stripExtras(card.data ?? card)).filter(([k]) => !BODY_FIELDS.has(k)));
}
// Compare author-controlled settings, not runtime fields added by Tavern. Missing build defaults
// do not count as changes (the forge unpack contract explicitly permits those defaults).
function settingDifferences(node, remote, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(node ?? {})) {
    if (remote?.[key] === undefined) continue;
    const field = prefix ? `${prefix}.${key}` : key;
    if (value === null && remote?.[key] === 100 && (field === 'extensions.probability' || field === 'extensions.group_weight')) continue;
    if (value && remote[key] && typeof value === 'object' && typeof remote[key] === 'object' && !Array.isArray(value) && !Array.isArray(remote[key])) out.push(...settingDifferences(value, remote[key], field));
    else if (JSON.stringify(stable(value)) !== JSON.stringify(stable(remote[key]))) out.push(field);
  }
  return out;
}
const IMPORT_METADATA = [['create_date'], ['chat'], ['fav'], ['extensions', 'fav']];
const IMPORT_NOTICE = 'PNG导入会重编码；创建日期、聊天关联和收藏按宿主语义变化，不是原字节恢复。';
const slotSignature = slots => hashObject(Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, { value: value.value, settings: value.settings ?? null }])));
function importSettings(card) {
  const result = structuredClone(cardSettings(card));
  for (const keys of IMPORT_METADATA) { let parent = result; for (const key of keys.slice(0, -1)) parent = parent?.[key]; if (parent) delete parent[keys.at(-1)]; }
  return result;
}
function importedRoot(raw, card, YAML) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return raw;
  const doc = YAML.parseDocument(match[1]); let changed = false;
  for (const [prefix, data] of [[['tavern'], card], [['tavern', 'data'], card.data ?? card]]) {
    for (const keys of IMPORT_METADATA) {
      const at = [...prefix, ...keys]; if (!doc.hasIn(at)) continue;
      const value = keys.reduce((v, key) => v?.[key], data);
      if (JSON.stringify(doc.getIn(at)?.toJSON?.() ?? doc.getIn(at)) === JSON.stringify(value)) continue;
      if (value === undefined) doc.deleteIn(at); else doc.setIn(at, value); changed = true;
    }
  }
  if (!changed) return raw;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return `---${eol}${String(doc).trimEnd().replaceAll('\n', eol)}${eol}---` + raw.slice(match[0].length);
}
function verifyImportedRestore(backup, remote) {
  const card = readCardPng(Buffer.from(backup.pngBase64, 'base64'));
  const expected = readSlotsFromCard(card, { worldRaw: backup.worldRaw });
  if (slotSignature(expected.slots) !== slotSignature(remote.tavern.slots) || backup.worldName !== remote.worldName || hashObject(backup.worldRaw === null ? null : JSON.parse(backup.worldRaw)) !== hashObject(remote.worldRaw === null ? null : JSON.parse(remote.worldRaw)) || settingDifferences(importSettings(card), importSettings(remote.tavern.card)).length) fail('RESTORE_VERIFY_FAILED', '导入后的正文、设置或世界书与备份不同；未确认恢复成功');
}
export class FileSyncAdapter {
  constructor({ skillsRoot, userDir, cardsRoot = null, transport = publishCardJob, queryResult = getJobResult, restoreMode = 'import' }) { this.skillsRoot = skillsRoot; this.userDir = userDir; this.cardsRoot = cardsRoot; this.transport = transport; this.queryResult = queryResult; this.restoreMode = restoreMode; }
  restoreSupport(project, backup, currentWorldName) {
    const blockedReason = this.restoreMode !== 'import' ? '导入恢复不可用' : !backup.pngBase64 || project.cardFile.startsWith('world:') ? '备份不是完整角色卡PNG' : backup.cardFile !== project.cardFile ? '同工程旧绑定备份；当前不支持跨名恢复' : currentWorldName !== undefined && backup.worldName !== currentWorldName ? '当前世界书绑定与备份不同，不能跨绑定恢复' : null;
    return { mode: this.restoreMode, canRestore: !blockedReason, blockedReason, notice: IMPORT_NOTICE };
  }
  operationFile(project) { return contained(project.dir, '.card-forge/operation.json'); }
  localSnapshot(project) {
    const rawFiles = Object.fromEntries(nodeFiles(project.dir).map(rel => [rel, fs.readFileSync(contained(project.dir, rel), 'utf8')]));
    const file = contained(project.dir, '.card-forge/tavern-sync.json');
    const baselineRaw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const baseline = baselineRaw ? JSON.parse(baselineRaw) : null, pendingFiles = {};
    for (const entry of Object.values(baseline?.pending ?? {})) {
      const rel = entry.file.replaceAll('\\', '/');
      if (!rel.startsWith('待归位/')) fail('INVALID_PATH', '旧待归位记录路径无效', 400);
      const pending = contained(project.dir, rel);
      pendingFiles[rel] = fs.existsSync(pending) ? fs.readFileSync(pending, 'utf8') : null;
    }
    return { rawFiles, pendingFiles, baselineRaw, localHash: hashObject({ rawFiles, pendingFiles, baselineRaw }) };
  }
  finishOperation(project, operation, result) {
    if (this.localSnapshot(project).localHash !== operation.localHash) {
      atomicJson(this.operationFile(project), { ...operation, state: 'reviewRequired', result });
      fail('OPERATION_REVIEW_REQUIRED', '写入等待期间工程改变；需要人工复核，不会用迟到任务覆盖作者修改');
    }
    fs.unlinkSync(this.operationFile(project));
  }
  assertTargetAvailable(project) {
    if (!this.cardsRoot) return;
    let validLocation = false;
    try {
      const rel = path.relative(this.cardsRoot, project.dir).split(path.sep).join('/');
      contained(this.cardsRoot, rel);
      if (project.staging || rel.split('/').length === 1) validLocation = true;
    } catch { /* invalid */ }
    if (!validLocation) fail('INVALID_PROJECT', '工程必须位于工作区目录下', 400);
    const records = [...discoverProjects(this.cardsRoot)];
    const own = records.find(p => sameProjectPath(p.dir, project.dir));
    if (own?.cardFile && project.cardFile && own.cardFile !== project.cardFile) fail('BINDING_CONFLICT', 'CLI目标与工程既有绑定不同');
    if (project.cardFile && records.some(p => !sameProjectPath(p.dir, project.dir) && targetOccupied(p, project.cardFile))) fail('TARGET_OCCUPIED', '同一目标仍由其他工程占用，包含其未决或待恢复操作');
  }
  async assertAvailable(project, { restoring = false, lifecycleId } = {}) {
    this.assertTargetAvailable(project);
    const binding = readJson(contained(project.dir, '.card-forge/bridge.json'));
    if (binding?.restoreRequired && !restoring) fail('RESTORE_REQUIRED', '完整恢复未完成；CLI与后台均禁止继续同步');
    if (binding?.operation && binding.operation.id !== lifecycleId) fail('OPERATION_PENDING', '建卡或改名尚未完整确认；禁止重复操作');
    const operation = readJson(this.operationFile(project));
    if (!operation) return;
    if (operation.state === 'reviewRequired') fail('OPERATION_REVIEW_REQUIRED', '未知写入或中途本地变化需要人工复核；不会自动清理记录');
    let result;
    try { result = await this.queryResult(operation.jobId); }
    catch (e) { fail('OPERATION_PENDING', `上次任务尚未确认：${e.message}`, 409, { jobId: operation.jobId }); }
    if (!result || result.pending || result.id !== operation.jobId) fail('OPERATION_PENDING', '上次任务尚未确认，不能再次提交或标记干净', 409, { jobId: operation.jobId });
    this.finishOperation(project, operation, result);
  }
  async send(project, job, snapshot = null) {
    await this.assertAvailable(project, { restoring: job.op === 'restore', lifecycleId: job.id });
    const local = this.localSnapshot(project);
    if (snapshot && snapshot.localHash !== local.localHash) fail('STALE_LOCAL', '提交前本地工程改变');
    const operation = { jobId: job.id, cardFile: project.cardFile, targetCardFile: job.op === 'create' ? `${job.fileName}.png` : job.op === 'rename' ? `${job.newName}.png` : project.cardFile, kind: job.op ?? 'push', state: 'pending', startedAt: new Date().toISOString(), localHash: local.localHash, expected: job.expected ?? null,
      plannedSlots: snapshot ? Object.fromEntries(Object.entries(snapshot.nodes.slots).map(([k, v]) => [k, slotHash(v.value)])) : null };
    const file = this.operationFile(project); fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, JSON.stringify(operation, null, 2) + '\n', { flag: 'wx' }); }
    catch (e) { if (e.code === 'EEXIST') fail('OPERATION_PENDING', '已有未决写入'); throw e; }
    const result = await this.transport(job, { timeoutMs: 150_000 });
    if (!result || result.id !== job.id) fail('OPERATION_PENDING', '没有收到此任务的有效回执，已保留未决记录');
    this.finishOperation(project, operation, result);
    return result;
  }
  async libraries() {
    if (!this.libs) {
      const load = rel => import(pathToFileURL(path.join(this.skillsRoot, rel)).href);
      this.libs = Promise.all([load('src/lib/nodes.mjs'), load('src/lib/fingerprint.mjs'), load('src/cmd/build.mjs'), load('src/lib/protocol.mjs'), load('src/cmd/unpack.mjs'), load('node_modules/yaml/dist/index.js'), load('src/lib/png.mjs')]).then(([nodes, fp, build, protocol, unpack, y, png]) => ({ nodes, fp, build, protocol, unpack, YAML: y.default ?? y, png }));
    }
    return this.libs;
  }
  remote(project) {
    const worldOnly = project.cardFile.startsWith('world:');
    if (!worldOnly) segment(project.cardFile, '卡文件名');
    const tavern = readSlotsFromTavern(project.cardFile, { userDir: this.userDir, requireWorld: true });
    const png = tavern.png ?? null;
    const worldName = tavern.worldName || null;
    const worldRaw = tavern.worldRaw ?? null;
    return { tavern, png, worldName, worldRaw, expected: { card: png ? digest(png) : null, worldName, world: worldRaw === null ? null : hashObject(JSON.parse(worldRaw)) } };
  }
  async snapshot(project) {
    const local = this.localSnapshot(project);
    const { rawFiles, pendingFiles, baselineRaw } = local;
    const libs = await this.libraries(), { nodes: lib, fp, build, protocol, unpack } = libs;
    let scan;
    // regex/、scripts/ 里 JSON 写坏时 scanCard 会抛错：报成格式错误，写明是哪个文件，不当成后台故障
    try { scan = await lib.scanCard(project.dir); }
    catch (e) { fail('INVALID_FORMAT', `「${project.id}」有文件格式不对，整张卡本轮没有同步：${e.message}`, 422, { badFiles: [{ relPath: null, message: e.message }] }); }
    // 文件开头设置写坏、正文边界标记缺失或重复时列出文件名。不能只跳过这个文件继续推送：
    // 推送的是整张合成卡，少一个文件就等于删掉酒馆里对应的条目
    const badFiles = scan.nodes.flatMap(n => n.problems.filter(p => ['P0', 'P1', 'P2'].includes(p.rule)).map(p => ({ relPath: n.relPath.split(path.sep).join('/'), message: p.message })));
    if (badFiles.length) fail('INVALID_FORMAT', `「${project.id}」有 ${badFiles.length} 处格式不对，整张卡本轮没有同步：${badFiles.slice(0, 5).map(b => `${b.relPath}（${b.message}）`).join('；')}${badFiles.length > 5 ? ' 等' : ''}`, 422, { badFiles });
    if (!scan.nodes.some(n => n.type === 'card')) {
      const legacy = scan.legacyHints?.length || isLegacyNodeDirectory(project.dir);
      fail(
        legacy ? 'LEGACY_PROJECT' : 'INVALID_PROJECT',
        legacy
          ? `工程「${project.id}」是旧版节点结构（${scan.legacyHints?.join('、') || 'index.md'}），请先运行 node card-forge-lab/src/cli.mjs migrate "<旧卡目录>" --out "<新标准卡目录>" 迁移为新格式（card.md / message / world_book），或点上方「拆解当前卡」从酒馆拆出`
          : `工程「${project.id}」缺少 card.md，不是有效的卡工程`,
        422,
      );
    }
    if (this.localSnapshot(project).localHash !== local.localHash) fail('STALE_LOCAL', '扫描期间工程文件改变，请重新检查');
    const remote = this.remote(project);
    const saved = baselineRaw ? JSON.parse(baselineRaw) : null;
    const baseline = saved?.cardFile === project.cardFile ? saved : null;
    const idAssignments = planWorldEntryIds(scan, rawFiles, remote.tavern.slots, baseline, libs);
    assertUniqueEntryUids(scan, lib, fp);
    const validation = protocol.validateNodes(scan);
    if (validation.errors.length) fail('INVALID_PROJECT', protocol.formatReport(validation), 422);
    const built = build.assemble(scan);
    // 「新建副本」导入时世界书改用不重名的名字：只记在 bridge.json，不改工程 card.md
    const worldOverride = readJson(contained(project.dir, '.card-forge/bridge.json'))?.worldOverride;
    if (worldOverride && !project.cardFile.startsWith('world:') && built.card.data) {
      (built.card.data.extensions ??= {}).world = worldOverride;
      if (built.card.data.character_book) built.card.data.character_book.name = worldOverride;
    }
    const nodes = attachNodeSettings(readSlotsFromNodes(scan, fp, lib), built.card, scan);
    for (const [key, slot] of Object.entries(nodes.slots)) if (key.startsWith('entry:') && isWorldEntryPath(slot.relPath)) slot.newEntryEligible = true;
    const targetWorld = built.card.data?.extensions?.world || null;
    if (targetWorld && targetWorld !== remote.worldName) {
      const target = worldFilePath(targetWorld, this.userDir);
      remote.expected.targetWorld = { name: targetWorld, hash: fs.existsSync(target) ? hashObject(readJson(target)) : null };
    }
    const { open, resolved } = pendingStatus(project.dir, baseline, remote.tavern.slots);
    const issues = [];
    const operation = readJson(this.operationFile(project));
    if (operation) issues.push({ kind: 'pendingOperation', message: `任务 ${operation.jobId} ${operation.state === 'reviewRequired' ? '需要人工复核' : '尚未确认'}` });
    if (!project.cardFile.startsWith('world:')) {
      const names = settingDifferences(cardSettings(built.card), cardSettings(remote.tavern.card));
      if (names.length) issues.push({ kind: 'settings', message: `卡设置不同：${names.join('、')}` });
      if ((built.card.data?.extensions?.world || null) !== remote.worldName) issues.push({ kind: 'binding', message: '工程与酒馆世界书绑定不同' });
    }
    // Also inspect entry options outside the legacy slot settings subset (group, recursion, etc.).
    const effective = remote.worldRaw ? unpack.worldFileToCard(JSON.parse(remote.worldRaw), remote.worldName) : remote.tavern.card;
    const remoteEntries = new Map((effective?.data?.character_book?.entries ?? []).map(e => [String(e.id), e]));
    for (const e of built.card.data?.character_book?.entries ?? []) {
      const t = remoteEntries.get(String(e.id));
      if (!t) continue;
      const { content: ignored, ...nSettings } = e;
      // 顶层 position 只有 before_char/after_char 两个值；按深度插入（extensions.position 不是 0/1）时它没有意义，
      // card-forge 装卡写 before_char，酒馆世界书换算回来是 after_char，不算差异。真正的位置看 extensions.position。
      const byDepth = v => v !== undefined && v !== null && Number(v) !== 0 && Number(v) !== 1;
      if (byDepth(e.extensions?.position) && byDepth(t.extensions?.position)) delete nSettings.position;
      const names = settingDifferences(nSettings, t);
      if (names.length) issues.push({ kind: 'settings', key: `entry:${e.id}`, message: `条目设置不同：${names.join('、')}` });
    }
    return { ...remote, ...local, nodes, baseline, baselineReliable: reliableBaseline(saved, project.cardFile), idAssignments, open, resolved, card: built.card, issues,
      revision: hashObject({ localHash: local.localHash, expected: remote.expected, operation, open: [...open], resolved: [...resolved] }) };
  }
  async writeBodies(project, snapshot, updates) {
    if (snapshot.localHash !== this.localSnapshot(project).localHash) fail('STALE_PREVIEW', '节点在准备写入时改变');
    const planned = { ...snapshot.rawFiles }, newFiles = new Set(), deleted = new Set();
    for (const assignment of snapshot.idAssignments ?? []) planned[assignment.relPath] = assignment.text;
    for (const { key, value } of updates) {
      if (extrasLib.isExtraKey(key)) { await this.planExtra(project, snapshot, planned, newFiles, deleted, key, value); continue; }
      let rel = snapshot.nodes.slots[key]?.relPath?.replaceAll('\\', '/');
      // 酒馆里写了、本地还没有文件的字段：按新格式位置新建散文件（整文件就是正文）
      const field = !rel && key.startsWith('field:') ? key.slice(6) : null;
      if (field) {
        rel = field === 'first_mes' ? 'message/0.md' : `${field}.md`;
        if (planned[rel] !== undefined || fs.existsSync(contained(project.dir, rel))) fail('STALE_PREVIEW', `字段文件已存在：${rel}`);
        planned[rel] = value.replaceAll('\n', '\n') + '\n'; newFiles.add(rel); continue;
      }
      if (!rel || planned[rel] === undefined) fail('INVALID_SLOT', `没有节点：${key}`, 400);
      const raw = planned[rel];
      // 没有开头设置的散文件：整文件就是正文，直接整体替换
      if (!/^\uFEFF?---\r?\n/.test(raw)) { const eol = raw.includes('\r\n') ? '\r\n' : '\n'; planned[rel] = value.replaceAll('\n', eol) + eol; continue; }
      const at = raw.indexOf(BODY);
      if (at < 0 || raw.indexOf(BODY, at + BODY.length) >= 0 || value.includes(BODY)) fail('INVALID_BODY', `正文标记不唯一：${rel}`, 422);
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';
      planned[rel] = raw.slice(0, at + BODY.length) + eol + value.replaceAll('\n', eol) + eol;
    }
    for (const rel of deleted) {
      const file = contained(project.dir, rel);
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== snapshot.rawFiles[rel]) fail('STALE_PREVIEW', '写入前节点改变');
    }
    for (const [rel, text] of Object.entries(planned)) {
      if (text === snapshot.rawFiles[rel]) continue;
      const file = contained(project.dir, rel);
      if (newFiles.has(rel)) { if (fs.existsSync(file)) fail('STALE_PREVIEW', '写入前出现同名文件'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); continue; }
      if (fs.readFileSync(file, 'utf8') !== snapshot.rawFiles[rel]) fail('STALE_PREVIEW', '写入前节点改变');
      fs.writeFileSync(file, text, 'utf8');
    }
    for (const rel of deleted) { const file = contained(project.dir, rel); if (fs.existsSync(file)) fs.unlinkSync(file); }
    return hashObject({ rawFiles: planned, pendingFiles: snapshot.pendingFiles, baselineRaw: snapshot.baselineRaw });
  }
  // 正则、脚本、变量、小白X任务写回工程：拆成文件的改文件，留在 card.md 的改 card.md，酒馆新增的新建文件；value 为 null 是删除
  async planExtra(project, snapshot, planned, newFiles, deleted, key, value) {
    const slot = snapshot.nodes.slots[key], kind = extrasLib.extraKind(key);
    const obj = value === null ? null : JSON.parse(value);
    if (slot?.kept) {
      const { YAML } = await this.libraries();
      const raw = planned['card.md'], match = raw?.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
      if (!match) fail('INVALID_BODY', 'card.md 没有开头设置，不能写回留在卡里的正则或脚本', 422);
      const doc = YAML.parseDocument(match[1]), at = ['tavern', 'data', 'extensions'];
      const ext = doc.getIn(at)?.toJSON?.() ?? doc.getIn(at) ?? {};
      doc.setIn(at, extrasLib.setKeptItem(ext, key, obj));
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';
      planned['card.md'] = `---${eol}${String(doc).trimEnd().replaceAll('\n', eol)}${eol}---` + raw.slice(match[0].length);
      return;
    }
    const old = slot?.files ?? [];
    let base = slot?.base ?? null;
    if (!slot && (kind === 'regex' || kind === 'script')) {
      const dir = kind === 'regex' ? 'regex/' : 'scripts/';
      const nums = Object.keys(planned).filter(r => r.startsWith(dir)).map(r => Number(r.slice(dir.length).match(/^(\d+)-/)?.[1])).filter(Number.isFinite);
      base = extrasLib.extraBase(kind, Math.max(0, ...nums) + 1, extrasLib.itemLabel(kind, obj));
    }
    const next = obj === null ? {} : extrasLib.extraFiles(kind, obj, base);
    for (const rel of old) if (!Object.hasOwn(next, rel)) { delete planned[rel]; deleted.add(rel); }
    for (const [rel, text] of Object.entries(next)) {
      if (planned[rel] === undefined) { if (fs.existsSync(contained(project.dir, rel)) && !old.includes(rel)) fail('STALE_PREVIEW', `文件已存在：${rel}`); newFiles.add(rel); }
      planned[rel] = text;
    }
  }
  async push(project, snapshot) {
    const worldOnly = project.cardFile.startsWith('world:');
    const card = worldOnly ? null : structuredClone(snapshot.card);
    if (card) {
      // 酒馆合并写入时对象里的键不会被删掉：工程里删掉的角色变量、小白X任务写成空值
      const x = (card.data.extensions ??= {});
      if (snapshot.tavern.slots.vars && !snapshot.nodes.slots.vars) (x.tavern_helper ??= {}).variables = {};
      if (snapshot.tavern.slots.xbtasks && !snapshot.nodes.slots.xbtasks) x['xiaobaix-tasks'] = { tasks: [] };
      // 数组是整体替换；工程里一条都不剩时要显式写空数组，否则酒馆里的旧内容会留着
      const has = p => Object.keys(snapshot.nodes.slots).some(k => k.startsWith(p)), had = p => Object.keys(snapshot.tavern.slots).some(k => k.startsWith(p));
      if (had('regex:') && !has('regex:')) x.regex_scripts = [];
      if (had('script:') && !has('script:')) (x.tavern_helper ??= {}).scripts = [];
    }
    const job = { id: crypto.randomUUID(), expected: snapshot.expected, ...(worldOnly ? { worldName: project.cardFile.slice(6), book: snapshot.card.data.character_book ?? { entries: [] } } : { avatar: project.cardFile, card }) };
    const result = await this.send(project, job, snapshot);
    if (!result || result.fatal) fail('TRANSPORT_FAILED', result?.fatal ?? '酒馆未确认写入', 502);
    return result;
  }
  async saveBaseline(project, snapshot, clean) {
    await this.assertAvailable(project);
    if (snapshot.localHash !== this.localSnapshot(project).localHash) fail('STALE_LOCAL', '保存同步基线前本地改变');
    const slots = { ...(snapshot.baseline?.slots ?? {}) }, pending = { ...(snapshot.baseline?.pending ?? {}) };
    for (const [key, node] of Object.entries(snapshot.nodes.slots)) {
      if (node.value === snapshot.tavern.slots[key]?.value) { slots[key] = slotHash(node.value); delete pending[key]; }
    }
    // 新格式里空字段不生成文件：没有文件且酒馆也是空的字段，基线记为空值，之后哪边写了内容都能正常判断方向
    const emptyFields = new Set(Object.entries(snapshot.tavern.slots).filter(([key, slot]) => key.startsWith('field:') && !snapshot.nodes.slots[key] && slot.value === '').map(([key]) => key));
    for (const key of emptyFields) { slots[key] = slotHash(''); delete pending[key]; }
    // Retain entry hashes as history even when both sides remove the entry: its UID is not new again.
    if (clean) for (const key of Object.keys(slots)) if (!snapshot.nodes.slots[key] && !key.startsWith('entry:') && !emptyFields.has(key)) delete slots[key];
    if (snapshot.baseline && hashObject(slots) === hashObject(snapshot.baseline.slots ?? {}) && hashObject(pending) === hashObject(snapshot.baseline.pending ?? {})) return;
    saveSyncState(project.dir, project.cardFile, slots, pending);
  }
  // 备份位置：留空时为 cards/backups/<卡名>/，填了就是 <填的目录>/<卡名>/；每次一个时间子文件夹
  backupRoot(project, backupDir = '') {
    const name = segment(project.name ?? path.basename(project.dir), '工程名');
    const raw = typeof backupDir === 'string' ? backupDir.trim() : '';
    const base = raw ? path.resolve(path.isAbsolute(raw) ? raw : path.join(this.cardsRoot ?? path.dirname(project.dir), raw)) : path.join(this.cardsRoot ?? path.dirname(project.dir), 'backups');
    if (sameProjectPath(base, project.dir) || path.resolve(base).toLowerCase().startsWith(path.resolve(project.dir).toLowerCase() + path.sep)) fail('INVALID_BACKUP_DIR', '备份位置不能在工程文件夹里', 400);
    return path.join(base, name);
  }
  async backup(project, snapshot, { backupDir = '' } = {}) {
    const id = new Date().toISOString().replace(/[:.]/g, '-') + `-${crypto.randomUUID().slice(0, 8)}`;
    const dir = path.join(this.backupRoot(project, backupDir), id);
    fs.mkdirSync(dir, { recursive: true });
    const stateFile = contained(project.dir, '.card-forge/tavern-sync.json');
    const data = { format: 1, id, projectKey: readJson(contained(project.dir, '.card-forge/bridge.json'))?.projectKey ?? null, cardFile: project.cardFile, createdAt: new Date().toISOString(), nodes: snapshot.rawFiles, pendingFiles: snapshot.pendingFiles,
      baselineRaw: fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null,
      pngBase64: snapshot.png?.toString('base64') ?? null, worldName: snapshot.worldName, worldRaw: snapshot.worldRaw };
    atomicJson(path.join(dir, 'snapshot.json'), { ...data, checksum: hashObject(data) });
    // 同时放一份能直接用的文件：酒馆卡 PNG、世界书 JSON、工程文件
    if (snapshot.png && project.cardFile && !project.cardFile.startsWith('world:')) fs.writeFileSync(path.join(dir, project.cardFile), snapshot.png);
    if (snapshot.worldRaw !== null && snapshot.worldRaw !== undefined) fs.writeFileSync(path.join(dir, `${snapshot.worldName || 'world'}.json`), snapshot.worldRaw, 'utf8');
    for (const [rel, text] of Object.entries(snapshot.rawFiles ?? {})) {
      const dst = contained(dir, `工程/${rel}`);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, text, 'utf8');
    }
    return id;
  }
  backups(project) {
    const root = this.backupRoot(project);
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
      try {
        const b = this.readBackup(project, e.name), bindingChanged = b.cardFile !== project.cardFile;
        const support = this.restoreSupport(project, b);
        return { id: e.name, createdAt: b.createdAt, cardFile: b.cardFile, supported: true, bindingChanged, restorable: support.canRestore, mode: support.mode, notice: support.notice, ...(support.blockedReason ? { reason: support.blockedReason } : {}) };
      }
      catch (error) { return { id: e.name, createdAt: null, supported: false, reason: error.message }; }
    }).sort((a, b) => b.id.localeCompare(a.id));
  }
  readBackup(project, id) {
    segment(id, '备份名');
    const backup = readJson(path.join(this.backupRoot(project), id, 'snapshot.json'));
    if (!backup || backup.format !== 1 || !backup.pendingFiles) fail('UNSUPPORTED_BACKUP', '旧备份没有完整节点、待归位文件、同步基线和酒馆快照；只读，不支持恢复');
    const { checksum, ...data } = backup;
    if (checksum !== hashObject(data) || !backup.nodes || !Object.hasOwn(backup, 'baselineRaw')) fail('INVALID_BACKUP', '备份校验或结构无效');
    if (backup.cardFile !== project.cardFile && (!backup.projectKey || backup.projectKey !== readJson(contained(project.dir, '.card-forge/bridge.json'))?.projectKey)) fail('BACKUP_BINDING_CHANGED', '旧绑定备份缺少可核实工程身份；只读，不按损坏处理');
    for (const rel of Object.keys(backup.nodes)) {
      if (!isCardFile(rel) || rel.split('/').some(p => p.startsWith('.'))) fail('INVALID_BACKUP', '备份包含非工程文件路径');
      contained(project.dir, rel);
    }
    for (const rel of Object.keys(backup.pendingFiles)) { if (!rel.startsWith('待归位/')) fail('INVALID_BACKUP', '待归位备份路径无效'); contained(project.dir, rel); }
    return backup;
  }
  async restore(project, backup, expectedRevision, { skipBackup = false, acceptDataLossRisk = false, backupDir = '' } = {}) {
    if (skipBackup && acceptDataLossRisk !== true) fail('CONFIRMATION_REQUIRED', '不备份直接覆盖恢复前，必须勾选确认自行承担数据丢失责任', 400);
    const support = this.restoreSupport(project, backup);
    if (!support.canRestore) fail('UNSUPPORTED_RESTORE', support.blockedReason, 409);
    await this.assertAvailable(project, { restoring: true });
    const current = await this.snapshot(project);
    if (current.revision !== expectedRevision) fail('STALE_PREVIEW', '恢复预览后内容改变');
    if (!backup.pngBase64) fail('UNSUPPORTED_BACKUP', '此备份不是完整角色卡备份');
    if (backup.worldName !== current.worldName) fail('UNSUPPORTED_RESTORE', '当前世界书绑定与备份不同；不能在未预览另一世界书时恢复');
    const safetyBackupId = skipBackup ? null : await this.backup(project, current, { backupDir });
    const result = await this.send(project, { id: crypto.randomUUID(), op: 'restore', avatar: project.cardFile, pngBase64: backup.pngBase64, worldName: backup.worldName, world: backup.worldRaw === null ? null : JSON.parse(backup.worldRaw), worldRaw: backup.worldRaw, expected: current.expected }, current);
    if (!result || result.fatal || result.restored !== true) fail('RESTORE_FAILED', result?.fatal ?? '酒馆未确认完整恢复；保持该卡暂停', 502);
    // PNG import may change host-owned metadata; body slots, author settings and world data may not.
    const remote = this.remote(project); verifyImportedRestore(backup, remote);
    const { YAML } = await this.libraries(), plannedNodes = { ...backup.nodes };
    if (plannedNodes['card.md']) plannedNodes['card.md'] = importedRoot(plannedNodes['card.md'], remote.tavern.card, YAML);
    if (this.localSnapshot(project).localHash !== current.localHash) fail('RESTORE_LOCAL_CHANGED', '远端恢复后工程已变动；未覆盖节点，保持暂停');
    for (const rel of nodeFiles(project.dir)) if (!(rel in plannedNodes)) fs.unlinkSync(contained(project.dir, rel));
    for (const [rel, text] of Object.entries(plannedNodes)) {
      const file = contained(project.dir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8');
    }
    for (const rel of new Set([...Object.keys(current.pendingFiles), ...Object.keys(backup.pendingFiles)])) {
      const file = contained(project.dir, rel), text = backup.pendingFiles[rel];
      if (text === null || text === undefined) { if (fs.existsSync(file)) fs.unlinkSync(file); }
      else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }
    }
    const pending = backup.baselineRaw ? JSON.parse(backup.baselineRaw).pending ?? {} : {};
    for (const [key, item] of Object.entries(pending)) if (remote.tavern.slots[key]) item.tavern = slotHash(remote.tavern.slots[key].value);
    saveSyncState(project.dir, project.cardFile, Object.fromEntries(Object.entries(remote.tavern.slots).map(([key, slot]) => [key, slotHash(slot.value)])), pending);
    const after = await this.snapshot(project); verifyImportedRestore(backup, after);
    if (hashObject(after.rawFiles) !== hashObject(plannedNodes) || hashObject(after.pendingFiles) !== hashObject(backup.pendingFiles)) fail('RESTORE_VERIFY_FAILED', '节点或待归位文件恢复验证失败；保持暂停');
    return { status: 'restored', mode: 'import', backupId: backup.id, safetyBackupId, backupSkipped: Boolean(skipBackup), paused: true, notice: IMPORT_NOTICE };
  }
  // 拆前扫描：列出卡里的正则、脚本、变量、小白X任务，并识别变量框架。只读
  scanCard(cardFile) {
    segment(cardFile, '卡文件名');
    const tavern = readSlotsFromTavern(cardFile, { userDir: this.userDir });
    const items = extrasLib.listExtras(tavern.card).map(({ key, kind, label, disabled }) => ({ key, kind, label, disabled }));
    const keep = new Set(extrasLib.defaultKeep(tavern.card));
    return { cardFile, worldName: tavern.worldName || null, frameworks: extrasLib.detectFrameworks(tavern.card, tavern.worldRaw ?? ''), items: items.map(i => ({ ...i, split: !keep.has(i.key) })) };
  }
  listCards() {
    const dir = path.join(this.userDir, 'characters');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && /\.png$/i.test(e.name)).map(e => ({ cardFile: e.name, name: path.basename(e.name, '.png') }));
  }
  listWorlds() {
    const dir = path.join(this.userDir, 'worlds');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && /\.json$/i.test(e.name)).map(e => ({ worldName: path.basename(e.name, '.json') }));
  }
  // 只按参与同步的文件计算：根目录放笔记、草稿、调研不会触发同步检查
  localRevision(project) {
    return hashObject({ nodes: Object.fromEntries(nodeFiles(project.dir).map(rel => [rel, fs.readFileSync(contained(project.dir, rel), 'utf8')])) });
  }
  async exportProject(project, outDir) {
    await this.assertAvailable(project);
    const { build } = await this.libraries();
    const worldOnly = project.cardFile.startsWith('world:');
    const png = !worldOnly ? [path.join(this.userDir, 'characters', project.cardFile), path.join(project.dir, '.card-forge', 'originals', project.cardFile)].find(p => fs.existsSync(p)) : undefined;
    const defaultDist = path.join(project.dir, 'dist');
    const rawOut = typeof outDir === 'string' ? outDir.trim() : '';
    const customOut = rawOut ? (path.isAbsolute(rawOut) ? path.resolve(rawOut) : path.resolve(project.dir, rawOut)) : defaultDist;
    const relToProject = path.relative(project.dir, customOut);
    const insideProjectOutsideDist = !relToProject.startsWith('..') && !path.isAbsolute(relToProject) && relToProject !== 'dist' && !relToProject.startsWith(`dist${path.sep}`);
    if (sameProjectPath(customOut, project.dir) || insideProjectOutsideDist || (this.userDir && sameProjectPath(customOut, this.userDir))) {
      fail('INVALID_EXPORT_DIR', '自定义导出目录请填写工程外的文件夹路径（或工程内 dist 子目录）', 400);
    }
    const result = await build.buildCmd(project.dir, { png });
    if (!result.ok) fail('EXPORT_FAILED', result.report, 422);
    if (!sameProjectPath(customOut, defaultDist)) {
      fs.mkdirSync(customOut, { recursive: true });
      if (result.jsonPath && fs.existsSync(result.jsonPath)) fs.copyFileSync(result.jsonPath, path.join(customOut, path.basename(result.jsonPath)));
      if (result.pngPath && fs.existsSync(result.pngPath)) fs.copyFileSync(result.pngPath, path.join(customOut, path.basename(result.pngPath)));
    }
    return { outDir: customOut, report: result.report };
  }
  async setRoot(project, pairs) {
    const { YAML } = await this.libraries(), file = contained(project.dir, 'card.md');
    const raw = fs.readFileSync(file, 'utf8'), match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) fail('INVALID_PROJECT', '卡根没有 frontmatter', 422);
    const doc = YAML.parseDocument(match[1]);
    for (const [keys, value] of pairs) doc.setIn(keys, value);
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(file, `---${eol}${String(doc).trimEnd().replaceAll('\n', eol)}${eol}---` + raw.slice(match[0].length), 'utf8');
  }
  async prepareNew(project, { embedWorld = false, allowExistingWorld = false } = {}) {
    const { YAML, nodes, build } = await this.libraries();
    const root = contained(project.dir, 'card.md');
    if (!fs.existsSync(root)) {
      if (isLegacyNodeDirectory(project.dir)) {
        fail('LEGACY_PROJECT', '检测到旧版 index.md 节点目录；请先运行 node card-forge-lab/src/cli.mjs migrate "<旧卡目录>" --out "<新标准卡目录>" 迁移为 card.md 新结构，不会自动写入空 card.md', 422);
      }
      // 只有散文件的新工程（如只写了 description.md、world_book/*.md）：补一个卡根，其他文件不动
      fs.writeFileSync(root, `---\n${YAML.stringify({ id: 'card-root', type: 'card', name: project.name }).trimEnd()}\n---\n\n## 工序\n- 状态：草稿\n\n${BODY}\n`, 'utf8');
    }
    const scan = await nodes.scanCard(project.dir), card = build.assemble(scan).card;
    if (scan.nodes.find(n => n.type === 'card')?.frontmatter?.book_only) fail('WORLD_ONLY_PROJECT', '独立世界书工程不自动建卡');
    const explicitWorld = card.data?.extensions?.world;
    if (explicitWorld && !allowExistingWorld && fs.existsSync(worldFilePath(explicitWorld, this.userDir))) fail('WORLD_TARGET_CONFLICT', `工程指定的世界书「${explicitWorld}」已存在；没有新建卡或覆盖世界书`);
    if (!embedWorld && nodes.bookNodesOf(scan).length && !card.data?.extensions?.world) {
      const base = project.name; let name = base;
      for (let i = 2; fs.existsSync(worldFilePath(name, this.userDir)); i++) name = `${base}（${i}）`;
      await this.setRoot(project, [[['tavern', 'data', 'extensions', 'world'], name]]);
    }
    const report = (await this.libraries()).protocol.validateNodes(await nodes.scanCard(project.dir));
    if (report.errors.length) fail('INVALID_PROJECT', (await this.libraries()).protocol.formatReport(report), 422);
    return {
      cardName: (card.data?.name || project.name).trim() || project.name,
      explicitWorld: explicitWorld || null,
    };
  }
  async create(project, jobId, { displayName } = {}) {
    // 带封面建卡：工程里有 character.png 时，把它做成只含卡名的空白卡，由酒馆「导入」接口按指定文件名建卡；
    // 正文和世界书仍由随后的推送写入。没有封面时退回酒馆的建卡接口（默认头像）。
    const name = (displayName || project.name).trim() || project.name;
    let pngBase64 = null;
    const cover = path.join(project.dir, 'character.png');
    if (fs.existsSync(cover)) {
      const { png } = await this.libraries();
      const blank = { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', spec: 'chara_card_v2', spec_version: '2.0',
        data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
          alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } };
      pngBase64 = png.embedChara(fs.readFileSync(cover), blank).toString('base64');
    }
    const result = await this.send(project, { id: jobId, op: 'create', name, fileName: project.name, expectedAbsent: true, ...(pngBase64 ? { pngBase64 } : {}) });
    if (!result || result.fatal) fail('CREATE_FAILED', result?.fatal ?? '酒馆未确认新建', 502);
    segment(result.avatar, '返回的卡文件名'); return result.avatar;
  }
  async rename(project, jobId) {
    const snapshot = await this.snapshot(project);
    const backupId = await this.backup(project, snapshot);
    const result = await this.send(project, { id: jobId, op: 'rename', avatar: project.cardFile, newName: project.name, expected: snapshot.expected, expectedTargetAbsent: true }, snapshot);
    if (!result || result.fatal) fail('RENAME_FAILED', result?.fatal ?? '酒馆未确认改名', 502);
    segment(result.avatar, '返回的卡文件名');
    if (result.avatar !== `${project.name}.png`) fail('RENAME_MISMATCH', `酒馆返回了不同文件名 ${result.avatar}；需要核实绑定`);
    await this.setRoot(project, [[['name'], project.name]]);
    const file = contained(project.dir, '.card-forge/tavern-sync.json'), baseline = readJson(file);
    if (baseline?.cardFile === project.cardFile) atomicJson(file, { ...baseline, cardFile: result.avatar });
    return { cardFile: result.avatar, backupId };
  }
  async validateWorldProject(project, worldName) {
    await this.assertAvailable({ ...project, cardFile: `world:${worldName}` });
    const { nodes, build } = await this.libraries(), scan = await nodes.scanCard(project.dir);
    if (!scan.nodes.find(n => n.type === 'card')?.frontmatter?.book_only) fail('INVALID_PROJECT', '工程没有 book_only:true，不能绑定为独立书');
    const configured = build.assemble(scan).card.data?.extensions?.world;
    if (configured && configured !== worldName) fail('BINDING_CONFLICT', '工程世界书名与CLI目标不同');
    if (!fs.existsSync(worldFilePath(worldName, this.userDir))) fail('WORLD_NOT_FOUND', '世界书不存在；不能自动覆盖其他目标');
  }
  async attach(project, { overwrite = false, skipBackup = false, acceptDataLossRisk = false, backupDir = '', keep } = {}) {
    await this.assertAvailable(project);
    if (fs.existsSync(project.dir) && !overwrite) fail('ATTACH_CONFLICT', '同名工程目录已存在；拒绝覆盖或自动接入');
    if (overwrite && skipBackup && acceptDataLossRisk !== true) fail('CONFIRMATION_REQUIRED', '不备份直接覆盖同名工程前，必须勾选确认自行承担数据丢失责任', 400);
    const worldOnly = project.cardFile.startsWith('world:');
    if (worldOnly && !fs.existsSync(worldFilePath(project.cardFile.slice(6), this.userDir))) fail('WORLD_NOT_FOUND', '世界书不存在；不能接入', 404);
    const remote = this.remote(project);
    const { unpack } = await this.libraries();
    // Stage under the same work directory, then atomically rename only after round-trip validation.
    const stage = path.join(path.dirname(project.dir), `.attach-${crypto.randomUUID()}`);
    fs.mkdirSync(stage, { recursive: true });
    const source = worldOnly ? worldFilePath(project.cardFile.slice(6), this.userDir) : path.join(stage, 'source.json');
    const out = path.join(stage, 'project');
    if (!worldOnly) {
      const effective = structuredClone(remote.tavern.card);
      const effData = effective.data ?? effective;
      if (remote.worldRaw !== null) {
        const book = unpack.worldFileToCard(JSON.parse(remote.worldRaw), remote.worldName).data.character_book;
        effData.character_book = book;
      } else if (effData.character_book == null) {
        // 酒馆新建的空卡写的是 character_book: null。空卡拆出来没有条目，合成时也不会生成这个键；
        // 留着 null 会让往返比对把「null 对没有」当成不一致。只删源副本里的这个键，酒馆里的卡不动。
        delete effData.character_book;
      }
      fs.writeFileSync(source, JSON.stringify(effective), 'utf8');
    }
    try {
      const result = await unpack.unpackCmd(source, { out, ...(Array.isArray(keep) ? { keep } : {}) });
      if (!result.ok) fail('UNPACK_FAILED', result.report, 422);
      const staged = { ...project, dir: out, staging: true };
      const snapshot = await this.snapshot(staged);
      const { compareSnapshot } = await import('./sync-engine.mjs');
      const diff = compareSnapshot(snapshot);
      if (!diff.clean) fail('ATTACH_VERIFY_FAILED', 'unpack 后正文、设置或外置世界书不一致；没有接管', 409, diff);
      if (JSON.stringify(this.remote(project).expected) !== JSON.stringify(remote.expected)) fail('STALE_REMOTE', '接入期间酒馆卡或世界书改变');
      const originals = path.join(out, '.card-forge', 'originals');
      fs.mkdirSync(originals, { recursive: true });
      if (remote.png) fs.writeFileSync(path.join(originals, project.cardFile), remote.png);
      if (remote.worldRaw !== null) fs.writeFileSync(path.join(originals, 'world.json'), remote.worldRaw);
      await this.saveBaseline(staged, snapshot, true);
      if (fs.existsSync(project.dir)) {
        if (!overwrite) fail('ATTACH_CONFLICT', '接入期间出现同名工程');
        if (!skipBackup) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupTarget = path.join(this.backupRoot(project, backupDir), `${stamp}-接入前的工程`);
          fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
          fs.cpSync(project.dir, backupTarget, { recursive: true });
        }
        fs.rmSync(project.dir, { recursive: true, force: true });
      }
      fs.renameSync(out, project.dir);
      return result;
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  async skillsStatus() {
    return inspectSkillsAndAgents({ skillsRoot: this.skillsRoot, userDir: this.userDir });
  }
  async skillsDeploy(options = {}) {
    return deploySkillsAndAgents({ skillsRoot: this.skillsRoot, userDir: this.userDir, ...options });
  }
}
