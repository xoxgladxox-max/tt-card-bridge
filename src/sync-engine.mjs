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
    const newEntry = !!n && !t && key.startsWith('entry:') && n.newEntryEligible === true && snapshot.baselineReliable === true && !Object.hasOwn(baseline.slots, key) && !Object.hasOwn(baseline.pending ?? {}, key);
    // 正则、脚本、变量：一边没有时按基线判断是哪边新增、哪边删除
    const extra = /^(regex|script):|^(vars|xbtasks)$/.test(key);
    const base0 = baseline?.slots?.[key];
    if (extra && (!n || !t)) {
      const has = n ?? t;
      if (base0 === undefined) kind = n ? 'project' : 'tavern';
      else if (base0 === slotHash(has.value)) kind = n ? 'tavern' : 'project';
      else kind = 'conflict';
    }
    else if (!n) kind = 'added';
    else if (!t) kind = newEntry ? 'project' : 'removed';
    else if (n.value !== t.value) {
      const base = baseline?.slots?.[key];
      if (open.has(key)) kind = 'conflict';
      else if (resolved.has(key)) kind = 'project';
      else if (base === slotHash(n.value)) kind = 'tavern';
      else if (base === slotHash(t.value)) kind = 'project';
      else kind = 'conflict';
    }
    if (n?.settings !== undefined && t?.settings !== undefined && n.settings !== t.settings) issues.push({ kind: 'settings', key, message: `条目设置不同：${n.label}` });
    if (kind === 'added' || kind === 'removed') issues.push({ kind, key, message: `${kind === 'added' ? '酒馆新增或工程缺少' : '酒馆删除或工程新增'}槽位：${n?.label ?? t?.label}` });
    slots.push({ key, label: n?.label ?? t?.label ?? key, node: n?.value ?? null, tavern: t?.value ?? null, kind, canResolve: extra || (!!n && !!t), ...(newEntry ? { newEntry: true } : {}), ...(extra ? { extra: true } : {}) });
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
  async run(project, { direction = 'both', previewRevision, choices, force = false, initializeExpected, skipBackup = false, acceptDataLossRisk = false, backupDir = '' } = {}) {
    if (skipBackup && acceptDataLossRisk !== true) fail('CONFIRMATION_REQUIRED', '不备份直接覆盖前，必须勾选确认自行承担数据丢失责任', 400);
    await this.adapter.assertAvailable?.(project);
    let before = await this.adapter.snapshot(project);
    if (previewRevision && before.revision !== previewRevision) fail('STALE_PREVIEW', '预览后内容已改变，请重新查看差异');
    const initializing = initializeExpected !== undefined;
    if (initializing && before.expected.targetWorld && before.expected.targetWorld.hash !== null) fail('WORLD_TARGET_CONFLICT', '首次建卡的目标世界书已存在；不能把摘要匹配当作覆盖授权');
    if (initializing && (hashObject(before.expected) !== hashObject(initializeExpected) || Object.values(before.tavern.slots).some(s => s.value))) fail('STALE_INITIALIZATION', '新建空卡在首次推送前已改变；不会覆盖');
    let diff = compareSnapshot(before);
    if (diff.issues.length && !initializing) fail('UNSUPPORTED_DIFFERENCE', '设置、绑定或槽位增删需要手动处理；未同步', 409, diff);
    const chosen = new Map();
    if (choices !== undefined) {
      if (!Array.isArray(choices)) fail('INVALID_CHOICE', 'choices 必须为数组', 400);
      for (const c of choices) {
        const slot = diff.slots.find(s => s.key === c.key);
        if (!slot?.canResolve || slot.kind === 'equal' || chosen.has(c.key) || !['project', 'tavern', 'manual'].includes(c.source)) fail('INVALID_CHOICE', '只能为已有差异槽位提供一个决定', 400);
        if (c.source === 'manual' && typeof c.text !== 'string') fail('INVALID_CHOICE', '手动正文必须是字符串', 400);
        chosen.set(c.key, c.source === 'manual' ? c.text.replaceAll('\r\n', '\n').trim() : c.source === 'project' ? slot.node : slot.tavern);
      }
    }
    const conflicts = diff.slots.filter(s => s.kind === 'conflict' && !chosen.has(s.key));
    if (initializing || (force && direction === 'push')) for (const s of conflicts) chosen.set(s.key, s.node);
    else if (conflicts.length) fail('CONFLICT', '两边不同且没有安全基线；请选择正文，不会自动覆盖', 409, diff);
    if (direction === 'push' && diff.slots.some(s => s.kind === 'tavern' && !chosen.has(s.key)) && !force) fail('TAVERN_CHANGED', '酒馆有尚未拉回的变化', 409, diff);
    if (diff.clean && !initializing) { await this.adapter.saveBaseline(project, before, true); return { status: 'clean', changed: false }; }
    const updates = [];
    let needsPush = initializing;
    for (const s of diff.slots) {
      if (s.kind === 'equal') continue;
      const value = chosen.has(s.key) ? chosen.get(s.key) : s.kind === 'tavern' && direction !== 'push' ? s.tavern : s.node;
      if (value !== s.node) updates.push({ key: s.key, value });
      if (value !== s.tavern && direction !== 'pull') needsPush = true;
    }
    const backupId = skipBackup ? null : await this.adapter.backup(project, before, { backupDir });
    // Recheck after backing up, before the first mutation. Transport also checks expected remote data.
    if ((await this.adapter.snapshot(project)).revision !== before.revision) fail('STALE_PREVIEW', '备份时内容改变；没有写入');
    const plannedNodes = nodeSignature(before, updates);
    const plannedLocal = await this.adapter.writeBodies(project, before, updates);
    if (needsPush) {
      const prepared = await this.adapter.snapshot(project);
      if (nodeSignature(prepared) !== plannedNodes || (plannedLocal && prepared.localHash !== plannedLocal)) fail('STALE_LOCAL', '决定后本地文件又改变；没有推送未经预览的内容');
      if (JSON.stringify(prepared.expected) !== JSON.stringify(before.expected)) fail('STALE_REMOTE', '酒馆内容已改变；节点修改已备份，未推送');
      await this.adapter.push(project, prepared);
    }
    const after = await this.adapter.snapshot(project);
    if (nodeSignature(after) !== plannedNodes || (plannedLocal && after.localHash !== plannedLocal)) fail('STALE_LOCAL', '操作期间工程改变；没有更新同步基线');
    diff = compareSnapshot(after);
    if (direction !== 'pull' && !diff.clean) fail('VERIFY_FAILED', '写入后查对仍不一致；未更新基线', 409, diff);
    await this.adapter.saveBaseline(project, after, diff.clean);
    return { status: diff.clean ? 'clean' : 'pending', changed: updates.length > 0 || needsPush || !!before.idAssignments?.length, backupId, backupSkipped: Boolean(skipBackup), diff, assignedIds: (before.idAssignments ?? []).map(({ relPath, id, uid }) => ({ relPath, id, uid })) };
  }
}
