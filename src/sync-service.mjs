import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverProjects, reservedTargets, targetOccupied, isSingleCardDirectory } from './projects.mjs';
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
export class SyncService {
  constructor({ cardsRoot, runtimeRoot, adapter, now = () => Date.now(), onShutdown = null, onCardsRootChange = null }) {
    this.cardsRoot = path.resolve(cardsRoot); this.runtimeRoot = runtimeRoot; this.adapter = adapter; this.adapter.cardsRoot ??= this.cardsRoot; this.engine = new SyncEngine(adapter); this.now = now; this.onShutdown = onShutdown; this.onCardsRootChange = onCardsRootChange;
    this.stateFile = path.join(runtimeRoot, 'service.json');
    this.state = { paused: true, pollIntervalMs: 2000, backupDir: '', autoBackupBeforeOverwrite: true, activeCardFile: null, ...readJson(this.stateFile, {}) };
    this.queue = new SerialQueue(); this.stableProjects = new Map(); this.logs = []; this.results = new Map(); this.previews = new Map(); this.timer = null; this.stopping = false;
  }
  backupOptions(body = {}) {
    if (typeof body.backupDir === 'string') { this.state.backupDir = body.backupDir.trim(); this.saveState(); }
    const skipBackup = body.skipBackup !== undefined ? Boolean(body.skipBackup) : !this.state.autoBackupBeforeOverwrite;
    return {
      skipBackup,
      acceptDataLossRisk: Boolean(body.acceptDataLossRisk),
      backupDir: typeof body.backupDir === 'string' ? body.backupDir.trim() : (this.state.backupDir ?? ''),
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
    const out = discoverProjects(this.cardsRoot).map(p => {
      const result = this.results.get(p.id) ?? null;
      return { ...p, status: p.pendingOperation ? p.pendingOperation.state === 'reviewRequired' ? 'reviewRequired' : 'operationPending' : p.restoreRequired ? 'restoreRequired' : result?.error ? 'error' : !p.attached ? 'unattached' : result?.status ?? (p.paused ? 'paused' : 'unchecked'), lastResult: result };
    });
    const counts = new Map();
    for (const p of out) for (const target of reservedTargets(p)) counts.set(target, (counts.get(target) ?? 0) + 1);
    for (const p of out) if (reservedTargets(p).some(target => counts.get(target) > 1)) { p.status = 'bindingConflict'; p.bindingConflict = true; }
    return out;
  }
  getProject(id, { attached = true } = {}) {
    if (typeof id !== 'string') fail('INVALID_PROJECT', 'projectId 必须是卡名', 400);
    segment(id, '卡名'); contained(this.cardsRoot, id);
    const p = this.projects().find(p => p.id === id);
    if (!p) fail('PROJECT_NOT_FOUND', '工程不存在', 404);
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
    const unattachedWorlds = (this.adapter.listWorlds?.() ?? []).filter(w => !attached.has(`world:${w.worldName}`.toLowerCase()));
    return { running: !this.stopping, capabilities: { restoreMode: this.adapter.restoreMode ?? null }, paused: this.state.paused, cardsRoot: this.cardsRoot, backupDir: this.state.backupDir ?? '', autoBackupBeforeOverwrite: this.state.autoBackupBeforeOverwrite !== false, activeCardFile: this.state.activeCardFile ?? null, pollIntervalMs: this.state.pollIntervalMs, currentTask: this.queue.current, queuedTasks: this.queue.size,
      projects: projects.map(p => this.publicProject(p)), unattachedCards: this.adapter.listCards().filter(c => !attached.has(c.cardFile.toLowerCase())), unattachedWorlds, logs: [...this.logs] };
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
    if (!project.attached) {
      const cardFile = `${project.name}.png`;
      if (this.adapter.listCards().some(c => c.cardFile.toLowerCase() === cardFile.toLowerCase())) fail('ATTACH_CONFLICT', '同名酒馆卡已存在；不会自动接管或覆盖');
      const revision = this.adapter.localRevision(project);
      if (this.stableProjects.get(project.id) !== revision) { this.stableProjects.set(project.id, revision); return { projectId: project.id, status: 'waitingForStableFiles' }; }
      await this.adapter.prepareNew(project);
      const jobId = crypto.randomUUID();
      project = { ...project, cardFile, attached: true };
      this.writeBinding(project, { initializing: true, operation: { id: jobId, kind: 'create', targetCardFile: cardFile } });
      const avatar = await this.adapter.create(project, jobId);
      this.writeBinding(project, { cardFile: avatar, operation: null });
      if (avatar !== cardFile) { this.writeBinding(project, { cardFile: avatar, paused: true }); fail('CREATE_MISMATCH', `酒馆返回 ${avatar}，已暂停等待核实`); }
      const snapshot = await this.adapter.snapshot(project);
      this.writeBinding(project, { initializeExpected: snapshot.expected });
      project = this.getProject(project.id);
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
  async batch(action, projectId, automatic = false, options = {}) {
    const targets = projectId ? [this.getProject(projectId)] : this.projects().filter(p => automatic ? !p.detached : p.attached);
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
      const cardFile = typeof body.cardFile === 'string' && body.cardFile.trim() ? body.cardFile.trim() : null;
      this.state.activeCardFile = cardFile;
      let activeProjectId = null;
      for (const p of this.projects()) {
        if (!p.attached || p.targetKind === 'world') continue;
        const isCurrent = Boolean(cardFile && p.cardFile && p.cardFile.toLowerCase() === cardFile.toLowerCase());
        if (isCurrent) {
          activeProjectId = p.id;
          if (p.paused && !p.restoreRequired) this.writeBinding(p, { paused: false });
        } else if (!p.paused) {
          this.writeBinding(p, { paused: true });
        }
      }
      this.saveState();
      this.record('followCard', activeProjectId, { cardFile });
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
          await this.adapter.attach(p, { overwrite: Boolean(body.overwrite), ...this.backupOptions(body), ...(keep ? { keep } : {}) });
          this.writeBinding(p, { detached: false, paused: false, ...(keep ? { extrasKeep: keep } : {}) });
          this.record('attach', id, { cardFile: p.cardFile }); return this.publicProject(this.getProject(id));
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
          const p = this.getProject(body.projectId, { attached: false });
          const backupOpts = this.backupOptions(body);
          let initializeExpected = null;
          if (!p.attached) {
            if (p.targetKind === 'world') {
              const target = `world:${p.name}`;
              this.writeBinding({ ...p, cardFile: target }, { detached: false, paused: false });
            } else {
              const candidateFile = `${p.name}.png`;
              const existsInTavern = this.adapter.listCards().some(c => c.cardFile.toLowerCase() === candidateFile.toLowerCase());
              if (existsInTavern) {
                if (!body.overwrite) {
                  fail('ATTACH_CONFLICT', `酒馆已存在同名角色卡「${p.name}」；确认覆盖后可将工作区内容合成导入酒馆`, 409);
                }
                if (this.projects().some(other => other.id !== p.id && targetOccupied(other, candidateFile))) {
                  fail('ATTACH_CONFLICT', '该酒馆角色卡已由其他工作区工程接管');
                }
                this.writeBinding({ ...p, cardFile: candidateFile }, { detached: false, paused: false });
              } else {
                await this.adapter.prepareNew(p, { embedWorld: true });
                const jobId = crypto.randomUUID();
                const creating = { ...p, cardFile: candidateFile, attached: true };
                this.writeBinding(creating, { detached: false, paused: false, initializing: true, operation: { id: jobId, kind: 'create', targetCardFile: candidateFile } });
                const avatar = await this.adapter.create(creating, jobId);
                this.writeBinding(creating, { cardFile: avatar, operation: null });
                const snap = await this.adapter.snapshot({ ...creating, cardFile: avatar });
                initializeExpected = snap.expected;
                this.writeBinding(creating, { cardFile: avatar, initializing: false, initializeExpected: null });
              }
            }
          } else if (p.paused && !p.restoreRequired) {
            this.writeBinding(p, { paused: false });
          }
          const refreshed = this.getProject(p.id);
          const syncRes = await this.perform(refreshed, {
            ...(initializeExpected ? { initializeExpected } : { force: true, direction: 'push' }),
            ...backupOpts,
          });
          this.record('importFromWorkspace', refreshed.id, { status: syncRes.status });
          return { project: this.publicProject(this.getProject(p.id)), sync: syncRes };
        }
        case 'setCardsRoot': {
          if (typeof body.cardsRoot !== 'string' || !body.cardsRoot.trim()) fail('INVALID_CARDS_ROOT', '请填写有效的工程根目录路径', 400);
          if (this.projects().some(p => p.pendingOperation || p.binding?.operation)) fail('OPERATION_PENDING', '当前目录仍有未决写入任务，不能切换工程根目录');
          const resolved = path.resolve(body.cardsRoot.trim());
          if (this.adapter.userDir && resolved.toLowerCase() === path.resolve(this.adapter.userDir).toLowerCase()) fail('INVALID_CARDS_ROOT', '工程根目录不能指向酒馆用户数据目录', 400);
          if (isSingleCardDirectory(resolved)) fail('INVALID_CARDS_ROOT', `「${path.basename(resolved)}」本身是单张卡目录，工程根目录请填写它的上一级目录（${path.dirname(resolved)}）`, 400);
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
    });
  }
  start() {
    const tick = async () => {
      if (this.stopping) return;
      if (!this.state.paused && !this.queue.size) {
        try { await this.queue.run({ action: 'automatic', projectId: null }, () => this.batch('sync', undefined, true)); }
        catch (e) { this.record('automatic', null, { error: errorData(e) }); }
      }
      if (!this.stopping) this.timer = setTimeout(tick, this.state.pollIntervalMs);
    };
    this.timer = setTimeout(tick, this.state.pollIntervalMs);
  }
  async stop() { this.stopping = true; clearTimeout(this.timer); await this.queue.tail; }
}
