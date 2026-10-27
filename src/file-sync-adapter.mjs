import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BRIDGE_ROOT } from './connection.mjs';
import { readSlotsFromNodes, readSlotsFromTavern, attachNodeSettings, saveSyncState, pendingStatus, slotHash, worldFilePath, readCardPng, extrasLib } from './slots.mjs';
import { contained, segment, nodeFiles, isCardFile, readJson, atomicJson, hashObject, digest, fail, stable, copyTree } from './safety.mjs';
import { discoverProjects, targetOccupied, sameProjectPath, isLegacyNodeDirectory } from './projects.mjs';
import { planWorldEntryIds, assertUniqueEntryUids, isWorldEntryPath, reliableBaseline } from './world-entry-ids.mjs';
import { publishCardJob, getJobResult } from './bridge.mjs';
import { inspectSkillsAndAgents, deploySkillsAndAgents } from './skills.mjs';

const BODY = '<!-- body -->';
// 1×1 透明 PNG：工程没有封面、也没有旧卡图时新建卡用
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
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
export class FileSyncAdapter {
  constructor({ skillsRoot, userDir, cardsRoot = null, transport = publishCardJob, queryResult = getJobResult }) { this.skillsRoot = skillsRoot ? path.resolve(BRIDGE_ROOT, skillsRoot) : path.resolve(BRIDGE_ROOT, '../card-forge-lab'); this.userDir = userDir; this.cardsRoot = cardsRoot; this.transport = transport; this.queryResult = queryResult; }
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
    // 覆盖拆解时的临时目录：它将替换的那个同名工程不算「其他工程」
    const replacing = project.staging && project.finalDir ? project.finalDir : null;
    if (own?.cardFile && project.cardFile && own.cardFile !== project.cardFile) fail('BINDING_CONFLICT', 'CLI目标与工程既有绑定不同');
    if (project.cardFile && records.some(p => !sameProjectPath(p.dir, project.dir) && !(replacing && sameProjectPath(p.dir, replacing)) && targetOccupied(p, project.cardFile))) fail('TARGET_OCCUPIED', '同一目标仍由其他工程占用，包含其未决或待恢复操作');
  }
  async assertAvailable(project, { lifecycleId } = {}) {
    this.assertTargetAvailable(project);
    const binding = readJson(contained(project.dir, '.card-forge/bridge.json'));
    if (binding?.operation && binding.operation.id !== lifecycleId) fail('OPERATION_PENDING', '上次建卡或改名没有完成；先处理，不会重复执行');
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
    await this.assertAvailable(project, { lifecycleId: job.id });
    const local = this.localSnapshot(project);
    if (snapshot && snapshot.localHash !== local.localHash) fail('STALE_LOCAL', '提交前本地工程改变');
    const operation = { jobId: job.id, cardFile: project.cardFile, targetCardFile: job.op === 'rename' ? `${job.newName}.png` : job.op === 'create' ? job.avatar : project.cardFile, kind: job.op ?? 'push', state: 'pending', startedAt: new Date().toISOString(), localHash: local.localHash, expected: job.expected ?? null,
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
  // 读本地工程并做格式检查。同步和新建卡共用
  async scanLocal(project, libs) {
    let scan;
    // regex/、scripts/ 里 JSON 写坏时 scanCard 会抛错：报成格式错误，写明是哪个文件，不当成后台故障
    try { scan = await libs.nodes.scanCard(project.dir); }
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
    return scan;
  }
  // 按本地工程合成整张卡；worldOverride 是新建卡时起的新世界书名（只记在 bridge.json，不改 card.md）
  assembleCard(scan, build, worldOverride, nameOverride = null) {
    const built = build.assemble(scan);
    if (built.card.data) {
      if (nameOverride) { built.card.name = nameOverride; built.card.data.name = nameOverride; }
      if (worldOverride) {
        (built.card.data.extensions ??= {}).world = worldOverride;
        if (built.card.data.character_book) built.card.data.character_book.name = worldOverride;
      }
    }
    return built;
  }
  async snapshot(project) {
    const local = this.localSnapshot(project);
    const { rawFiles, pendingFiles, baselineRaw } = local;
    const libs = await this.libraries(), { nodes: lib, fp, build, protocol, unpack } = libs;
    const scan = await this.scanLocal(project, libs);
    if (this.localSnapshot(project).localHash !== local.localHash) fail('STALE_LOCAL', '扫描期间工程文件改变，请重新检查');
    const remote = this.remote(project);
    const saved = baselineRaw ? JSON.parse(baselineRaw) : null;
    const baseline = saved?.cardFile === project.cardFile ? saved : null;
    const idAssignments = planWorldEntryIds(scan, rawFiles, remote.tavern.slots, baseline, libs);
    assertUniqueEntryUids(scan, lib, fp);
    const validation = protocol.validateNodes(scan);
    if (validation.errors.length) fail('INVALID_PROJECT', protocol.formatReport(validation), 422);
    const worldOverride = project.cardFile.startsWith('world:') ? null : readJson(contained(project.dir, '.card-forge/bridge.json'))?.worldOverride;
    const nameOverride = project.cardFile.startsWith('world:') ? null : path.basename(project.cardFile, '.png');
    const built = this.assembleCard(scan, build, worldOverride, nameOverride);
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
    for (const [idStr, t] of remoteEntries) {
      const tSlot = remote.tavern.slots[`entry:${idStr}`];
      if (tSlot) tSlot.remoteEntry = t;
    }
    const entrySettings = {};
    for (const e of built.card.data?.character_book?.entries ?? []) {
      const key = `entry:${e.id}`;
      const nSlot = nodes.slots[key];
      const t = remoteEntries.get(String(e.id));
      const { content: ignored, ...nSettings } = e;
      // 顶层 position 只有 before_char/after_char 两个值；按深度插入（extensions.position 不是 0/1）时它没有意义，
      // card-forge 装卡写 before_char，酒馆世界书换算回来是 after_char，不算差异。真正的位置看 extensions.position。
      const byDepth = v => v !== undefined && v !== null && Number(v) !== 0 && Number(v) !== 1;
      if (byDepth(e.extensions?.position) && byDepth(t?.extensions?.position)) delete nSettings.position;
      const nSetHash = hashObject(nSettings);
      if (!t) continue;
      const { content: ignoredT, ...tSettings } = t;
      if (byDepth(e.extensions?.position) && byDepth(t.extensions?.position)) delete tSettings.position;
      const tSetHash = hashObject(tSettings);
      const names = settingDifferences(nSettings, t);
      entrySettings[key] = { node: nSetHash, tavern: tSetHash, clean: !names.length };
      if (names.length) {
        const baseSet = baseline?.settings?.[key];
        const canAutoSync = reliableBaseline(saved, project.cardFile) && baseSet && (
          (baseSet.node === nSetHash && baseSet.tavern !== tSetHash) ||
          (baseSet.tavern === tSetHash && baseSet.node !== nSetHash)
        );
        if (canAutoSync) {
          const dir = baseSet.node === nSetHash ? 'tavern' : 'project';
          if (nSlot) nSlot.settingsChanged = dir;
          if (remote.tavern.slots[key]) remote.tavern.slots[key].settingsChanged = dir;
        } else {
          issues.push({ kind: 'settings', key, message: `条目设置不同：${names.join('、')}` });
        }
      }
    }
    return { ...remote, ...local, nodes, baseline, baselineReliable: reliableBaseline(saved, project.cardFile), entrySettings, idAssignments, open, resolved, card: built.card, issues,
      revision: hashObject({ localHash: local.localHash, expected: remote.expected, operation, open: [...open], resolved: [...resolved] }) };
  }
  async writeBodies(project, snapshot, updates) {
    if (snapshot.localHash !== this.localSnapshot(project).localHash) fail('STALE_PREVIEW', '节点在准备写入时改变');
    const planned = { ...snapshot.rawFiles }, newFiles = new Set(), deleted = new Set();
    for (const assignment of snapshot.idAssignments ?? []) planned[assignment.relPath] = assignment.text;
    for (const { key, value, remoteEntry } of updates) {
      if (extrasLib.isExtraKey(key)) { await this.planExtra(project, snapshot, planned, newFiles, deleted, key, value); continue; }
      let rel = snapshot.nodes.slots[key]?.relPath?.replaceAll('\\', '/');
      // 酒馆里写了、本地还没有文件的字段：按新格式位置新建散文件（整文件就是正文）
      const field = !rel && key.startsWith('field:') ? key.slice(6) : null;
      if (field) {
        rel = field === 'first_mes' ? 'message/0.md' : `${field}.md`;
        if (planned[rel] !== undefined || fs.existsSync(contained(project.dir, rel))) fail('STALE_PREVIEW', `字段文件已存在：${rel}`);
        planned[rel] = value.replaceAll('\n', '\n') + '\n'; newFiles.add(rel); continue;
      }
      // 酒馆里新建的备选开场白：生成 message/<序号>.md
      if (!rel && key.startsWith('greeting:')) {
        const idx = Number(key.slice('greeting:'.length)) + 1;
        const num = String(idx).padStart(2, '0');
        rel = `message/${idx}.md`;
        if (planned[rel] !== undefined || fs.existsSync(contained(project.dir, rel))) fail('STALE_PREVIEW', `开场白文件已存在：${rel}`);
        const { unpack } = await this.libraries();
        const fm = { id: `greet-alt-${num}`, type: 'greeting', target: 'alternate_greetings', title: `备选${num}`, order: idx };
        planned[rel] = unpack.nodeText(fm, value, '酒馆实时同步');
        newFiles.add(rel);
        continue;
      }
      // 酒馆里新建的世界书条目：生成 world_book/<标题>.md
      if (!rel && key.startsWith('entry:') && remoteEntry) {
        const { unpack } = await this.libraries();
        const usedNames = new Set(
          Object.keys(planned)
            .filter(r => r.startsWith('world_book/') && r.endsWith('.md'))
            .map(r => path.basename(r, '.md').toLowerCase())
        );
        const stem = unpack.safeDirName(remoteEntry.comment || `wb-${remoteEntry.id}`, usedNames);
        rel = `world_book/${stem}.md`;
        if (planned[rel] !== undefined || fs.existsSync(contained(project.dir, rel))) fail('STALE_PREVIEW', `世界书条目文件已存在：${rel}`);
        const nodeId = `wb-${remoteEntry.id}`;
        const fm = unpack.buildEntryFrontmatter(remoteEntry, nodeId, { existingType: 'lore', displayIndex: remoteEntry.extensions?.display_index ?? -1 });
        planned[rel] = unpack.nodeText(fm, value, '酒馆实时同步');
        newFiles.add(rel);
        continue;
      }
      if (!rel || planned[rel] === undefined) fail('INVALID_SLOT', `没有节点：${key}`, 400);
      // 酒馆那边删了这条世界书条目：删掉本地对应的条目文件
      if (value === null && key.startsWith('entry:')) { delete planned[rel]; deleted.add(rel); continue; }
      let raw = planned[rel];
      // 没有开头设置的散文件：整文件就是正文，直接整体替换
      if (!/^\uFEFF?---\r?\n/.test(raw)) { const eol = raw.includes('\r\n') ? '\r\n' : '\n'; planned[rel] = value.replaceAll('\n', eol) + eol; continue; }
      if (remoteEntry && key.startsWith('entry:')) {
        const { unpack, YAML } = await this.libraries();
        const hasBom = raw.charCodeAt(0) === 0xfeff;
        const clean = hasBom ? raw.slice(1) : raw;
        const fmMatch = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fmMatch) {
          const existingNode = snapshot.nodes.slots[key]?.node;
          const nodeId = existingNode?.id ?? `wb-${remoteEntry.id}`;
          const existingType = existingNode?.type ?? 'lore';
          const displayIndex = snapshot.nodes.slots[key]?.displayIndex ?? -1;
          const newFm = unpack.buildEntryFrontmatter(remoteEntry, nodeId, { existingType, displayIndex });
          const eol = raw.includes('\r\n') ? '\r\n' : '\n';
          const head = YAML.stringify(newFm, { lineWidth: 0 }).trimEnd().replaceAll('\n', eol);
          raw = `${hasBom ? '\uFEFF' : ''}---${eol}${head}${eol}---${clean.slice(fmMatch[0].length)}`;
        }
      }
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
    const settings = { ...(snapshot.baseline?.settings ?? {}) };
    for (const [key, pair] of Object.entries(snapshot.entrySettings ?? {})) {
      if (pair.clean) settings[key] = { node: pair.node, tavern: pair.tavern };
    }
    if (clean) for (const key of Object.keys(settings)) if (!snapshot.nodes.slots[key]) delete settings[key];
    if (snapshot.baseline && hashObject(slots) === hashObject(snapshot.baseline.slots ?? {}) && hashObject(pending) === hashObject(snapshot.baseline.pending ?? {}) && hashObject(settings) === hashObject(snapshot.baseline.settings ?? {})) return;
    saveSyncState(project.dir, project.cardFile, slots, pending, Object.keys(settings).length ? settings : undefined);
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
  // 实时同步用：参与同步的文件、卡 PNG、绑定世界书的修改时间和大小。只看文件信息，不读正文
  changeStamp(project) {
    const info = file => { try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return null; } };
    const local = nodeFiles(project.dir).map(rel => [rel, info(contained(project.dir, rel))]);
    const bridge = info(contained(project.dir, '.card-forge/bridge.json'));
    let card = null, worldName = null;
    if (project.cardFile?.startsWith('world:')) worldName = project.cardFile.slice(6);
    else if (project.cardFile) {
      const file = path.join(this.userDir, 'characters', project.cardFile);
      card = info(file);
      try { worldName = readCardPng(file)?.data?.extensions?.world || null; } catch { worldName = null; }
    }
    const world = worldName ? info(worldFilePath(worldName, this.userDir)) : null;
    return hashObject({ local, bridge, card, worldName, world });
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
  // 新建卡（作者决定 2026-10-27）：按本地工程新建一张卡和一本世界书。卡文件名和世界书名重名时都起新名字，
  // 新卡不连酒馆里已有的同名世界书。只算名字，不写任何东西
  async planNewCard(project) {
    const libs = await this.libraries();
    const scan = await this.scanLocal(project, libs);
    const configured = this.assembleCard(scan, libs.build, null).card.data?.extensions?.world || null;
    const free = (base, taken) => { for (let i = 1; ; i++) { const name = i === 1 ? base : `${base} ${i}`; if (!taken.has(name.toLowerCase())) return name; } };
    const cards = new Set(this.listCards().map(c => c.name.toLowerCase()));
    const worlds = new Set(this.listWorlds().map(w => w.worldName.toLowerCase()));
    const cardFile = `${free(project.name, cards)}.png`;
    const worldName = configured ? free(configured, worlds) : null;
    return { cardFile, worldName, worldOverride: worldName && worldName !== configured ? worldName : null };
  }
  // 封面：工程里的 character.png，其次原来那张卡的图，都没有时用一张空白图
  coverOf(project) {
    const own = path.join(project.dir, 'character.png');
    const old = project.cardFile && !project.cardFile.startsWith('world:') ? [path.join(this.userDir, 'characters', project.cardFile), path.join(project.dir, '.card-forge', 'originals', project.cardFile)] : [];
    const found = [own, ...old].find(p => fs.existsSync(p));
    return found ? fs.readFileSync(found) : BLANK_PNG;
  }
  async createCard(project, jobId, plan) {
    const libs = await this.libraries();
    const scan = await this.scanLocal(project, libs);
    const validation = libs.protocol.validateNodes(scan);
    if (validation.errors.length) fail('INVALID_PROJECT', libs.protocol.formatReport(validation), 422);
    const card = this.assembleCard(scan, libs.build, plan.worldName, path.basename(plan.cardFile, '.png')).card;
    const pngBase64 = libs.png.embedChara(this.coverOf(project), card).toString('base64');
    const book = card.data?.character_book ?? { entries: [] };
    const result = await this.send(project, { id: jobId, op: 'create', avatar: plan.cardFile, pngBase64, worldName: plan.worldName, book });
    if (!result || result.fatal) fail('CREATE_FAILED', result?.fatal ?? '酒馆没有确认建卡', 502);
    if (result.avatar !== plan.cardFile) fail('CREATE_MISMATCH', `酒馆建卡后返回的文件名是 ${result.avatar}，不是 ${plan.cardFile}；需要核实`);
    return { cardFile: result.avatar, worldName: plan.worldName };
  }
  hasPendingOperation(project) { return fs.existsSync(this.operationFile(project)); }  async rename(project, jobId) {
    const snapshot = await this.snapshot(project);
    const result = await this.send(project, { id: jobId, op: 'rename', avatar: project.cardFile, newName: project.name, expected: snapshot.expected, expectedTargetAbsent: true }, snapshot);
    if (!result || result.fatal) fail('RENAME_FAILED', result?.fatal ?? '酒馆未确认改名', 502);
    segment(result.avatar, '返回的卡文件名');
    if (result.avatar !== `${project.name}.png`) fail('RENAME_MISMATCH', `酒馆返回了不同文件名 ${result.avatar}；需要核实绑定`);
    await this.setRoot(project, [[['name'], project.name]]);
    const file = contained(project.dir, '.card-forge/tavern-sync.json'), baseline = readJson(file);
    if (baseline?.cardFile === project.cardFile) atomicJson(file, { ...baseline, cardFile: result.avatar });
    return { cardFile: result.avatar };
  }
  async validateWorldProject(project, worldName) {
    await this.assertAvailable({ ...project, cardFile: `world:${worldName}` });
    const { nodes, build } = await this.libraries(), scan = await nodes.scanCard(project.dir);
    if (!scan.nodes.find(n => n.type === 'card')?.frontmatter?.book_only) fail('INVALID_PROJECT', '工程没有 book_only:true，不能绑定为独立书');
    const configured = build.assemble(scan).card.data?.extensions?.world;
    if (configured && configured !== worldName) fail('BINDING_CONFLICT', '工程世界书名与CLI目标不同');
    if (!fs.existsSync(worldFilePath(worldName, this.userDir))) fail('WORLD_NOT_FOUND', '世界书不存在；不能自动覆盖其他目标');
  }
  // 覆盖拆解时怎么处理旧工程：卡内容文件（与同步、装卡同一口径的 nodeFiles）按酒馆当前内容重新生成，
  // 其余文件（记录/、候选/、待归位/、note/、调研.md、封面等）原样搬进新工程。.card-forge/ 是同步记录，重新建立
  overwritePlan(dir) {
    const replace = new Set(nodeFiles(dir)), keep = [];
    const walk = rel => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const next = rel ? `${rel}/${e.name}` : e.name;
        if (!rel && e.name === '.card-forge') continue;
        if (e.isDirectory() && !e.isSymbolicLink()) walk(next);
        else if (!replace.has(next)) keep.push(next);
      }
    };
    walk('');
    const groups = new Map();
    for (const rel of keep) { const top = rel.includes('/') ? `${rel.split('/')[0]}/` : rel; groups.set(top, (groups.get(top) ?? 0) + 1); }
    return { replace: [...replace].sort(), keep: keep.sort(), keepGroups: [...groups].map(([path, files]) => ({ path, files })).sort((a, b) => a.path.localeCompare(b.path)) };
  }
  // 拆解：把酒馆里已有的卡第一次变成本地工程（作者决定 2026-10-27：拆解只做这件事，拆完自动连上）
  async attach(project, { overwrite = false, keep } = {}) {
    await this.assertAvailable(project);
    if (fs.existsSync(project.dir) && !overwrite) {
      const plan = this.overwritePlan(project.dir);
      fail('ATTACH_CONFLICT', '同名工程目录已存在；拒绝覆盖或自动接入', 409, { replaceCount: plan.replace.length, keepGroups: plan.keepGroups });
    }
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
      const staged = { ...project, dir: out, staging: true, finalDir: overwrite ? project.dir : null };
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
        // 不进卡的文件搬进新工程，再删旧目录。拆卡只写卡内容文件，两边不会撞名；撞了就停下，不覆盖
        for (const rel of this.overwritePlan(project.dir).keep) {
          const dst = contained(out, rel);
          if (fs.existsSync(dst)) fail('ATTACH_CONFLICT', `保留旧文件时与新拆出的文件同名：${rel}；没有覆盖`);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          copyTree(path.join(project.dir, rel), dst);
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
