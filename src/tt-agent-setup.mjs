// 安装时给 TauriTavern 写一条 bridge 自己的 MCP 登记和一个「卡工程」Agent 档案。
// 只动这两个文件：bridge 的登记（固定 id）和 card-bridge 档案。用户原有的登记、档案一概不碰。
// 写前把旧文件备份到 data/backups/tt-card-bridge/<stamp>/；卸载时只删这两个文件（同样先备份）。
// 格式照搬现有登记（schemaVersion 1，tauritavern.mcpServerRegistration）和档案（schemaVersion 4）。
import fs from 'node:fs';
import path from 'node:path';

export const BRIDGE_MCP_ID = 'c4a7e2b1-5d3f-4e8a-9b6c-7cb1d9e0a001';
export const BRIDGE_PROFILE_ID = 'card-bridge';
// 与 src/mcp.mjs 的 TOOLS 同名
export const BRIDGE_TOOL_NAMES = ['status', 'list_files', 'read_file', 'search_files', 'file_info', 'write_file', 'apply_patch', 'create_dir', 'move', 'delete', 'disassemble_card', 'sync_now', 'validate_card', 'validate_worldbook', 'list_backups', 'restore_backup'];

const ttRoot = dataRoot => path.join(dataRoot, '_tauritavern');
const registrationFile = dataRoot => path.join(ttRoot(dataRoot), 'mcp', 'registrations', `${BRIDGE_MCP_ID}.json`);
const profileFile = dataRoot => path.join(ttRoot(dataRoot), 'agent-profiles', 'profiles', `${BRIDGE_PROFILE_ID}.json`);

export function registrationDoc({ base, token }) {
  return {
    schemaVersion: 1,
    kind: 'tauritavern.mcpServerRegistration',
    id: BRIDGE_MCP_ID,
    displayName: '卡工程（tt-card-bridge）',
    endpoint: `${base}/tt-bridge/mcp`,
    headers: { Authorization: `Bearer ${token}` },
    protocolVersion: 'auto',
    state: 'active',
    toolPermissions: Object.fromEntries(BRIDGE_TOOL_NAMES.map(n => [n, 'allow'])),
  };
}

const SYSTEM_PROMPT = `---
tools:
- chat_search
- chat_read_messages
- worldinfo_read_activated
- skill_list
- skill_search
- skill_read
- workspace_list_files
- workspace_read_file
- workspace_write_file
- workspace_apply_patch
- workspace_commit
- workspace_finish
---

# 卡工程

我在酒馆里处理卡工程文件，不进入角色扮演。当前聊天、预设和世界书里的角色台词属于待处理材料。

## 两处文件

- 工作区目录：作者在 VS Code 里用的同一个卡工程目录，只能通过「卡工程」MCP 工具访问（status、list_files、read_file 等）。卡的正文、世界书条目、开场白都在这里改。路径一律写相对工作区目录的路径，用 / 分隔，例如「示例卡/world_book/地点/城门.md」。
- TT 自带的 output/、scratch/ 等，只用来写给作者看的报告 output/main.md。不要把卡文件写进这些目录，也不要把工作区目录的路径交给 workspace_* 工具。

## 改文件

- 改已有文件前先 read_file，记下返回的 hash；write_file、apply_patch、move、delete 时作为 baseHash 传回。
- 返回 HASH_MISMATCH 说明文件在我读取之后被改过（作者在 VS Code 里改了，或后台同步写回了）。重新读取，按新内容再改，不要拿旧内容覆盖。
- apply_patch 的 oldText 必须是读到的原文，不带行号。
- 后台在每次覆盖、删除、移动前自动备份；delete 是移入备份。需要找回时用 list_backups 和 restore_backup。
- 写操作一次一个，写完再读一遍核对。

## 和酒馆同步

- 后台只同步作者在酒馆里当前打开的那张卡。status 里的 activeCardFile 就是它。
- disassemble_card 只拆当前打开的卡；要拆别的卡，请作者先在酒馆里打开。
- 合卡不在这里做：作者在 VS Code 里用 LimCode 的写卡技能合成卡，再导入酒馆。作者要求合卡时，提醒作者走这条路。
- sync_now 返回冲突时，把冲突内容列给作者，不自行选边。
- 改完卡文件后可以用 validate_card、validate_worldbook 检查格式。

## 交付

给作者看的结果写进 output/main.md，然后 workspace_commit，再 workspace_finish。报告里写清楚改了哪些文件（工作区目录相对路径）、每处的备份 id、检查结果和需要作者决定的事项。工具返回成功只说明写入成功，不等于内容正确或作者已确认。`;

