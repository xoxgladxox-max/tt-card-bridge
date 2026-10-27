import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverProjects, reservedTargets, targetOccupied, isSingleCardDirectory, sameProjectPath } from './projects.mjs';
import { SyncEngine } from './sync-engine.mjs';
import { SerialQueue, contained, segment, readJson, atomicJson, fail } from './safety.mjs';

const compactDiff = diff => (!diff || typeof diff !== 'object' || !Array.isArray(diff.slots))
  ? diff
  : {
      revision: diff.revision,
      clean: diff.clean,
      issues: (diff.issues ?? []).slice(0, 20),
      changedSlots: diff.slots.filter(s => s.kind !== 'equal').slice(0, 30).map(({ key, label, kind }) => ({ key, label, kind })),
    };
const errorData = e => ({ code: e.code ?? 'INTERNAL', message: e.message, ...(e.details ? { details: compactDiff(e.details) } : {}) });
const compactResult = res => (!res || typeof res !== 'object')
  ? res
  : { ...res, ...(res.diff ? { diff: compactDiff(res.diff) } : {}) };
// service.json 的默认值。读取时先补缺、再逐字段校正，文件被手改坏或是旧版本写的都能用（旧版的备份、轮询设置直接忽略）
export const DEFAULT_STATE = Object.freeze({ paused: true, activeCardFile: null, activeWorldName: null });
const text = v => typeof v === 'string' && v.trim() ? v.trim() : null;
export function normalizeState(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    paused: typeof s.paused === 'boolean' ? s.paused : DEFAULT_STATE.paused,
    activeCardFile: text(s.activeCardFile),
    activeWorldName: text(s.activeWorldName),
  };
}
// 实时同步（作者 2026-10-27「最好实时」）：文件变化后等 DEBOUNCE_MS 没有新变化就同步；
// 每 FALLBACK_MS 比一次修改时间和大小，补上系统漏掉的通知
export const DEBOUNCE_MS = 500;
export const FALLBACK_MS = 5000;
// 连着时遇到这些情况不能自动同步：按断开处理，只给「以本地为准覆盖」「新建卡」两个选择
const RECONNECT_CODES = new Set(['CONFLICT', 'UNSUPPORTED_DIFFERENCE', 'TAVERN_CHANGED']);
// 队列按卡分开：这些动作只占用各自那张卡的队列，其余（换目录、关后台、技能等）是全局任务
const PROJECT_ACTIONS = new Set(['check', 'sync', 'bindWorld', 'export', 'detach', 'connect', 'reconnectOverwrite', 'reconnectNew']);
const queueKeyOf = body => {
  const pick = body.action === 'attach' || body.action === 'scanCard'
    ? (typeof body.cardFile === 'string' ? body.cardFile.replace(/\.png$/i, '') : null)
    : body.action === 'attachWorld' ? body.worldName
    : PROJECT_ACTIONS.has(body.action) ? body.projectId : null;
  return typeof pick === 'string' && pick.trim() ? pick.trim().toLowerCase() : null;
};
const defaultWatch = (target, options, listener) => fs.watch(target, options, listener);

