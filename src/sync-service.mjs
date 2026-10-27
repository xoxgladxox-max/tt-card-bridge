import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverProjects, reservedTargets, targetOccupied, isSingleCardDirectory, sameProjectPath } from './projects.mjs';
import { SyncEngine } from './sync-engine.mjs';
import { SerialQueue, contained, segment, readJson, atomicJson, fail, hashObject } from './safety.mjs';

const compactDiff = diff => (!diff || typeof diff !== 'object' || !Array.isArray(diff.slots))
  ? diff
  : {
      revision: diff.revision,
      clean: diff.clean,
      issues: (diff.issues ?? []).slice(0, 20),
      changedSlots: diff.slots.filter(s => s.kind !== 'equal').slice(0, 30).map(({ key, label, kind, canResolve }) => ({ key, label, kind, canResolve })),
    };
const errorData = e => ({ code: e.code ?? 'INTERNAL', message: e.message, ...(e.details ? { details: compactDiff(e.details) } : {}) });
const compactResult = res => (!res || typeof res !== 'object')
  ? res
  : { ...res, ...(res.diff ? { diff: compactDiff(res.diff) } : {}) };
// service.json 的默认值。读取时先补缺、再逐字段校正，文件被手改坏或是旧版本写的都能用
// backupKeep：每张卡只保留最近几份备份，0 表示全部保留
export const DEFAULT_STATE = Object.freeze({ paused: true, pollIntervalMs: 2000, backupDir: '', autoBackupBeforeOverwrite: true, backupKeep: 5, activeCardFile: null, activeWorldName: null });
const validKeep = v => Number.isInteger(v) && v >= 0 && v <= 1000;
const text = v => typeof v === 'string' && v.trim() ? v.trim() : null;
export function normalizeState(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const poll = Number(s.pollIntervalMs);
  return {
    paused: typeof s.paused === 'boolean' ? s.paused : DEFAULT_STATE.paused,
    pollIntervalMs: Number.isInteger(poll) && poll >= 1000 && poll <= 60_000 ? poll : DEFAULT_STATE.pollIntervalMs,
    backupDir: typeof s.backupDir === 'string' ? s.backupDir.trim() : DEFAULT_STATE.backupDir,
    autoBackupBeforeOverwrite: typeof s.autoBackupBeforeOverwrite === 'boolean' ? s.autoBackupBeforeOverwrite : DEFAULT_STATE.autoBackupBeforeOverwrite,
    backupKeep: validKeep(s.backupKeep) ? s.backupKeep : DEFAULT_STATE.backupKeep,
    activeCardFile: text(s.activeCardFile),
    activeWorldName: text(s.activeWorldName),
  };
}
// 队列按卡分开：这些动作只占用各自那张卡的队列，其余（换目录、关后台、技能等）是全局任务
const queueKeyOf = body => {
  const pick = (() => {
    switch (body.action) {
      case 'attach': case 'scanCard': return typeof body.cardFile === 'string' ? body.cardFile.replace(/\.png$/i, '') : null;
      case 'attachWorld': return body.worldName;
      case 'check': case 'sync': case 'diff': case 'resolve': case 'bindWorld': case 'export': case 'importFromWorkspace':
      case 'detach': case 'backups': case 'restorePreview': case 'restore': case 'rebind': return body.projectId;
      default: return null;
    }
  })();
  return typeof pick === 'string' && pick.trim() ? pick.trim().toLowerCase() : null;
};
export class SyncService {
  constructor({ cardsRoot, runtimeRoot, adapter, now = () => Date.now(), onShutdown = null, onCardsRootChange = null }) {
    this.cardsRoot = path.resolve(cardsRoot); this.runtimeRoot = runtimeRoot; this.adapter = adapter; this.adapter.cardsRoot ??= this.cardsRoot; this.engine = new SyncEngine(adapter); this.now = now; this.onShutdown = onShutdown; this.onCardsRootChange = onCardsRootChange;
    this.stateFile = path.join(runtimeRoot, 'service.json');
    this.state = normalizeState(readJson(this.stateFile, {}));
    this.queue = new SerialQueue(); this.stableProjects = new Map(); this.logs = []; this.results = new Map(); this.previews = new Map(); this.timer = null; this.stopping = false;
  }
  // 工程连着的酒馆卡文件还在不在。玩家删卡重导后旧文件名会消失；适配器不会列卡时按存在处理
  cardExists(cardFile) {
    if (!cardFile || cardFile.startsWith('world:') || typeof this.adapter.listCards !== 'function') return true;
    const want = cardFile.toLowerCase();
    return this.adapter.listCards().some(c => c.cardFile.toLowerCase() === want);
  }
  cardMissing(p) {
    return p.attached && p.targetKind !== 'world' && !p.binding?.initializing && !p.pendingOperation && !this.cardExists(p.cardFile);
  }
  decorateProject(p) {
    const result = this.results.get(p.id) ?? null;
    const missing = this.cardMissing(p);
    return {
      ...p,
      status: p.pendingOperation ? p.pendingOperation.state === 'reviewRequired' ? 'reviewRequired' : 'operationPending' : p.restoreRequired ? 'restoreRequired' : missing ? 'cardMissing' : result?.error ? 'error' : !p.attached ? 'unattached' : result?.status ?? (p.paused ? 'paused' : 'unchecked'),
      ...(missing ? { missingCardFile: p.cardFile } : {}),
      lastResult: result,
    };
  }
  // 「合成并导入酒馆」的候选：工作区目录下的卡工程，连同只有 world_book/、message/ 的散文件工程。只在作者点按钮时用
  assembleProjects() {
    return discoverProjects(this.cardsRoot, { accept: isSingleCardDirectory }).map(p => this.decorateProject(p));
  }
  // 备份规则只在这里定，所有覆盖操作（自动同步、合成导入、拆卡覆盖、冲突处理、恢复）都走这一处：
  //   没有单独指定 → 按常驻设置。关闭常驻备份时已确认过一次（setAutoBackup），之后不再逐次确认
  //   这一次单独要求跳过备份 → 仍须这一次的确认
  backupOptions(body = {}) {
    if (typeof body.backupDir === 'string') { this.state.backupDir = body.backupDir.trim(); this.saveState(); }
    const explicit = body.skipBackup !== undefined;
    const skipBackup = explicit ? Boolean(body.skipBackup) : !this.state.autoBackupBeforeOverwrite;
    return {
      skipBackup,
      acceptDataLossRisk: explicit ? Boolean(body.acceptDataLossRisk) : skipBackup,
      backupDir: typeof body.backupDir === 'string' ? body.backupDir.trim() : (this.state.backupDir ?? ''),
      backupKeep: this.state.backupKeep,
    };
  }
  record(action, projectId, result) {
    const entry = { at: new Date(this.now()).toISOString(), action, projectId: projectId ?? null, ...compactResult(result) };
    const prev = this.logs.at(-1);
    if (prev && prev.action === entry.action && prev.projectId === entry.projectId && JSON.stringify({ ...prev, at: null }) === JSON.stringify({ ...entry, at: null })) {
      prev.at = entry.at;
      prev.repeat = (prev.repeat ?? 1) + 1;
      return;
    }
    this.logs.push(entry);
    if (this.logs.length > 50) this.logs.shift();
  }
  saveState() { atomicJson(this.stateFile, this.state); }
  bindingFile(dir) { return contained(dir, '.card-forge/bridge.json'); }
  projects() {
    const rawList = [...discoverProjects(this.cardsRoot)];
    const out = rawList.map(p => this.decorateProject(p));
    const counts = new Map();
    for (const p of out) for (const target of reservedTargets(p)) counts.set(target, (counts.get(target) ?? 0) + 1);
    for (const p of out) if (reservedTargets(p).some(target => counts.get(target) > 1)) { p.status = 'bindingConflict'; p.bindingConflict = true; }
    return out;
  }
  getProject(id, { attached = true, preferAssemble = false } = {}) {
    if (typeof id !== 'string') fail('INVALID_PROJECT', 'projectId 必须是卡名', 400);
    segment(id, '卡名');
    const pool = preferAssemble ? [...this.assembleProjects(), ...this.projects()] : [...this.projects(), ...this.assembleProjects()];
    const p = pool.find(item => item.id === id);
    if (!p) {
      contained(this.cardsRoot, id);
      fail('PROJECT_NOT_FOUND', '工程不存在', 404);
    }
    if (attached && !p.attached) fail('NOT_ATTACHED', '工程未接管；不会按同名卡自动绑定');
    if (p.bindingConflict) fail('BINDING_CONFLICT', '多个工程绑定同一张酒馆卡；先解除重复绑定');
    return p;
  }
  publicProject({ dir, bindingConflict, binding, projectName, ...project }) { return project; }
  writeBinding(project, patch) {
    const file = this.bindingFile(project.dir);
    atomicJson(file, { projectKey: crypto.randomUUID(), projectName: project.name ?? path.basename(project.dir), ...readJson(file, {}), cardFile: project.cardFile, paused: project.paused, ...patch });
  }
  async status() {
    const projects = this.projects(), attached = new Set(projects.flatMap(reservedTargets));
    const assembleProjects = this.assembleProjects();
    // 只报告世界书编辑器里当前打开的那一本，不列出酒馆里的全部卡或全部世界书
    const worldName = this.state.activeWorldName ?? null;
    const worldProject = worldName ? projects.find(p => p.cardFile && p.cardFile.toLowerCase() === `world:${worldName}`.toLowerCase()) : null;
    const activeWorld = worldName ? { worldName, exists: (this.adapter.listWorlds?.() ?? []).some(w => w.worldName.toLowerCase() === worldName.toLowerCase()), attached: attached.has(`world:${worldName}`.toLowerCase()), projectId: worldProject?.id ?? null } : null;
    return { running: !this.stopping, capabilities: { restoreMode: this.adapter.restoreMode ?? null }, paused: this.state.paused, cardsRoot: this.cardsRoot, backupDir: this.state.backupDir ?? '', autoBackupBeforeOverwrite: this.state.autoBackupBeforeOverwrite !== false, backupKeep: this.state.backupKeep, activeCardFile: this.state.activeCardFile ?? null, activeWorld, pollIntervalMs: this.state.pollIntervalMs, currentTask: this.queue.current, queuedTasks: this.queue.size,
      projects: projects.map(p => this.publicProject(p)), assembleProjects: assembleProjects.map(p => this.publicProject(p)), logs: [...this.logs] };
  }
  preview(type, project, data) {
    for (const [id, p] of this.previews) if (p.expiresAt <= this.now()) this.previews.delete(id);
    while (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value);
    const previewId = crypto.randomUUID(), expiresAt = this.now() + 5 * 60_000;
    this.previews.set(previewId, { type, projectId: project.id, expiresAt, ...data });
    return { previewId, expiresAt };
  }
  takePreview(id, type, project) {
    const p = this.previews.get(id);
    if (!p || p.type !== type || p.projectId !== project.id || p.expiresAt <= this.now()) fail('STALE_PREVIEW', '预览不存在或已过期');
    return p;
  }
  async perform(project, options = {}) {
    if (project.restoreRequired) fail('RESTORE_REQUIRED', '恢复未完整完成；禁止同步，先重新执行完整恢复');
    if (this.cardMissing(project)) fail('CARD_MISSING', `原来连的「${project.cardFile}」已不在酒馆里（可能被删掉或重新导入时换了文件名）；在面板点「改连当前打开的卡」`, 409, { missingCardFile: project.cardFile });
    try {
      const result = compactResult(await this.engine.run(project, options));
      const prev = this.results.get(project.id);
      this.results.set(project.id, result);
      if (!options.automatic || result.changed || prev?.status !== result.status) this.record('sync', project.id, result);
      return { projectId: project.id, ...result };
    } catch (e) {
      const err = errorData(e);
      this.results.set(project.id, { status: 'error', error: err });
      this.record('sync', project.id, { error: err });
      throw e;
    }
  }
  async mirrorProject(project) {
    if (project.bindingConflict) fail('BINDING_CONFLICT', '同一目标存在多个绑定');
    if (project.detached || project.paused) return { projectId: project.id, status: 'paused' };
    if (project.binding.operation) fail('OPERATION_PENDING', '上次建卡/改名未完整确认；不会重复执行');
    // 自动同步永远不建卡、不补 card.md：建卡只在作者点「合成并导入酒馆」时发生
    if (!project.attached) return { projectId: project.id, status: 'unattached' };
    // 连着的卡已经不在：只记一次，不再每轮重复报错，等作者改连
    if (this.cardMissing(project)) {
      const prev = this.results.get(project.id);
      const result = { status: 'cardMissing', missingCardFile: project.cardFile };
      this.results.set(project.id, result);
      if (prev?.status !== 'cardMissing') this.record('cardMissing', project.id, { cardFile: project.cardFile });
      return { projectId: project.id, ...result };
    }
    if (project.binding.initializing) {
      if (!project.binding.initializeExpected) fail('OPERATION_PENDING', '首次建卡尚未确认，不能重复创建');
      const result = await this.perform(project, { initializeExpected: project.binding.initializeExpected });
      this.writeBinding(project, { initializing: false, initializeExpected: null });
      return result;
    }
    if (project.targetKind !== 'world' && project.name !== project.projectName) {
      const target = `${project.name}.png`;
      if (this.adapter.listCards().some(c => c.cardFile.toLowerCase() === target.toLowerCase())) fail('RENAME_CONFLICT', '改名目标已存在；没有覆盖或重新建卡');
      const id = crypto.randomUUID(); this.writeBinding(project, { operation: { id, kind: 'rename', targetCardFile: target } });
      const renamed = await this.adapter.rename(project, id);
      this.writeBinding(project, { cardFile: renamed.cardFile, projectName: project.name, operation: null });
      if (this.state.activeCardFile && this.state.activeCardFile.toLowerCase() === project.cardFile.toLowerCase()) { this.state.activeCardFile = renamed.cardFile; this.saveState(); }
      this.record('rename', project.id, renamed); project = this.getProject(project.id);
      if (this.adapter.localRevision) this.stableProjects.set(project.id, this.adapter.localRevision(project));
    }
    if (this.adapter.localRevision) {
      const revision = this.adapter.localRevision(project);
      if (this.stableProjects.get(project.id) !== revision) { this.stableProjects.set(project.id, revision); return { projectId: project.id, status: 'waitingForStableFiles' }; }
    }
    const result = await this.perform(project, { automatic: true });
    if (this.adapter.localRevision) this.stableProjects.set(project.id, this.adapter.localRevision(project));
    return result;
  }
  // 酒馆里当前打开的卡和世界书编辑器里当前打开的世界书对应的工程；没有就是空列表
  activeTargets() {
    const wanted = [this.state.activeCardFile, this.state.activeWorldName ? `world:${this.state.activeWorldName}` : null].filter(Boolean).map(x => x.toLowerCase());
    if (!wanted.length) return [];
    return this.projects().filter(p => p.attached && !p.detached && p.cardFile && wanted.includes(p.cardFile.toLowerCase()));
  }
  async batch(action, projectId, automatic = false, options = {}) {
    // 自动同步只管作者在酒馆里打开的那张卡（和打开的那本独立世界书）；手动操作必须指定一张卡，不接受“全部”
    if (!automatic && !projectId) fail('PROJECT_REQUIRED', '必须指定一张卡；不会批量处理全部工程', 400);
    const targets = automatic ? this.activeTargets().filter(t => !projectId || t.id === projectId) : [this.getProject(projectId)];
    const results = [];
    for (const target of targets) {
      // Pause is read between cards, never by killing an in-flight operation.
      if (automatic && (this.state.paused || this.stopping)) break;
      try {
        const p = automatic ? this.projects().find(p => p.id === target.id) : this.getProject(target.id);
        if (!p || (automatic && (p.paused || p.restoreRequired))) continue;
        if (automatic) results.push(await this.mirrorProject(p));
        else if (action === 'check') {
          const diff = await this.engine.inspect(p); this.results.set(p.id, { status: diff.clean ? 'clean' : 'differences', diff: compactDiff(diff) }); results.push({ projectId: p.id, diff });
        } else results.push(await this.perform(p, options));
      }
      catch (e) { const result = { projectId: target.id, status: 'error', error: errorData(e) }; this.results.set(target.id, result); this.record(action, target.id, { error: errorData(e) }); results.push(result); }
    }
    return { results };
  }
  async control(body) {
    if (!body || typeof body.action !== 'string') fail('INVALID_ACTION', '缺少 action', 400);
    // A pause request is immediate. All other operations join one queue; no forced cancellation.
    if (body.action === 'pause' || body.action === 'resume') {
      this.state.paused = body.action === 'pause'; this.saveState(); this.record(body.action, null, {}); return this.status();
    }
    if (body.action === 'followCard') {
      // 只记住作者当前打开了哪张卡、哪本世界书；不读写其他卡的文件夹
      const cardFile = typeof body.cardFile === 'string' && body.cardFile.trim() ? body.cardFile.trim() : null;
      this.state.activeCardFile = cardFile;
      if (body.worldName !== undefined) this.state.activeWorldName = typeof body.worldName === 'string' && body.worldName.trim() ? body.worldName.trim() : null;
      const active = this.activeTargets();
      const activeCard = active.find(p => p.targetKind !== 'world') ?? null;
      // 旧版切卡时会把其他卡写成暂停；切回来时只解开当前这张（恢复未完成的不动）
      if (activeCard?.paused && !activeCard.restoreRequired) this.writeBinding(activeCard, { paused: false });
      this.saveState();
      this.record('followCard', activeCard?.id ?? null, { cardFile });
      return this.status();
    }
    if (body.action === 'setAutoBackup') {
      if (typeof body.enabled !== 'boolean') fail('INVALID_ACTION', 'enabled 必须是布尔值', 400);
      if (body.enabled === false && body.acceptDataLossRisk !== true) {
        fail('CONFIRMATION_REQUIRED', '关闭自动备份前必须确认自行承担直接覆盖的数据丢失责任', 400);
      }
      this.state.autoBackupBeforeOverwrite = body.enabled;
      this.saveState();
      this.record('setAutoBackup', null, { enabled: body.enabled });
      return { autoBackupBeforeOverwrite: this.state.autoBackupBeforeOverwrite };
    }
    if (body.action === 'setBackupKeep') {
      if (!validKeep(body.keep)) fail('INVALID_ACTION', 'keep 必须是 0～1000 的整数（0 表示全部保留）', 400);
      this.state.backupKeep = body.keep;
      this.saveState();
      this.record('setBackupKeep', null, { keep: body.keep });
      return { backupKeep: this.state.backupKeep };
    }
    if (body.action === 'projectPause') {
      if (typeof body.paused !== 'boolean') fail('INVALID_ACTION', 'paused 必须是布尔值', 400);
      const p = this.getProject(body.projectId);
      if (!body.paused && p.restoreRequired) fail('RESTORE_REQUIRED', '完整恢复未完成，不能恢复自动同步');
      this.writeBinding(p, { paused: body.paused }); return this.publicProject(this.getProject(p.id));
    }
    return this.queue.run({ action: body.action, projectId: body.projectId ?? null }, async () => {
      switch (body.action) {
        case 'check': return this.batch('check', body.projectId);
        case 'sync': {
          const direction = body.direction ?? 'both';
          if (!['both', 'push', 'pull'].includes(direction) || (body.force !== undefined && typeof body.force !== 'boolean')) fail('INVALID_ACTION', 'direction/force 无效', 400);
          return this.batch('sync', body.projectId, false, { direction, force: body.force ?? false, ...this.backupOptions(body) });
        }
        case 'diff': {
          const p = this.getProject(body.projectId), diff = await this.engine.inspect(p);
          return { projectId: p.id, ...diff, ...this.preview('diff', p, { revision: diff.revision }) };
        }
        case 'resolve': {
          const p = this.getProject(body.projectId), preview = this.takePreview(body.previewId, 'diff', p);
          if (!Array.isArray(body.choices) || !body.choices.length) fail('INVALID_CHOICE', '请提供明确正文决定', 400);
          const result = await this.perform(p, { previewRevision: preview.revision, choices: body.choices, ...this.backupOptions(body) });
          this.previews.delete(body.previewId); return result;
        }
        case 'bindWorld': {
          segment(body.worldName, '世界书名');
          const id = body.projectId;
          segment(id, '卡名');
          const p = this.projects().find(p => p.id === id);
          if (!p) fail('PROJECT_NOT_FOUND', '工程不存在', 404);
          const target = `world:${body.worldName}`;
          if (p.cardFile && p.cardFile !== target) fail('BINDING_CONFLICT', '工程已有不同绑定');
          await this.adapter.validateWorldProject(p, body.worldName);
          this.writeBinding({ ...p, cardFile: target }, { detached: false }); return this.publicProject(this.getProject(id));
        }
        case 'attach': {
          segment(body.cardFile, '卡文件名');
          if (!/\.png$/i.test(body.cardFile)) fail('INVALID_CARD', '只接入 PNG 卡', 400);
          const name = body.cardFile.slice(0, -4); segment(name, '卡名');
          const id = name, p = { id, dir: contained(this.cardsRoot, id), cardFile: body.cardFile, paused: false };
          if (this.projects().some(other => (!body.overwrite || other.id !== id) && targetOccupied(other, body.cardFile))) fail('ATTACH_CONFLICT', '卡已由其他工程接管');
          // keep：拆前清单里选了“留在卡里”的项；结果记进这张卡自己的 bridge.json
          const keep = Array.isArray(body.keep) ? body.keep.map(String) : undefined;
          const attachRes = await this.adapter.attach(p, { overwrite: Boolean(body.overwrite), ...this.backupOptions(body), ...(keep ? { keep } : {}) });
          this.writeBinding(p, { detached: false, paused: false, ...(keep ? { extrasKeep: keep } : {}) });
          this.record('attach', id, { cardFile: p.cardFile });
          return { ...this.publicProject(this.getProject(id)), ...(attachRes?.roundTrip ? { roundTrip: attachRes.roundTrip } : {}) };
        }
        case 'scanCard': {
          segment(body.cardFile, '卡文件名');
          if (!this.adapter.scanCard) fail('UNSUPPORTED_ACTION', '当前适配器不支持拆前扫描', 501);
          const res = this.adapter.scanCard(body.cardFile);
          const own = this.projects().find(p => p.cardFile && p.cardFile.toLowerCase() === body.cardFile.toLowerCase());
          const saved = own?.binding?.extrasKeep;
          if (Array.isArray(saved)) for (const item of res.items) item.split = !saved.includes(item.key);
          return res;
        }
        case 'rebind': {
          // 改连：把工程改为连接酒馆里另一张已有的卡（玩家删卡重导后文件名变了）。只改绑定，不写卡、不写工程正文；
          // 旧同步记录记的是旧文件名，换了目标后自动失效。两边一致就建立新记录，不一致只列差异交作者选
          segment(body.cardFile, '卡文件名');
          if (!/\.png$/i.test(body.cardFile)) fail('INVALID_CARD', '只能改连 PNG 卡', 400);
          const p = this.getProject(body.projectId, { attached: false });
          if (p.targetKind === 'world') fail('INVALID_ACTION', '独立世界书工程不能改连到角色卡', 400);
          if (p.pendingOperation || p.restoreRequired || p.binding?.initializing) fail('OPERATION_PENDING', '工程还有未完成的操作；不能改连');
          if (!this.cardExists(body.cardFile)) fail('CARD_NOT_FOUND', `酒馆里没有「${body.cardFile}」`, 404);
          if (this.projects().some(o => !sameProjectPath(o.dir, p.dir) && targetOccupied(o, body.cardFile))) fail('ATTACH_CONFLICT', '这张卡已由其他工程连着；先解除那边的绑定');
          const from = p.cardFile;
          // projectName 取文件夹名：改连不触发自动改名
          this.writeBinding({ ...p, cardFile: body.cardFile }, { detached: false, paused: false, projectName: p.name });
          this.results.delete(p.id);
          this.stableProjects.delete(p.id);
          this.record('rebind', p.id, { from, cardFile: body.cardFile });
          const refreshed = this.getProject(p.id);
          const diff = await this.engine.inspect(refreshed);
          if (diff.clean) {
            const result = await this.perform(refreshed, {});
            return { project: this.publicProject(this.getProject(p.id)), from, clean: true, sync: result };
          }
          this.results.set(p.id, { status: 'differences', diff: compactDiff(diff) });
          return { project: this.publicProject(this.getProject(p.id)), from, clean: false, diff: compactDiff(diff) };
        }
        case 'attachWorld': {
          segment(body.worldName, '世界书名');
          const target = `world:${body.worldName}`;
          const id = body.worldName, p = { id, dir: contained(this.cardsRoot, id), cardFile: target, paused: false };
          if (this.projects().some(other => (!body.overwrite || other.id !== id) && targetOccupied(other, target))) fail('ATTACH_CONFLICT', '世界书已由其他工程接管');
          await this.adapter.attach(p, { overwrite: Boolean(body.overwrite), ...this.backupOptions(body) });
          this.writeBinding(p, { detached: false, paused: false });
          this.record('attachWorld', id, { cardFile: target }); return this.publicProject(this.getProject(id));
        }
        case 'setBackupDir': {
          if (typeof body.backupDir !== 'string') fail('INVALID_BACKUP_DIR', 'backupDir 必须是字符串', 400);
          this.state.backupDir = body.backupDir.trim();
          this.saveState();
          this.record('setBackupDir', null, { backupDir: this.state.backupDir });
          return { backupDir: this.state.backupDir };
        }
        case 'skillsStatus': {
          if (!this.adapter.skillsStatus) fail('UNSUPPORTED_ACTION', '当前适配器不支持技能检查', 501);
          const res = await this.adapter.skillsStatus();
          this.record('skillsStatus', null, { count: res.skills?.length ?? 0 });
          return res;
        }
        case 'skillsDeploy': {
          if (!this.adapter.skillsDeploy) fail('UNSUPPORTED_ACTION', '当前适配器不支持技能与Agent同步', 501);
          const res = await this.adapter.skillsDeploy(this.backupOptions(body));
          this.record('skillsDeploy', null, { ok: res.ok, backupSkipped: res.backupSkipped });
          return res;
        }
        case 'export': {
          if (body.outDir !== undefined && typeof body.outDir !== 'string') fail('INVALID_EXPORT_DIR', 'outDir 必须是字符串', 400);
          const p = this.getProject(body.projectId);
          const result = await this.adapter.exportProject(p, body.outDir);
          this.record('export', p.id, { outDir: result.outDir });
          return { projectId: p.id, ...result };
        }
        case 'importFromWorkspace': {
          const assembleList = this.assembleProjects();
          const targetId = (typeof body.projectId === 'string' && body.projectId.trim())
            ? body.projectId.trim()
            : (assembleList.length === 1 ? assembleList[0].id : '');
          const p = this.getProject(targetId, { attached: false, preferAssemble: true });
          const backupOpts = this.backupOptions(body);
          // 连着的卡已被删掉：按未连接处理，重新找同名卡或新建，不去读已不存在的旧文件
          const attachedLive = p.attached && !this.cardMissing(p);
          let initializeExpected = null;
          if (!attachedLive) {
            if (p.targetKind === 'world') {
              const target = `world:${p.name}`;
              this.writeBinding({ ...p, cardFile: target }, { detached: false, paused: false });
            } else {
              const preparedInfo = await this.adapter.prepareNew(p, { embedWorld: true, allowExistingWorld: true });
              let cardTitle = preparedInfo?.cardName || p.name;
              const explicitWorld = preparedInfo?.explicitWorld || null;
              const allCards = this.adapter.listCards();
              const existingCardByTitle = allCards.find(c => c.cardFile.toLowerCase() === `${cardTitle}.png`.toLowerCase());
              const existingCardByFolder = allCards.find(c => c.cardFile.toLowerCase() === `${p.name}.png`.toLowerCase());
              const existingCard = existingCardByTitle ?? existingCardByFolder ?? null;
              const worldExists = explicitWorld && (this.adapter.listWorlds?.() ?? []).some(w => w.worldName.toLowerCase() === explicitWorld.toLowerCase());
              let worldOverride = null;

              if (existingCard || worldExists) {
                if (!body.overwrite && !body.createNewCopy) {
                  const reasons = [];
                  if (existingCard) reasons.push(`同名角色卡「${existingCard.cardFile.slice(0, -4)}」`);
                  if (worldExists) reasons.push(`同名世界书「${explicitWorld}」`);
                  fail('ATTACH_CONFLICT', `酒馆已存在${reasons.join('与')}；可选择「覆盖现有」或「新建副本（自动加编号）」导入`, 409);
                }
                if (body.createNewCopy) {
                  // 按酒馆自己的去重规则取新名：卡文件名末尾接数字（示例卡1、示例卡2…），世界书接「 (n)」。
                  // 新名只记在 .card-forge/bridge.json，不改工程的 card.md。角色显示名仍用 card.md 里的 name。
                  if (existingCard) {
                    const used = new Set(allCards.map(c => c.cardFile.toLowerCase()));
                    let i = 1;
                    while (used.has(`${cardTitle}${i}.png`.toLowerCase())) i++;
                    cardTitle = `${cardTitle}${i}`;
                  }
                  if (worldExists) {
                    const usedWorlds = new Set((this.adapter.listWorlds?.() ?? []).map(w => w.worldName.toLowerCase()));
                    let i = 1;
                    while (usedWorlds.has(`${explicitWorld} (${i})`.toLowerCase())) i++;
                    worldOverride = `${explicitWorld} (${i})`;
                  }
                } else if (body.overwrite) {
                  for (const other of this.projects()) {
                    if (!sameProjectPath(other.dir, p.dir) && targetOccupied(other, existingCard ? existingCard.cardFile : `${cardTitle}.png`)) {
                      if (other.pendingOperation || other.restoreRequired || other.binding?.operation) {
                        fail('ATTACH_CONFLICT', '该酒馆角色卡仍有其他工程的未完成操作占用');
                      }
                      this.writeBinding(other, { detached: true, paused: true });
                    }
                  }
                }
              }

              const candidateFile = (body.createNewCopy || !existingCard) ? `${cardTitle}.png` : existingCard.cardFile;
              if (existingCard && !body.createNewCopy) {
                this.writeBinding({ ...p, cardFile: candidateFile }, { detached: false, paused: false, projectName: p.name });
              } else {
                const jobId = crypto.randomUUID();
                const creating = { ...p, name: cardTitle.replace(/\.png$/i, ''), cardFile: candidateFile, attached: true };
                this.writeBinding(creating, { detached: false, paused: false, projectName: p.name, initializing: true, worldOverride, operation: { id: jobId, kind: 'create', targetCardFile: candidateFile } });
                const avatar = await this.adapter.create(creating, jobId, { displayName: preparedInfo?.cardName || p.name });
                this.writeBinding(creating, { cardFile: avatar, projectName: p.name, operation: null });
                const snap = await this.adapter.snapshot({ ...creating, cardFile: avatar });
                initializeExpected = snap.expected;
                this.writeBinding(creating, { cardFile: avatar, projectName: p.name, initializing: false, initializeExpected: null });
              }
            }
          } else {
            await this.adapter.prepareNew(p, { embedWorld: true, allowExistingWorld: true });
            if (p.paused && !p.restoreRequired) {
              this.writeBinding(p, { paused: false });
            }
          }
          const refreshed = this.getProject(p.id, { preferAssemble: true });
          const syncRes = await this.perform(refreshed, {
            ...(initializeExpected ? { initializeExpected } : { force: true, direction: 'push' }),
            replaceRemote: Boolean((body.overwrite && !body.createNewCopy) || attachedLive),
            ...backupOpts,
          });
          this.record('importFromWorkspace', refreshed.id, { status: syncRes.status });
          return { project: this.publicProject(this.getProject(p.id, { preferAssemble: true })), sync: syncRes };
        }
        case 'setCardsRoot': {
          if (typeof body.cardsRoot !== 'string' || !body.cardsRoot.trim()) fail('INVALID_CARDS_ROOT', '请填写有效的工作区目录路径', 400);
          if (this.projects().some(p => p.pendingOperation || p.binding?.operation)) fail('OPERATION_PENDING', '当前目录仍有未决写入任务，不能切换工作区目录');
          const resolved = path.resolve(body.cardsRoot.trim());
          if (this.adapter.userDir && resolved.toLowerCase() === path.resolve(this.adapter.userDir).toLowerCase()) fail('INVALID_CARDS_ROOT', '工作区目录不能指向酒馆用户数据目录', 400);
          if (isSingleCardDirectory(resolved)) fail('INVALID_CARDS_ROOT', `「${path.basename(resolved)}」本身是单张卡目录，工作区目录请填写它的上一级目录（${path.dirname(resolved)}）`, 400);
          fs.mkdirSync(resolved, { recursive: true });
          this.cardsRoot = resolved;
          this.adapter.cardsRoot = resolved;
          this.stableProjects.clear();
          this.results.clear();
          this.previews.clear();
          this.onCardsRootChange?.(resolved);
          this.record('setCardsRoot', null, { cardsRoot: resolved });
          return { cardsRoot: resolved };
        }
        case 'shutdown': {
          this.stopping = true; clearTimeout(this.timer);
          this.record('shutdown', null, {});
          setTimeout(() => this.onShutdown?.(), 50);
          return { stopping: true };
        }
        case 'detach': {
          const p = this.getProject(body.projectId); await this.adapter.assertAvailable?.(p);
          if (p.pendingOperation || p.restoreRequired || p.binding.initializing) fail('OPERATION_PENDING', '目标仍被未决操作占用；不能解除绑定');
          this.writeBinding(p, { detached: true, paused: true }); this.record('detach', p.id, {}); return { detached: true };
        }
        case 'config': {
          if (Object.keys(body).some(k => !['action', 'pollIntervalMs'].includes(k))) fail('INVALID_CONFIG', 'HTTP 不接受目录、命令或额外配置', 400);
          if (!Number.isInteger(body.pollIntervalMs) || body.pollIntervalMs < 1000 || body.pollIntervalMs > 60_000) fail('INVALID_CONFIG', 'pollIntervalMs 必须为1000～60000整数', 400);
          this.state.pollIntervalMs = body.pollIntervalMs; this.saveState(); return { pollIntervalMs: this.state.pollIntervalMs };
        }
        case 'backups': { const p = this.getProject(body.projectId); return { backups: this.adapter.backups(p) }; }
        case 'restorePreview': {
          const p = this.getProject(body.projectId), backup = this.adapter.readBackup(p, body.backupId), snapshot = await this.adapter.snapshot(p);
          if (!backup.pngBase64) fail('UNSUPPORTED_BACKUP', '备份缺少完整 PNG');
          return { ...this.preview('restore', p, { revision: snapshot.revision, backupId: body.backupId, checksum: hashObject(backup) }), backupId: body.backupId, cardFile: p.cardFile, files: Object.keys(backup.nodes), requiresConfirmation: true, ...this.adapter.restoreSupport(p, backup, snapshot.worldName) };
        }
        case 'restore': {
          if (body.confirm !== true) fail('CONFIRMATION_REQUIRED', '恢复必须显式 confirm:true', 400);
          const p = this.getProject(body.projectId), preview = this.takePreview(body.previewId, 'restore', p), backup = this.adapter.readBackup(p, preview.backupId);
          if (preview.checksum !== hashObject(backup)) fail('STALE_PREVIEW', '备份内容改变，请重新预览');
          const snapshot = await this.adapter.snapshot(p);
          if (snapshot.revision !== preview.revision) fail('STALE_PREVIEW', '工程或酒馆在预览后改变');
          const support = this.adapter.restoreSupport(p, backup, snapshot.worldName);
          if (!support.canRestore) fail('UNSUPPORTED_RESTORE', support.blockedReason);
          this.writeBinding(p, { paused: true, restoreRequired: true });
          try {
            const result = await this.adapter.restore(p, backup, preview.revision, this.backupOptions(body));
            this.writeBinding(p, { paused: true, restoreRequired: false }); this.results.set(p.id, result); this.previews.delete(body.previewId); this.record('restore', p.id, result); return result;
          } catch (e) { this.record('restore', p.id, { error: errorData(e) }); throw e; }
        }
        default: fail('INVALID_ACTION', '未知动作', 400);
      }
    }, queueKeyOf(body));
  }
  start() {
    const tick = async () => {
      if (this.stopping) return;
      if (!this.state.paused) {
        // 每张当前打开的卡各自排队；这张卡上一轮还没做完就跳过，不堆积
        const jobs = [];
        try {
          for (const target of this.activeTargets()) {
            const key = target.id.toLowerCase();
            if (this.queue.busy(key)) continue;
            jobs.push(this.queue.run({ action: 'automatic', projectId: target.id }, () => this.batch('sync', target.id, true), key)
              .catch(e => this.record('automatic', target.id, { error: errorData(e) })));
          }
        } catch (e) { this.record('automatic', null, { error: errorData(e) }); }
        await Promise.all(jobs);
      }
      if (!this.stopping) this.timer = setTimeout(tick, this.state.pollIntervalMs);
    };
    this.timer = setTimeout(tick, this.state.pollIntervalMs);
  }
  async stop() { this.stopping = true; clearTimeout(this.timer); await this.queue.tail; }
}
