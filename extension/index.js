// One authenticated loopback connection serves the settings panel and queued tasks.
// 带上版本号查询参数，避免在酒馆点「更新扩展」后浏览器继续使用旧版子模块缓存
import { createBridgeClient, createJobConsumer } from './client.js?v=0.3.5';
import { mountSettings } from './settings.js?v=0.3.5';
import { createTavernMutations } from './tavern-mutations.js?v=0.3.5';
import { createBrowserSyncRuntime } from './browser-sync.js?v=0.3.5';

const TAG = '[tt-card-bridge]';
let known = null;
let busy = false;
let panel = null;
const mutations = createTavernMutations({ getContext: () => ctx(), refreshCards });
const browserSync = createBrowserSyncRuntime({ getContext: () => ctx(), mutations, runRenameJob: job => runRenameJob(job) });
const client = createBridgeClient({ browserSync });

const ctx = () => window.SillyTavern.getContext();
const tt = () => window.__TAURITAVERN__;
const errText = e => String(e?.message ?? e);

async function refreshCards(files) {
  // TauriTavern 后端有角色卡缓存；原生 SillyTavern 写卡时自己会清缓存，没有 __TAURITAVERN__
  if (tt()?.invoke) await tt().invoke.safeInvoke('clear_character_cache');
  const st = ctx();
  await st.getCharacters();

  const now = ctx();
  const cid = now.characterId;
  if (cid === undefined || cid === null || cid === '') return '角色列表';
  const current = now.characters[Number(cid)];
  if (!current || (files.length && !files.includes(current.avatar))) return '角色列表';

  await now.unshallowCharacter(String(cid));
  await now.selectCharacterById(Number(cid), { switchMenu: false });
  await syncActiveCardRuntime(Number(cid));
  return `当前角色卡「${current.name}」`;
}

// 当前打开的卡写回后，通知宿主页面上已安装的公开全局接口（酒馆助手、开场白第0楼、消息重绘）刷新内存状态
async function syncActiveCardRuntime(cid) {
  const latest = ctx();
  const card = latest?.characters?.[cid];
  if (!card) return;
  const ext = card.data?.extensions ?? {};
  const th = ext.tavern_helper;
  const helper = window.TavernHelper;
  if (helper && th && typeof th === 'object') {
    const scripts = Array.isArray(th)
      ? th.find(x => Array.isArray(x) && x[0] === 'scripts')?.[1]
      : th.scripts;
    const variables = Array.isArray(th)
      ? th.find(x => Array.isArray(x) && x[0] === 'variables')?.[1]
      : th.variables;
    if (Array.isArray(scripts) && typeof helper.replaceScriptTrees === 'function') {
      try { await helper.replaceScriptTrees(scripts, { type: 'character' }); } catch (e) { console.warn(TAG, e); }
    }
    if (variables && typeof variables === 'object' && typeof helper.replaceVariables === 'function') {
      try { await helper.replaceVariables(variables, { type: 'character' }); } catch (e) { console.warn(TAG, e); }
    }
  } else if (helper && Array.isArray(ext.TavernHelper_scripts) && typeof helper.replaceScriptTrees === 'function') {
    try { await helper.replaceScriptTrees(ext.TavernHelper_scripts, { type: 'character' }); } catch (e) { console.warn(TAG, e); }
  }
  const first = latest.chat?.[0];
  if (Array.isArray(latest.chat) && latest.chat.length === 1 && first && !first.is_user && !first.is_system
    && !latest.chatMetadata?.tainted && (first.swipe_id ?? 0) === 0
    && typeof card.first_mes === 'string' && card.first_mes && first.mes !== card.first_mes) {
    first.mes = card.first_mes;
    if (Array.isArray(first.swipes)) first.swipes[0] = card.first_mes;
    try { await latest.saveChatConditional?.(); await latest.reloadCurrentChat?.(); } catch (e) { console.warn(TAG, e); }
  }
  try { await window.processExistingMessages?.(); } catch (e) { console.warn(TAG, e); }
}


