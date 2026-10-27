// The sole three-way comparison used by HTTP, mirror, push and pull.
import { slotHash } from './slots.mjs';
import { fail, hashObject } from './safety.mjs';

export function compareSnapshot(snapshot) {
  const { nodes, tavern, baseline, resolved = new Set(), open = new Set() } = snapshot;
  const slots = [], issues = [...(snapshot.issues ?? [])];
  for (const key of new Set([...Object.keys(nodes.slots), ...Object.keys(tavern.slots)])) {
    const n = nodes.slots[key], t = tavern.slots[key];
    if (!n && !t?.value && key.startsWith('field:')) continue;
    let kind = 'equal';
    const unrecorded = snapshot.baselineReliable === true && !Object.hasOwn(baseline.slots, key) && !Object.hasOwn(baseline.pending ?? {}, key);
    const newEntry = !!n && !t && ((key.startsWith('entry:') && n.newEntryEligible === true) || key.startsWith('greeting:')) && unrecorded;
    const remoteNewEntry = !n && !!t && (key.startsWith('entry:') || key.startsWith('greeting:')) && unrecorded;
    const deletedOn = (side, kept) => snapshot.baselineReliable === true && key.startsWith('entry:') && baseline.slots[key] === slotHash(kept.value);
    // 正则、脚本、变量：一边没有时按基线判断是哪边新增、哪边删除
    const extra = /^(regex|script):|^(vars|xbtasks)$/.test(key);
    const base0 = baseline?.slots?.[key];
    if (extra && (!n || !t)) {
      const has = n ?? t;
      if (base0 === undefined) kind = n ? 'project' : 'tavern';
      else if (base0 === slotHash(has.value)) kind = n ? 'tavern' : 'project';
      else kind = 'conflict';
    }
    // 世界书条目一边删了：另一边还是上次同步的样子，就是那一边删的，照常同步删除
    else if (!n) kind = remoteNewEntry ? 'tavern' : deletedOn('project', t) ? 'project' : 'added';
    else if (!t) kind = newEntry ? 'project' : deletedOn('tavern', n) ? 'tavern' : 'removed';
    else if (n.value !== t.value) {
      const base = baseline?.slots?.[key];
      if (open.has(key)) kind = 'conflict';
      else if (resolved.has(key)) kind = 'project';
      else if (base === slotHash(n.value)) kind = 'tavern';
      else if (base === slotHash(t.value)) kind = 'project';
      else kind = 'conflict';
    }
    const settingsChanged = n?.settingsChanged ?? t?.settingsChanged ?? null;
    if (settingsChanged && kind === 'equal') {
      kind = settingsChanged;
    }
    if (n?.settings !== undefined && t?.settings !== undefined && n.settings !== t.settings && !settingsChanged) {
      if (!issues.some(i => i.kind === 'settings' && i.key === key)) {
        issues.push({ kind: 'settings', key, message: `条目设置不同：${n.label}` });
      }
    }
    if (kind === 'added' || kind === 'removed') issues.push({ kind, key, message: `${kind === 'added' ? '酒馆新增或工程缺少' : '酒馆删除或工程新增'}槽位：${n?.label ?? t?.label}` });
    // suggest：只改了一边时建议用改动的那边；两边都改的不给建议。只是建议，写入前都要作者确认
    const relPath = n?.relPath ? String(n.relPath).split('\\').join('/') : null;
    slots.push({ key, label: n?.label ?? t?.label ?? key, node: n?.value ?? null, tavern: t?.value ?? null, kind, suggest: kind === 'project' || kind === 'tavern' ? kind : null, relPath, canResolve: extra || (!!n && !!t), ...(newEntry ? { newEntry: true } : {}), ...(remoteNewEntry ? { remoteNewEntry: true } : {}), ...(settingsChanged ? { settingsChanged } : {}), ...(extra ? { extra: true } : {}) });
  }
  return { revision: snapshot.revision, clean: !issues.length && slots.every(s => s.kind === 'equal'), slots, issues, idAssignments: (snapshot.idAssignments ?? []).map(({ relPath, id, uid }) => ({ relPath, id, uid })) };
}