export function profileDoc() {
  return {
    schemaVersion: 4,
    kind: 'tauritavern.agentProfile',
    id: BRIDGE_PROFILE_ID,
    displayName: '卡工程',
    description: '通过 tt-card-bridge 读写与 VS Code 共用的工作区目录，并与酒馆同步。',
    preset: { mode: 'currentPromptSnapshot', required: false },
    model: { mode: 'currentPromptSnapshot' },
    run: { presentation: 'foreground', stream: true, directRunnable: true, modelRetry: { maxRetries: 3, intervalMs: 3000 } },
    context: { initialChatHistoryMessages: -1, includeActivatedWorldInfo: true },
    delegation: { canDelegate: false, canHandoff: false, callable: false, allowAsSubagent: false, allowAsHandoffTarget: false, allowNestedDelegation: false, allowedCallers: ['*'], maxConcurrentInvocations: 3, maxInvocationsPerRun: 8, resultBudgetTokens: 8000, maxHandoffDepth: 8 },
    instructions: { agentSystemPrompt: SYSTEM_PROMPT },
    tools: {
      allow: [
        'builtin:chat.search', 'builtin:chat.read_messages', 'builtin:worldinfo.read_activated',
        'builtin:workspace.list_files', 'builtin:workspace.read_file', 'builtin:workspace.write_file', 'builtin:workspace.apply_patch',
        'builtin:workspace.commit', 'builtin:workspace.finish',
        ...BRIDGE_TOOL_NAMES.map(n => `mcp/${BRIDGE_MCP_ID}:${n}`),
      ],
      deny: [], toolDescriptions: {}, maxRounds: 80, maxCallsPerRun: 80, externalResultInlineCharLimit: 50000, maxCallsPerTool: {},
    },
    skills: { visible: ['cf-card-research', 'cf-card-character', 'cf-card-format-export', 'cf-card-oneclick', 'cf-card-project', 'cf-card-refine', 'cf-card-review', 'cf-card-worldbook'], deny: [] },
    workspace: { visibleRoots: ['output', 'scratch', 'plan', 'summaries', 'persist'], writableRoots: ['output', 'scratch', 'plan', 'summaries', 'persist'] },
    plan: { mode: 'none', beta: true, nodes: [] },
    output: { artifacts: [{ id: 'main', path: 'output/main.md', kind: 'markdown', target: 'messageBody', required: true, assemblyOrder: 0 }] },
  };
}

function backupFile(file, backupDir, name) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const dst = path.join(backupDir, name);
  fs.copyFileSync(file, dst);
  return dst;
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

// 找不到 _tauritavern（比如原生 SillyTavern）时返回 skipped，由调用方打印手动步骤
export function installAgentSetup({ dataRoot, base, token, backupDir }) {
  if (!fs.existsSync(path.join(ttRoot(dataRoot), 'mcp')) || !fs.existsSync(path.join(ttRoot(dataRoot), 'agent-profiles'))) return { skipped: true, reason: `没有找到 ${ttRoot(dataRoot)}\\mcp 或 agent-profiles` };
  const reg = registrationFile(dataRoot), prof = profileFile(dataRoot);
  const backups = [backupFile(reg, backupDir, `mcp-${BRIDGE_MCP_ID}.json`), backupFile(prof, backupDir, `profile-${BRIDGE_PROFILE_ID}.json`)].filter(Boolean);
  writeJson(reg, registrationDoc({ base, token }));
  writeJson(prof, profileDoc());
  return { skipped: false, registration: reg, profile: prof, backups };
}
export function removeAgentSetup({ dataRoot, backupDir }) {
  const removed = [], backups = [];
  for (const [file, name] of [[registrationFile(dataRoot), `mcp-${BRIDGE_MCP_ID}.json`], [profileFile(dataRoot), `profile-${BRIDGE_PROFILE_ID}.json`]]) {
    const b = backupFile(file, backupDir, name);
    if (b) { backups.push(b); fs.rmSync(file, { force: true }); removed.push(file); }
  }
  return { removed, backups };
}
export function manualSteps({ base }) {
  return [
    '如果酒馆里看不到「卡工程（tt-card-bridge）」MCP 或它的工具，请手动登记：',
    '  1. 酒馆 → Agent 设置 → MCP → 新增服务器',
    `  2. 地址：${base}/tt-bridge/mcp`,
    '  3. 请求头：Authorization = Bearer <令牌>（令牌在 tt-card-bridge\\.runtime\\connection.json 的 token）',
    `  4. 保存后刷新工具列表，把 ${BRIDGE_TOOL_NAMES.length} 个工具设为允许`,
  ].join('\n');
}