// 改名任务：cards 里的卡文件夹改了名。走酒馆自带的 /rename-char 命令（内部就是前端的 renameCharacter），
// 标签、额外世界书、作者注释、群聊成员、聊天记录里的角色名都由它一起改。它只改当前打开的卡，所以先打开这张卡，改完再切回原来的卡。
// 不直接 import 酒馆的 script.js：地址和页面加载时不一致就会把主程序再跑一遍。
async function runRenameJob(job) {
  if (job.expectedTargetAbsent !== true) throw new Error('改名任务未确认目标不存在。');
  await mutations.assertExpected(job);
  await ctx().getCharacters();
  let st = ctx();
  if (st.characters.some(card => card.avatar !== job.avatar && card.avatar.toLowerCase() === `${job.newName}.png`.toLowerCase())) throw new Error('改名目标已被占用，未改名。');
  if (st.groupId) throw new Error('酒馆里开着群聊，改名要先打开这张卡会打断群聊。先退出群聊再重试');
  const idx = st.characters.findIndex(c => c.avatar === job.avatar);
  if (idx < 0) throw new Error(`酒馆里没有这张卡：${job.avatar}`);
  const cur = st.characterId;
  const prev = cur === undefined || cur === null || cur === '' ? null : st.characters[Number(cur)]?.avatar ?? null;
  if (String(cur) !== String(idx)) await st.selectCharacterById(idx, { switchMenu: false });
  const quoted = '"' + String(job.newName).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const res = await st.executeSlashCommandsWithOptions(`/rename-char silent=true chats=true ${quoted}`, { handleParserErrors: false, handleExecutionErrors: false });
  if (String(res?.pipe) !== 'true') throw new Error(`酒馆没有改名（/rename-char 返回 ${res?.pipe}）`);
  st = ctx();
  const avatar = st.characters[Number(st.characterId)]?.avatar;
  if (prev && prev !== job.avatar) {
    const back = st.characters.findIndex(c => c.avatar === prev);
    if (back >= 0) await st.selectCharacterById(back, { switchMenu: false });
  }
  return { id: job.id, avatar };
}

// 把文本里的旧技能名换成新名；已经带 cf- 前缀的不动。新名为 null 的是已删除的技能：文本里不动，只从技能列表里去掉
function renameText(text, renames) {
  let out = text;
  for (const [from, to] of Object.entries(renames)) {
    if (!to) continue;
    out = out.replace(new RegExp(`(?<![\\w-])${from.replace(/[-]/g, '\\-')}(?![\\w-])`, 'g'), to);
  }
  return out;
}

async function renameInProfiles(renames, sourceSkills = []) {
  const agent = tt().api.agent;
  const listed = await agent.profiles.list();
  const arr = Array.isArray(listed) ? listed : (listed?.profiles ?? []);
  const changed = [];
  const checked = [];
  for (const item of arr) {
    const id = item.id ?? item.profileId;
    if (!id) continue;
    const { profile } = await agent.profiles.load(id);
    const name = profile.displayName ?? id;
    checked.push(name);
    const before = JSON.stringify(profile);
    const mapList = list => [...new Set(list.map(n => (n in renames ? renames[n] : n)).filter(Boolean))];
    if (Array.isArray(profile.skills?.visible)) {
      const hadCfSkill = profile.skills.visible.some(n => n.startsWith('cf-') || n in renames);
      profile.skills.visible = mapList(profile.skills.visible);
      if (hadCfSkill && sourceSkills.length) {
        profile.skills.visible = [...new Set([...profile.skills.visible, ...sourceSkills])];
      }
    }
    if (Array.isArray(profile.skills?.deny)) profile.skills.deny = mapList(profile.skills.deny);
    if (typeof profile.instructions?.agentSystemPrompt === 'string') {
      profile.instructions.agentSystemPrompt = renameText(profile.instructions.agentSystemPrompt, renames);
    }
    if (JSON.stringify(profile) !== before) {
      await agent.profiles.save(profile);
      changed.push(name);
    }
  }
  return { changed, checked };
}