export const nodeSignature = (snapshot, updates = []) => {
  const changed = new Map(updates.map(u => [u.key, u.value]));
  return hashObject(Object.fromEntries(Object.entries(snapshot.nodes.slots).map(([key, n]) => [key, { value: changed.has(key) ? changed.get(key) : n.value, settings: n.settings, relPath: n.relPath }])));
};
export class SyncEngine {
  constructor(adapter) { this.adapter = adapter; }
  async inspect(project) { return compareSnapshot(await this.adapter.snapshot(project)); }
  // 不备份（作者决定 2026-10-27：酒馆里的旧卡就是历史版本）。replaceRemote：以本地为准整卡覆盖
  async run(project, { direction = 'both', previewRevision, force = false, replaceRemote = false } = {}) {
    await this.adapter.assertAvailable?.(project);
    let before = await this.adapter.snapshot(project);
    if (previewRevision && before.revision !== previewRevision) fail('STALE_PREVIEW', '预览后内容已改变，请重新查看差异');
    let diff = compareSnapshot(before);
    if (diff.issues.length && !replaceRemote) fail('UNSUPPORTED_DIFFERENCE', '设置、绑定或槽位增删需要手动处理；未同步', 409, diff);
    const chosen = new Map();
    const conflicts = diff.slots.filter(s => s.kind === 'conflict' && !chosen.has(s.key));
    if (replaceRemote || (force && direction === 'push')) for (const s of conflicts) chosen.set(s.key, s.node);
    else if (conflicts.length) fail('CONFLICT', '两边都改了；请选「以本地为准覆盖」或「新建卡」', 409, diff);
    if (direction === 'push' && diff.slots.some(s => s.kind === 'tavern' && !chosen.has(s.key)) && !force && !replaceRemote) fail('TAVERN_CHANGED', '酒馆有尚未拉回的变化', 409, diff);
    if (diff.clean && !replaceRemote) { await this.adapter.saveBaseline(project, before, true); return { status: 'clean', changed: false }; }
    const updates = [];
    let needsPush = replaceRemote && diff.issues.length > 0;
    for (const s of diff.slots) {
      if (s.kind === 'equal') continue;
      // 以本地为准时，本地没有的槽位只推送（酒馆里的随之删掉），不写本地文件
      if (replaceRemote && s.node === null) { needsPush = true; continue; }
      const value = chosen.has(s.key) ? chosen.get(s.key) : s.kind === 'tavern' && direction !== 'push' && !replaceRemote ? s.tavern : s.node;
      const pullSettings = s.settingsChanged === 'tavern' && direction !== 'push' && !replaceRemote;
      const pushSettings = s.settingsChanged === 'project' && direction !== 'pull';
      if (value !== s.node || pullSettings) {
        updates.push({
          key: s.key,
          value,
          ...(pullSettings || s.remoteNewEntry ? { remoteEntry: before.tavern.slots[s.key]?.remoteEntry ?? null } : {}),
        });
      }
      if ((value !== s.tavern || pushSettings) && direction !== 'pull') needsPush = true;
    }
    const plannedNodes = nodeSignature(before, updates);
    const plannedLocal = await this.adapter.writeBodies(project, before, updates);
    const hasMetaUpdates = updates.some(u => u.remoteEntry || u.value === null || !before.nodes.slots[u.key]);
    if (needsPush) {
      const prepared = await this.adapter.snapshot(project);
      if ((plannedLocal ? prepared.localHash !== plannedLocal : nodeSignature(prepared) !== plannedNodes) || (!hasMetaUpdates && nodeSignature(prepared) !== plannedNodes)) fail('STALE_LOCAL', '决定后本地文件又改变；没有推送未经预览的内容');
      if (JSON.stringify(prepared.expected) !== JSON.stringify(before.expected)) fail('STALE_REMOTE', '酒馆内容已改变；未推送');
      await this.adapter.push(project, prepared);
    }
    const after = await this.adapter.snapshot(project);
    if ((plannedLocal ? after.localHash !== plannedLocal : nodeSignature(after) !== plannedNodes) || (!hasMetaUpdates && nodeSignature(after) !== plannedNodes)) fail('STALE_LOCAL', '操作期间工程改变；没有更新同步基线');
    diff = compareSnapshot(after);
    if (direction !== 'pull' && !diff.clean) fail('VERIFY_FAILED', '写入后查对仍不一致；未更新基线', 409, diff);
    await this.adapter.saveBaseline(project, after, diff.clean);
    return { status: diff.clean ? 'clean' : 'pending', changed: updates.length > 0 || needsPush || !!before.idAssignments?.length, diff, assignedIds: (before.idAssignments ?? []).map(({ relPath, id, uid }) => ({ relPath, id, uid })) };
  }
}