export class SyncService {
  constructor({ cardsRoot, runtimeRoot, adapter, now = () => Date.now(), onShutdown = null, onCardsRootChange = null, watch = defaultWatch, debounceMs = DEBOUNCE_MS, fallbackMs = FALLBACK_MS }) {
    this.cardsRoot = path.resolve(cardsRoot); this.runtimeRoot = runtimeRoot; this.adapter = adapter; this.adapter.cardsRoot ??= this.cardsRoot; this.engine = new SyncEngine(adapter); this.now = now; this.onShutdown = onShutdown; this.onCardsRootChange = onCardsRootChange;
    this.stateFile = path.join(runtimeRoot, 'service.json');
    this.state = normalizeState(readJson(this.stateFile, {}));
    this.queue = new SerialQueue(); this.logs = []; this.results = new Map(); this.live = new Set(); this.stopping = false;
    this.watch = watch; this.debounceMs = debounceMs; this.fallbackMs = fallbackMs;
    this.watchers = new Map(); this.debounce = new Map(); this.stamps = new Map(); this.fallbackTimer = null;
  }
  // 工程连着的酒馆卡文件还在不在。玩家删卡重导后旧文件名会消失；适配器不会列卡时按存在处理
  cardExists(cardFile) {
    if (!cardFile || cardFile.startsWith('world:') || typeof this.adapter.listCards !== 'function') return true;
    const want = cardFile.toLowerCase();
    return this.adapter.listCards().some(c => c.cardFile.toLowerCase() === want);
  }
  cardMissing(p) {
    return p.attached && p.targetKind !== 'world' && !p.pendingOperation && !this.cardExists(p.cardFile);
  }
  decorateProject(p) {
    const result = this.results.get(p.id) ?? null;
    const missing = this.cardMissing(p);
    return {
      ...p,
      status: p.pendingOperation ? p.pendingOperation.state === 'reviewRequired' ? 'reviewRequired' : 'operationPending' : missing ? 'cardMissing' : !p.attached ? 'unattached' : result?.status ?? (p.paused ? 'paused' : 'unchecked'),
      ...(missing ? { missingCardFile: p.cardFile } : {}),
      lastResult: result,
    };
  }
  // 工作区下拉框的候选：工作区目录下的卡工程（含没连酒馆的），给「连接」选工程用
  assembleProjects() {
    return discoverProjects(this.cardsRoot, { accept: isSingleCardDirectory }).map(p => this.decorateProject(p));
  }
  record(action, projectId, result) {
    const entry = { at: new Date(this.now()).toISOString(), action, projectId: projectId ?? null, ...compactResult(result) };
    const prev = this.logs.at(-1);
    if (prev && prev.action === entry.action && prev.projectId === entry.projectId && JSON.stringify({ ...prev, at: null, repeat: null }) === JSON.stringify({ ...entry, at: null, repeat: null })) {
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
    const out = discoverProjects(this.cardsRoot).map(p => this.decorateProject(p));
    const counts = new Map();
    for (const p of out) for (const target of reservedTargets(p)) counts.set(target, (counts.get(target) ?? 0) + 1);
    for (const p of out) if (reservedTargets(p).some(target => counts.get(target) > 1)) { p.status = 'bindingConflict'; p.bindingConflict = true; }
    return out;
  }
  getProject(id, { attached = true } = {}) {
    if (typeof id !== 'string') fail('INVALID_PROJECT', 'projectId 必须是卡名', 400);
    segment(id, '卡名');
    const p = [...this.projects(), ...this.assembleProjects()].find(item => item.id === id);
    if (!p) {
      contained(this.cardsRoot, id);
      fail('PROJECT_NOT_FOUND', '工程不存在', 404);
    }
    if (attached && !p.attached) fail('NOT_ATTACHED', '工程还没连到酒馆；先点「连接」');
    if (p.bindingConflict) fail('BINDING_CONFLICT', '多个工程连着同一张酒馆卡；先解除重复的连接');
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
    return { running: !this.stopping, paused: this.state.paused, cardsRoot: this.cardsRoot, activeCardFile: this.state.activeCardFile ?? null, activeWorld, realtime: { debounceMs: this.debounceMs, fallbackMs: this.fallbackMs, watching: this.watchers.size }, currentTask: this.queue.current, queuedTasks: this.queue.size,
      projects: projects.map(p => this.publicProject(p)), assembleProjects: assembleProjects.map(p => this.publicProject(p)), logs: [...this.logs] };
  }
  // 断开（作者决定 2026-10-27）：之后再同步按重连处理
  disconnect(id) { this.live.delete(id); this.stamps.delete(id); }
  // 重连时两边不一致，或连着时遇到不能自动同步的情况：停下，等作者在两个选择里选一个。onlyNew：原来那张卡已不在
  markReconnect(project, diff, { onlyNew = false } = {}) {
    this.live.delete(project.id);
    const prev = this.results.get(project.id);
    const result = { status: 'needsReconnect', onlyNew, diff: diff ? compactDiff(diff) : null };
    this.results.set(project.id, result);
    if (prev?.status !== 'needsReconnect' || prev.diff?.revision !== result.diff?.revision || prev.onlyNew !== onlyNew) this.record('needsReconnect', project.id, { onlyNew, count: result.diff ? result.diff.changedSlots.length + result.diff.issues.length : 0 });
    return { projectId: project.id, ...result };
  }
  async perform(project, options = {}) {
    if (this.cardMissing(project)) fail('CARD_MISSING', `原来连的「${project.cardFile}」已不在酒馆里；只能「新建卡」`, 409, { missingCardFile: project.cardFile });
    try {
      const result = compactResult(await this.engine.run(project, options));
      const prev = this.results.get(project.id);
      this.results.set(project.id, result);
      // 两边一致 = 这张卡进入持续连着状态；之后两边的改动都自动同步
      if (result.status === 'clean') this.live.add(project.id); else this.live.delete(project.id);
      if (!options.automatic || result.changed || prev?.status !== result.status) this.record('sync', project.id, result);
      return { projectId: project.id, ...result };
    } catch (e) {
      if (RECONNECT_CODES.has(e.code)) { this.markReconnect(project, e.details); throw e; }
      const err = errorData(e);
      this.live.delete(project.id);
      this.results.set(project.id, { status: 'error', error: err });
      this.record('sync', project.id, { error: err });
      throw e;
    }
  }
  async mirrorProject(project) {
    if (project.bindingConflict) fail('BINDING_CONFLICT', '同一目标存在多个连接');
    if (project.detached || project.paused) return { projectId: project.id, status: 'paused' };
    if (project.binding.operation) fail('OPERATION_PENDING', '上次建卡或改名没有完成；不会重复执行');
    // 自动同步永远不建卡；没连过的工程要作者点「连接」
    if (!project.attached) return { projectId: project.id, status: 'unattached' };
    if (this.cardMissing(project)) return this.markReconnect(project, null, { onlyNew: true });
    if (project.targetKind !== 'world' && project.name !== project.projectName) {
      const target = `${project.name}.png`;
      if (this.adapter.listCards().some(c => c.cardFile.toLowerCase() === target.toLowerCase())) fail('RENAME_CONFLICT', '改名目标已存在；没有覆盖或重新建卡');
      const id = crypto.randomUUID(); this.writeBinding(project, { operation: { id, kind: 'rename', targetCardFile: target } });
      const renamed = await this.adapter.rename(project, id);
      this.writeBinding(project, { cardFile: renamed.cardFile, projectName: project.name, operation: null });
      if (this.state.activeCardFile && this.state.activeCardFile.toLowerCase() === project.cardFile.toLowerCase()) { this.state.activeCardFile = renamed.cardFile; this.saveState(); }
      this.record('rename', project.id, renamed); project = this.getProject(project.id);
    }
    // 连着：直接同步。断开后重连（后台重启、暂停后恢复、切走又切回、上轮出错）：两边一致就直接连上，不一致停下等作者选
    if (this.live.has(project.id)) return this.perform(project, { automatic: true });
    const diff = await this.engine.inspect(project);
    if (!diff.clean) return this.markReconnect(project, diff);
    return this.perform(project, { automatic: true, previewRevision: diff.revision });
  }
  // 酒馆里当前打开的卡和世界书编辑器里当前打开的世界书对应的工程；没有就是空列表
  activeTargets() {
    const wanted = [this.state.activeCardFile, this.state.activeWorldName ? `world:${this.state.activeWorldName}` : null].filter(Boolean).map(x => x.toLowerCase());
    if (!wanted.length) return [];
    return this.projects().filter(p => p.attached && !p.detached && p.cardFile && wanted.includes(p.cardFile.toLowerCase()));
  }
  // 连接后让酒馆跟着打开这张卡：自动同步只管打开的那张
  followProject(project) {
    if (project.targetKind === 'world' || !project.cardFile) return;
    this.state.activeCardFile = project.cardFile; this.saveState();
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
        if (!p || (automatic && p.paused)) continue;
        if (automatic) results.push(await this.mirrorProject(p));
        else if (action === 'check') {
          const diff = await this.engine.inspect(p); this.results.set(p.id, { status: diff.clean ? 'clean' : 'differences', diff: compactDiff(diff) }); results.push({ projectId: p.id, diff });
        } else results.push(await this.perform(p, options));
      }
      catch (e) {
        if (RECONNECT_CODES.has(e.code)) { results.push({ projectId: target.id, ...this.results.get(target.id) }); continue; }
        const result = { projectId: target.id, status: 'error', error: errorData(e) }; this.results.set(target.id, result); this.record(action, target.id, { error: errorData(e) }); results.push(result);
      }
    }
    return { results };
  }
  // 新建卡：按本地工程新建一张卡和一本世界书（重名都起新名字，不连旧的同名世界书），之后连到新卡。旧卡留在酒馆里
  async createNewCard(p) {
    if (p.targetKind === 'world') fail('INVALID_ACTION', '独立世界书工程不能新建角色卡', 400);
    if (p.pendingOperation) fail('OPERATION_PENDING', '上次建卡或改名没有完成；不会重复执行');
    const plan = await this.adapter.planNewCard(p);
    const id = crypto.randomUUID();
    this.disconnect(p.id);
    this.writeBinding(p, { operation: { id, kind: 'create', targetCardFile: plan.cardFile } });
    let created;
    try { created = await this.adapter.createCard(p, id, plan); }
    catch (e) {
      // 酒馆明确没建：清掉记录可以重试。没收到回执：记录留着，不重复建
      if (!this.adapter.hasPendingOperation?.(p)) this.writeBinding(p, { operation: null });
      this.record('newCard', p.id, { error: errorData(e) });
      throw e;
    }
    this.writeBinding({ ...p, cardFile: created.cardFile }, { operation: null, detached: false, paused: false, projectName: p.name, worldOverride: plan.worldOverride ?? null });
    this.results.delete(p.id);
    this.record('newCard', p.id, { cardFile: created.cardFile, worldName: created.worldName });
    const fresh = this.getProject(p.id);
    this.followProject(fresh);
    // 新卡就是按本地合成的；酒馆导入时改写了什么就再以本地为准写一次，仍对不上时报错
    const diff = await this.engine.inspect(fresh);
    const result = await this.perform(fresh, diff.clean ? { previewRevision: diff.revision } : { replaceRemote: true });
    this.wake([p.id]);
    return { project: this.publicProject(this.getProject(p.id)), cardFile: created.cardFile, worldName: created.worldName, ...result };
  }
  async control(body) {
    if (!body || typeof body.action !== 'string') fail('INVALID_ACTION', '缺少 action', 400);
    // A pause request is immediate. All other operations join one queue; no forced cancellation.
    if (body.action === 'pause' || body.action === 'resume') {
      // 暂停即断开：恢复后按重连处理
      if (body.action === 'pause') { this.live.clear(); this.stamps.clear(); }
      this.state.paused = body.action === 'pause'; this.saveState(); this.record(body.action, null, {});
      this.refreshWatchers(); if (!this.state.paused) this.wake();
      return this.status();
    }
    if (body.action === 'followCard') {
      // 只记住作者当前打开了哪张卡、哪本世界书；不读写其他卡的文件夹
      const cardFile = typeof body.cardFile === 'string' && body.cardFile.trim() ? body.cardFile.trim() : null;
      this.state.activeCardFile = cardFile;
      if (body.worldName !== undefined) this.state.activeWorldName = typeof body.worldName === 'string' && body.worldName.trim() ? body.worldName.trim() : null;
      const active = this.activeTargets();
      // 不再打开的卡算断开，切回来时按重连处理
      for (const id of [...this.live]) if (!active.some(p => p.id === id)) this.disconnect(id);
      const activeCard = active.find(p => p.targetKind !== 'world') ?? null;
      // 旧版切卡时会把其他卡写成暂停；切回来时只解开当前这张
      if (activeCard?.paused) this.writeBinding(activeCard, { paused: false });
      this.saveState();
      this.record('followCard', activeCard?.id ?? null, { cardFile });
      this.refreshWatchers(); this.wake();
      return this.status();
    }
    if (body.action === 'projectPause') {
      if (typeof body.paused !== 'boolean') fail('INVALID_ACTION', 'paused 必须是布尔值', 400);
      const p = this.getProject(body.projectId);
      if (body.paused) this.disconnect(p.id);
      this.writeBinding(p, { paused: body.paused });
      if (!body.paused) this.wake([p.id]);
      return this.publicProject(this.getProject(p.id));
    }
    return this.queue.run({ action: body.action, projectId: body.projectId ?? null }, async () => {
      switch (body.action) {
        case 'check': return this.batch('check', body.projectId);
        case 'sync': {
          const direction = body.direction ?? 'both';
          if (!['both', 'push', 'pull'].includes(direction) || (body.force !== undefined && typeof body.force !== 'boolean')) fail('INVALID_ACTION', 'direction/force 无效', 400);
          return this.batch('sync', body.projectId, false, { direction, force: body.force ?? false });
        }
        // 连接（作者决定 2026-10-27：只能从本地工程连到酒馆）：
        //   没连过（或原来那张卡已不在）→ 新建卡；连过 → 两边一致直接连上，不一致停下等作者选
        case 'connect': {
          const p = this.getProject(body.projectId, { attached: false });
          if (p.pendingOperation) fail('OPERATION_PENDING', '上次建卡或改名没有完成；不会重复执行');
          if (!p.cardFile) return this.createNewCard(p);
          if (this.projects().some(o => !sameProjectPath(o.dir, p.dir) && targetOccupied(o, p.cardFile))) fail('ATTACH_CONFLICT', `「${p.cardFile}」已由其他工程连着；先断开那边`);
          this.writeBinding(p, { detached: false, paused: false });
          const fresh = this.getProject(p.id);
          this.disconnect(p.id);
          this.followProject(fresh);
          this.record('connect', p.id, { cardFile: fresh.cardFile });
          if (this.cardMissing(fresh)) return { project: this.publicProject(fresh), ...this.markReconnect(fresh, null, { onlyNew: true }) };
          const diff = await this.engine.inspect(fresh);
          if (!diff.clean) return { project: this.publicProject(fresh), ...this.markReconnect(fresh, diff) };
          const result = await this.perform(fresh, { previewRevision: diff.revision });
          this.refreshWatchers();
          return { project: this.publicProject(this.getProject(p.id)), cardFile: fresh.cardFile, ...result };
        }
        // 以本地为准覆盖：本地工程整个写进原来那张卡和它的世界书，断开期间酒馆里的改动不保留
        case 'reconnectOverwrite': {
          const p = this.getProject(body.projectId);
          if (p.targetKind !== 'world' && !this.cardExists(p.cardFile)) fail('CARD_MISSING', `原来连的「${p.cardFile}」已不在酒馆里；只能「新建卡」`, 409, { missingCardFile: p.cardFile });
          this.writeBinding(p, { detached: false, paused: false });
          const result = await this.perform(this.getProject(p.id), { replaceRemote: true });
          this.followProject(p); this.refreshWatchers(); this.wake([p.id]);
          return { project: this.publicProject(this.getProject(p.id)), ...result };
        }
        case 'reconnectNew': return this.createNewCard(this.getProject(body.projectId, { attached: false }));
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
        // 拆解：只用于把酒馆里已有的卡第一次变成本地工程，拆完自动连上
        case 'attach': {
          segment(body.cardFile, '卡文件名');
          if (!/\.png$/i.test(body.cardFile)) fail('INVALID_CARD', '只接入 PNG 卡', 400);
          const name = body.cardFile.slice(0, -4); segment(name, '卡名');
          const id = name, p = { id, dir: contained(this.cardsRoot, id), cardFile: body.cardFile, paused: false };
          // 被其他工程连着：拒绝。被同名工程自己连着、又没说覆盖：按同名目录处理，带上会替换和会保留的文件清单
          const occupants = this.projects().filter(other => targetOccupied(other, body.cardFile));
          if (occupants.some(other => other.id !== id)) fail('ATTACH_CONFLICT', '卡已由其他工程连着');
          if (occupants.length && !body.overwrite) {
            const plan = this.adapter.overwritePlan && fs.existsSync(p.dir) ? this.adapter.overwritePlan(p.dir) : null;
            fail('ATTACH_CONFLICT', '同名工程目录已存在；拒绝覆盖或自动接入', 409, plan ? { replaceCount: plan.replace.length, keepGroups: plan.keepGroups } : undefined);
          }
          // keep：拆前清单里选了“留在卡里”的项；结果记进这张卡自己的 bridge.json
          const keep = Array.isArray(body.keep) ? body.keep.map(String) : undefined;
          const attachRes = await this.adapter.attach(p, { overwrite: Boolean(body.overwrite), ...(keep ? { keep } : {}) });
          this.writeBinding(p, { detached: false, paused: false, ...(keep ? { extrasKeep: keep } : {}) });
          // 拆出来就和酒馆一致（拆解自带往返比对），直接连上
          this.live.add(id); this.results.set(id, { status: 'clean', changed: false }); this.stamps.delete(id);
          this.record('attach', id, { cardFile: p.cardFile });
          this.refreshWatchers();
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
        case 'attachWorld': {
          segment(body.worldName, '世界书名');
          const target = `world:${body.worldName}`;
          const id = body.worldName, p = { id, dir: contained(this.cardsRoot, id), cardFile: target, paused: false };
          if (this.projects().some(other => (!body.overwrite || other.id !== id) && targetOccupied(other, target))) fail('ATTACH_CONFLICT', '世界书已由其他工程连着');
          await this.adapter.attach(p, { overwrite: Boolean(body.overwrite) });
          this.writeBinding(p, { detached: false, paused: false });
          this.live.add(id); this.results.set(id, { status: 'clean', changed: false }); this.stamps.delete(id);
          this.record('attachWorld', id, { cardFile: target }); this.refreshWatchers();
          return this.publicProject(this.getProject(id));
        }
        case 'skillsStatus': {
          if (!this.adapter.skillsStatus) fail('UNSUPPORTED_ACTION', '当前适配器不支持技能检查', 501);
          const res = await this.adapter.skillsStatus();
          this.record('skillsStatus', null, { count: res.skills?.length ?? 0 });
          return res;
        }
        case 'skillsDeploy': {
          if (!this.adapter.skillsDeploy) fail('UNSUPPORTED_ACTION', '当前适配器不支持技能与Agent同步', 501);
          const res = await this.adapter.skillsDeploy({});
          this.record('skillsDeploy', null, { ok: res.ok });
          return res;
        }
        case 'export': {
          if (body.outDir !== undefined && typeof body.outDir !== 'string') fail('INVALID_EXPORT_DIR', 'outDir 必须是字符串', 400);
          const p = this.getProject(body.projectId);
          const result = await this.adapter.exportProject(p, body.outDir);
          this.record('export', p.id, { outDir: result.outDir });
          return { projectId: p.id, ...result };
        }
        case 'setCardsRoot': {
          if (typeof body.cardsRoot !== 'string' || !body.cardsRoot.trim()) fail('INVALID_CARDS_ROOT', '请填写有效的工作区目录路径', 400);
          if (this.projects().some(p => p.pendingOperation || p.binding?.operation)) fail('OPERATION_PENDING', '当前目录仍有未完成的写入任务，不能切换工作区目录');
          const resolved = path.resolve(body.cardsRoot.trim());
          if (this.adapter.userDir && resolved.toLowerCase() === path.resolve(this.adapter.userDir).toLowerCase()) fail('INVALID_CARDS_ROOT', '工作区目录不能指向酒馆用户数据目录', 400);
          if (isSingleCardDirectory(resolved)) fail('INVALID_CARDS_ROOT', `「${path.basename(resolved)}」本身是单张卡目录，工作区目录请填写它的上一级目录（${path.dirname(resolved)}）`, 400);
          fs.mkdirSync(resolved, { recursive: true });
          this.cardsRoot = resolved;
          this.adapter.cardsRoot = resolved;
          this.live.clear();
          this.stamps.clear();
          this.results.clear();
          this.onCardsRootChange?.(resolved);
          this.record('setCardsRoot', null, { cardsRoot: resolved });
          this.refreshWatchers(); this.wake();
          return { cardsRoot: resolved };
        }
        case 'shutdown': {
          this.stopping = true; this.stopRealtime();
          this.record('shutdown', null, {});
          setTimeout(() => this.onShutdown?.(), 50);
          return { stopping: true };
        }
        case 'detach': {
          const p = this.getProject(body.projectId); await this.adapter.assertAvailable?.(p);
          if (p.pendingOperation) fail('OPERATION_PENDING', '目标仍被未完成的操作占用；不能断开');
          this.disconnect(p.id);
          this.writeBinding(p, { detached: true, paused: true }); this.record('detach', p.id, {}); this.refreshWatchers(); return { detached: true };
        }
        default: fail('INVALID_ACTION', '未知动作', 400);
      }
    }, queueKeyOf(body));
  }
  // ---------- 实时同步 ----------
  // 监听连着的工程文件夹、酒馆 characters/ 和 worlds/；任何通知都只是「可能变了」，
  // 真正要不要同步由 changeStamp（参与同步的文件、卡 PNG、绑定世界书的修改时间和大小）决定。
  // 同步自己写回的文件会让 stamp 变一次，再比对一次两边一致，不会循环
  start() {
    this.fallbackTimer = setInterval(() => this.fallbackTick(), this.fallbackMs);
    this.refreshWatchers();
    this.wake();
  }
  stampOf(project) {
    try { return this.adapter.changeStamp ? this.adapter.changeStamp(project) : null; }
    catch { return null; }
  }
  // 立刻检查（跳过 stamp 比较）：启动、恢复、切卡、连接之后
  wake(ids = null) {
    for (const t of this.activeTargets()) if (!ids || ids.includes(t.id)) { this.stamps.delete(t.id); this.schedule(t.id); }
  }
  schedule(id) {
    if (this.stopping || this.state.paused) return;
    clearTimeout(this.debounce.get(id));
    this.debounce.set(id, setTimeout(() => { this.debounce.delete(id); void this.runAutomatic(id); }, this.debounceMs));
  }
  async runAutomatic(id) {
    if (this.stopping || this.state.paused) return;
    const key = id.toLowerCase();
    // 这张卡上一轮还没做完：等做完再看
    if (this.queue.busy(key)) { this.schedule(id); return; }
    let target;
    try { target = this.activeTargets().find(t => t.id === id); } catch (e) { this.record('automatic', null, { error: errorData(e) }); return; }
    if (!target) return;
    // 同步前记 stamp：同步期间作者又改了，下一次比对就不一样，会再同步一次
    const stamp = this.stampOf(target);
    if (stamp !== null && this.stamps.get(id) === stamp) return;
    let failed = false;
    try {
      const { results } = await this.queue.run({ action: 'automatic', projectId: id }, () => this.batch('sync', id, true), key);
      failed = results.some(r => r.status === 'error');
    } catch (e) { failed = true; this.record('automatic', id, { error: errorData(e) }); }
    // 出错的不记 stamp：兜底检查时再试（日志里同样的错误合并成一行）
    if (failed || stamp === null) this.stamps.delete(id); else this.stamps.set(id, stamp);
  }
  fallbackTick() {
    if (this.stopping) return;
    try {
      this.refreshWatchers();
      if (this.state.paused) return;
      for (const t of this.activeTargets()) {
        if (this.debounce.has(t.id)) continue;
        const stamp = this.stampOf(t);
        if (stamp === null || this.stamps.get(t.id) !== stamp) this.schedule(t.id);
      }
    } catch (e) { this.record('automatic', null, { error: errorData(e) }); }
  }
  // 按当前打开的卡开关监听。打不开监听（目录不在、系统不支持）时只靠兜底检查
  refreshWatchers() {
    const want = new Map();
    if (!this.stopping && !this.state.paused) {
      let targets = [];
      try { targets = this.activeTargets(); } catch { targets = []; }
      for (const t of targets) want.set(path.resolve(t.dir), true);
      const userDir = this.adapter.userDir;
      if (userDir && targets.length) for (const sub of ['characters', 'worlds']) want.set(path.resolve(userDir, sub), false);
    }
    for (const [dir, w] of this.watchers) if (!want.has(dir)) { try { w.close(); } catch { /* closed */ } this.watchers.delete(dir); }
    for (const [dir, recursive] of want) {
      if (this.watchers.has(dir) || !fs.existsSync(dir)) continue;
      try {
        const w = this.watch(dir, { recursive, persistent: false }, () => { for (const t of this.activeTargetsSafe()) this.schedule(t.id); });
        w.on?.('error', () => { try { w.close(); } catch { /* closed */ } if (this.watchers.get(dir) === w) this.watchers.delete(dir); });
        this.watchers.set(dir, w);
      } catch { /* 只靠兜底检查 */ }
    }
  }
  activeTargetsSafe() { try { return this.activeTargets(); } catch { return []; } }
  stopRealtime() {
    clearInterval(this.fallbackTimer); this.fallbackTimer = null;
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    for (const w of this.watchers.values()) { try { w.close(); } catch { /* closed */ } }
    this.watchers.clear();
  }
  async stop() { this.stopping = true; this.stopRealtime(); await this.queue.tail; }
}