async function runSkillJob(job) {
  await tt().ready;
  const api = tt().api.skill;
  const global = { kind: 'global' };
  const results = [];

  for (const s of job.install ?? []) {
    const input = { kind: 'directory', path: s.dir };
    try {
      const found = await api.discoverImports({ input });
      if (!found.length) throw new Error('目录里没有找到 SKILL.md');
      for (const cand of found) {
        const r = await api.installImport({ input: cand, targetScope: global, conflictStrategy: 'replace' });
        results.push({ name: r.name, action: r.action, version: r.skill?.version ?? null });
      }
    } catch (e) {
      results.push({ name: s.name, error: errText(e) });
    } finally {
      try { await api.discardPickedImport(input); } catch { /* 按路径导入时没有临时资源 */ }
    }
  }

  const installed = new Set((await api.list({ scope: global })).map(x => x.name));
  for (const name of job.remove ?? []) {
    if (!installed.has(name)) { results.push({ name, action: 'absent' }); continue; }
    try { await api.delete({ scope: global, name }); results.push({ name, action: 'deleted' }); }
    catch (e) { results.push({ name, error: errText(e) }); }
  }

  let profiles = [];
  let checkedProfiles = [];
  let profileError = null;
  if (job.renames && Object.keys(job.renames).length) {
    try {
      const profRes = await renameInProfiles(job.renames, job.sourceSkills ?? []);
      profiles = profRes.changed;
      checkedProfiles = profRes.checked;
    } catch (e) { profileError = errText(e); }
  }

  const final = (await api.list({ scope: global })).map(x => ({ name: x.name, version: x.version ?? null, hash: x.installedHash }));
  return { id: job.id, results, profiles, checkedProfiles, profileError, final };
}

const consumer = createJobConsumer({ client, execute: async (kind, job) => {
  if (kind === 'skills') {
    if (!tt()?.api?.skill) throw new Error('当前宿主不支持技能任务。');
    return runSkillJob(job);
  }
  if (job.op === 'create') return mutations.create(job);
  if (job.op === 'rename') return runRenameJob(job);
  if (job.op) throw new Error(`不支持的卡片任务：${job.op}`);
  return job.worldName && !job.card ? mutations.runWorld(job) : mutations.runCard(job);
} });

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const snapshot = await client.request('version');
    if (known !== null && snapshot.version !== known) await refreshCards(snapshot.files ?? []);
    known = snapshot.version;
    const result = await consumer.consume(snapshot);
    if (result.blocked) panel?.showError(result.message);
    if (result.report) {
      const report = result.report;
      const failure = report.fatal || report.profileError || report.results?.find(item => item.error)?.error;
      if (failure) { panel?.showError(failure); toastr.error(errText(failure), '卡工程同步'); }
      else if (report.refreshWarning) panel?.showError(`写入已完成，但界面刷新失败：${report.refreshWarning}`);
    }
  } catch (error) {
    panel?.showError(error);
  } finally {
    busy = false;
    await panel?.refresh({ force: false });
    await panel?.checkCardFollow?.();
  }
}

if (!window.__TT_CARD_BRIDGE__) {
  try {
    panel = mountSettings({ client, getContext: ctx, refreshCards });
    const st = ctx();
    if (st?.eventSource && st?.event_types?.CHAT_CHANGED) {
      st.eventSource.on(st.event_types.CHAT_CHANGED, () => { panel?.checkCardFollow?.(); });
    }
    window.__TT_CARD_BRIDGE__ = { timer: setInterval(tick, 1000), panel };
    console.log(TAG, '扩展已加载；实际后台状态见扩展设置。');
    tick();
  } catch (error) {
    console.error(TAG, error);
    toastr.error(errText(error), '卡工程同步面板加载失败');
  }
}
