// install.mjs — 先只读识别环境与缺失项，列出将要执行的操作并询问用户确认后，再安装或卸载扩展
//   tt-card install            识别环境 → 询问确认 → 安装或更新扩展
//   tt-card install --check    只读识别环境与缺失项，不执行任何写入
//   tt-card install --yes      跳过交互询问（供自动化测试或用户显式指定）
//   tt-card install --remove   识别已安装项 → 询问确认 → 卸载扩展并还原
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectTavernEnvironment, resolveCardsRoot, resolveSkillsRoot, saveLocalBridgeConfig } from './paths.mjs';
import { copyTree } from './safety.mjs';
import { connection, BRIDGE_BASE, BRIDGE_PORT } from './connection.mjs';
import { BRIDGE_MCP_ID, BRIDGE_PROFILE_ID, installAgentSetup, removeAgentSetup, manualSteps } from './tt-agent-setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_SRC = path.join(ROOT, 'extension');
const OLD_SCRIPT = '卡片同步刷新';
const LAUNCH_URL = 'tt-card-bridge://start';
const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\tt-card-bridge';

function hasDependencyYaml() {
  return fs.existsSync(path.join(ROOT, 'node_modules', 'yaml', 'package.json'));
}

function hasProtocolRegistered() {
  if (process.platform !== 'win32') return true;
  try {
    const out = execFileSync('reg.exe', ['query', `${PROTOCOL_KEY}\\shell\\open\\command`, '/ve'], { encoding: 'ascii', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.toLowerCase().includes('wscript.exe') && out.toLowerCase().includes('start-silent.vbs');
  } catch {
    return false;
  }
}

function readInstalledExtVersion(extDst) {
  try {
    const m = path.join(extDst, 'manifest.json');
    return fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')).version : null;
  } catch { return null; }
}

function readSourceExtVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version; }
  catch { return '0.2.0-dev'; }
}

function needsSettingsWrite(userDir, targetEnabled) {
  try {
    const file = path.join(userDir, 'settings.json');
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const old = s.extension_settings?.tavern_helper?.script?.scripts?.find(x => x.name === OLD_SCRIPT);
    return Boolean(old && old.enabled !== targetEnabled);
  } catch { return false; }
}

function hasAgentSetupInstalled(dataRoot) {
  const reg = path.join(dataRoot, '_tauritavern', 'mcp', 'registrations', `${BRIDGE_MCP_ID}.json`);
  const prof = path.join(dataRoot, '_tauritavern', 'agent-profiles', 'profiles', `${BRIDGE_PROFILE_ID}.json`);
  return {
    supported: fs.existsSync(path.join(dataRoot, '_tauritavern', 'mcp')) && fs.existsSync(path.join(dataRoot, '_tauritavern', 'agent-profiles')),
    regExists: fs.existsSync(reg),
    profExists: fs.existsSync(prof),
    reg,
    prof,
  };
}

// 只读环境与缺失项诊断，不写任何文件、不创目录、不生成 token
export function inspectEnvironment() {
  const env = detectTavernEnvironment();
  const vbsPath = path.join(ROOT, '.runtime', 'start-silent.vbs');
  const connFile = path.join(ROOT, '.runtime', 'connection.json');
  const extConnFile = path.join(env.extDst, 'extension', 'connection.json');
  const srcVer = readSourceExtVersion();
  const instVer = readInstalledExtVersion(env.extDst);
  const yamlOk = hasDependencyYaml();
  const protocolOk = hasProtocolRegistered() && fs.existsSync(vbsPath);
  const connOk = fs.existsSync(connFile) && fs.existsSync(extConnFile);
  const agent = env.kind === 'tauritavern' ? hasAgentSetupInstalled(env.dataRoot) : { supported: false, regExists: false, profExists: false };
  const skillsRoot = resolveSkillsRoot();
  const cardsRoot = resolveCardsRoot();
  const oldScriptNeedsDisable = env.kind === 'tauritavern' && needsSettingsWrite(env.userDir, false);

  const missing = [];
  if (!yamlOk) missing.push({ key: 'npm_deps', label: 'Node 依赖包（yaml）未安装', action: '执行 npm install 安装本地依赖' });
  if (!env.found) missing.push({ key: 'tavern_dir', label: '未检测到酒馆用户目录（TauriTavern 或原生 SillyTavern）', action: '请您提供普通酒馆的 default-user 目录路径（或先打开一次 TauriTavern）' });
  if (env.found) {
    if (!instVer) missing.push({ key: 'extension', label: `酒馆扩展未安装（目标：${env.extDst}）`, action: `安装前端扩展 v${srcVer} 到 ${env.extDst}` });
    else if (instVer !== srcVer || !connOk) missing.push({ key: 'extension', label: `酒馆扩展需要更新或补齐连接配置（当前 v${instVer} → v${srcVer}）`, action: `备份旧扩展并更新到 ${env.extDst}` });
  }
  if (process.platform === 'win32' && !protocolOk) {
    missing.push({ key: 'protocol', label: '后台一键启动协议（tt-card-bridge://start）未登记', action: '生成 .runtime/start-silent.vbs 并在当前用户注册表登记启动协议' });
  }
  if (env.kind === 'tauritavern' && agent.supported && (!agent.regExists || !agent.profExists)) {
    missing.push({ key: 'tt_agent', label: 'TauriTavern 的「卡工程」MCP 与 Agent 档案未登记', action: '写入 MCP 登记与 card-bridge 档案（自动备份旧文件）' });
  }
  if (oldScriptNeedsDisable) {
    missing.push({ key: 'old_script', label: `旧版酒馆助手脚本「${OLD_SCRIPT}」仍处于启用状态`, action: '备份 settings.json 并停用旧脚本' });
  }

  return {
    env,
    srcVer,
    instVer,
    yamlOk,
    protocolOk,
    connOk,
    agent,
    skillsRoot,
    cardsRoot,
    oldScriptNeedsDisable,
    missing,
  };
}

export function formatInspectionReport(report) {
  const lines = [];
  lines.push('=== tt-card-bridge 环境与组件识别报告 ===');
  lines.push(`1. 酒馆环境：${report.env.found ? `${report.env.label}（${report.env.userDir}）` : '未找到（需指定 SillyTavern 的 data/default-user 目录）'}`);
  lines.push(`2. 拆装卡核心（内置 forge）：已内置（独立可用，不依赖外部写卡技能仓库）`);
  lines.push(`3. 本地依赖（yaml）：${report.yamlOk ? '已安装' : '【缺失】需运行 npm install'}`);
  lines.push(`4. 酒馆前端扩展：${report.instVer ? `已安装 v${report.instVer}${report.connOk ? '' : '（缺 connection.json）'}` : '【未安装】'}（目标位置：${report.env.extDst}）`);
  if (process.platform === 'win32') {
    lines.push(`5. 面板「启动同步」协议：${report.protocolOk ? '已就绪' : '【未登记】需登记 HKCU\\Software\\Classes\\tt-card-bridge'}`);
  }
  if (report.env.kind === 'tauritavern') {
    lines.push(`6. TauriTavern MCP / Agent 档案：${report.agent.regExists && report.agent.profExists ? '已配置' : (report.agent.supported ? '【未配置】可自动写入' : '未检测到 _tauritavern 目录')}`);
  } else {
    lines.push(`6. 普通酒馆说明：支持完整拆卡、装卡、连接与实时双向同步；如需给外部 AI 用 MCP，连 ${BRIDGE_BASE}/tt-bridge/mcp 即可`);
  }
  lines.push(`7. 可选写卡技能库：${report.skillsRoot ? `已检测到（${report.skillsRoot}）` : '未安装（不影响拆装卡与双向同步）'}`);
  lines.push(`8. 默认卡工程工作区：${report.cardsRoot}（装好后可在酒馆面板随时修改）`);
  if (report.missing.length) {
    lines.push('\n检测到以下缺失或待更新项：');
    report.missing.forEach((m, idx) => {
      lines.push(`  [${idx + 1}] ${m.label}\n      → 将执行：${m.action}`);
    });
  } else {
    lines.push('\n所有必需组件均已就绪（如继续安装，将刷新扩展文件与连接配置）。');
  }
  return lines.join('\n');
}

function registerProtocol(vbsPath) {
  if (process.platform !== 'win32') return;
  const reg = args => execFileSync('reg.exe', args, { stdio: 'ignore', windowsHide: true });
  reg(['add', PROTOCOL_KEY, '/ve', '/d', 'URL:tt-card-bridge', '/f']);
  reg(['add', PROTOCOL_KEY, '/v', 'URL Protocol', '/d', '', '/f']);
  reg(['add', `${PROTOCOL_KEY}\\shell\\open\\command`, '/ve', '/d', `"${path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')}" "${vbsPath}"`, '/f']);
}
function unregisterProtocol() {
  if (process.platform !== 'win32') return;
  try { execFileSync('reg.exe', ['delete', PROTOCOL_KEY, '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* 本来就没有 */ }
}

function startupVbsPath() {
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'tt-card-bridge.vbs')
    : null;
}
function removeStartupVbs() {
  const file = startupVbsPath();
  if (file && fs.existsSync(file)) { fs.rmSync(file, { force: true }); console.log(`已删除旧的开机启动项：${file}`); }
}

const portOpen = async () => {
  try { await fetch(`${BRIDGE_BASE}/tt-bridge/version`, { signal: AbortSignal.timeout(500) }); return true; }
  catch { return false; }
};

async function stopBackgroundDaemon(token) {
  if (!(await portOpen())) return;
  await fetch(`${BRIDGE_BASE}/tt-bridge/control`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'shutdown' }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (!(await portOpen())) return;
  }
  throw new Error(`旧的同步后台没有停下（${BRIDGE_BASE} 仍有响应）。可能正在写入，稍等再运行 install。`);
}

function writeLaunchScript({ token, launch }) {
  const runtimeDir = path.join(ROOT, '.runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const vbsPath = path.join(runtimeDir, 'start-silent.vbs');
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    'Set env = sh.Environment("PROCESS")',
    `env("TT_BRIDGE_PORT") = "${String(BRIDGE_PORT)}"`,
    `env("TT_BRIDGE_TOKEN") = "${token.replace(/"/g, '""')}"`,
    `sh.CurrentDirectory = "${launch.cwd.replace(/"/g, '""')}"`,
    `sh.Run """${process.execPath.replace(/"/g, '""')}"" ""${launch.script.replace(/"/g, '""')}"" ""${launch.cardsRoot.replace(/"/g, '""')}""", 0, False`,
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(vbsPath, Buffer.from('\uFEFF' + vbs, 'utf16le'));
  return vbsPath;
}

async function ensureBackgroundDaemon({ token, launch }) {
  if (process.env.TAVERN_USER_DIR) return;
  const vbsPath = writeLaunchScript({ token, launch });
  registerProtocol(vbsPath);
  removeStartupVbs();
  await stopBackgroundDaemon(token);
  console.log('已登记后台启动方式。打开酒馆后在「卡工程同步」里点「启动同步」。');
}

async function removeBackgroundDaemon() {
  if (process.env.TAVERN_USER_DIR) return;
  const { token } = connection();
  await stopBackgroundDaemon(token);
  removeStartupVbs();
  unregisterProtocol();
}

function tavernRunning() {
  try { return execSync('tasklist /FI "IMAGENAME eq tauritavern.exe" /NH', { encoding: 'utf8' }).includes('tauritavern.exe'); }
  catch { return false; }
}

function backupExtension(extDst, dataRoot) {
  if (!fs.existsSync(extDst)) return null;
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const backup = path.join(dataRoot, 'backups', 'tt-card-bridge', stamp);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  copyTree(extDst, backup);
  console.log(`扩展备份：${backup}`);
  return backup;
}

function installExtension(extDst, dataRoot, cardsRoot) {
  const { token } = connection();
  const launch = {
    script: path.join(ROOT, 'src', 'mirror.mjs'),
    cardsRoot,
    cwd: ROOT,
  };
  const connPayload = JSON.stringify({ base: BRIDGE_BASE, token, launch: { ...launch, url: LAUNCH_URL } }) + '\n';
  const inPlace = path.resolve(extDst).toLowerCase() === path.resolve(ROOT).toLowerCase();
  if (inPlace) {
    // 通过酒馆「输入扩展程序的 Git URL 以安装」直接克隆在 extensions/tt-card-bridge 下：原地写入连接配置，不删自身目录
    fs.writeFileSync(path.join(EXT_SRC, 'connection.json'), connPayload, { mode: 0o600 });
    return { token, launch };
  }
  backupExtension(extDst, dataRoot);
  fs.rmSync(extDst, { recursive: true, force: true });
  fs.mkdirSync(extDst, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(extDst, 'manifest.json'));
  copyTree(EXT_SRC, path.join(extDst, 'extension'));
  fs.writeFileSync(path.join(extDst, 'extension', 'connection.json'), connPayload, { mode: 0o600 });
  return { token, launch };
}

function setOldScript(userDir, enabled) {
  const file = path.join(userDir, 'settings.json');
  if (!fs.existsSync(file)) return 'settings.json 不存在，不用改';
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const old = s.extension_settings?.tavern_helper?.script?.scripts?.find(x => x.name === OLD_SCRIPT);
  if (!old) return '旧脚本不存在，不用改';
  if (old.enabled === enabled) return `旧脚本本来就是${enabled ? '启用' : '停用'}`;
  const bk = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, bk);
  old.enabled = enabled;
  fs.writeFileSync(file, JSON.stringify(s, null, 4), 'utf8');
  const back = JSON.parse(fs.readFileSync(file, 'utf8')).extension_settings.tavern_helper.script.scripts.find(x => x.name === OLD_SCRIPT);
  return `旧脚本已${back.enabled ? '启用' : '停用'}（设置备份：${bk}）`;
}

async function promptConfirm(question) {
  if (process.argv.includes('--yes') || process.argv.includes('-y') || !process.stdin.isTTY) {
    if (!process.stdin.isTTY && !process.argv.includes('--yes') && !process.argv.includes('-y') && !process.env.TAVERN_USER_DIR) {
      // 非交互终端且未传 --yes 时，要求显式传 --yes，不擅自安装
      console.log(`\n[需要确认] ${question}`);
      console.log('当前为非交互终端，未擅自执行。请确认上述操作后加上 --yes 重新运行：node bin/tt-card.mjs install --yes');
      return false;
    }
    return true;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`\n${question} [y/N]: `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

async function promptInput(question) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`\n${question}: `)).trim();
  } finally {
    rl.close();
  }
}

const isCheckOnly = process.argv.includes('--check');
const isRemove = process.argv.includes('--remove');

let report = inspectEnvironment();
console.log(formatInspectionReport(report));

if (isCheckOnly) {
  process.exit(0);
}

// 1. 如果缺少 npm 依赖（yaml），先询问用户是否允许运行 npm install
if (!report.yamlOk && !isRemove) {
  const allowNpm = await promptConfirm('检测到缺少本地依赖包（yaml），是否允许现在执行 npm install 安装依赖？');
  if (!allowNpm) {
    console.log('已取消安装（未执行任何修改）。');
    process.exit(0);
  }
  execSync('npm install --no-fund --no-audit', { cwd: ROOT, stdio: 'inherit' });
  report = inspectEnvironment();
}

// 2. 如果本机同时检测到 TauriTavern 与普通酒馆，或都没检测到，询问用户安装到哪一个
if (!isRemove && !process.env.TAVERN_USER_DIR) {
  if (!report.env.found) {
    const inputDir = await promptInput('未自动找到酒馆目录。请输入普通酒馆的 default-user 目录路径（例如 D:\\SillyTavern\\data\\default-user，直接回车取消）');
    if (!inputDir) {
      console.log('未提供酒馆路径，已取消安装。你也可以稍后运行：node bin/tt-card.mjs install --yes（配置好 tavernUserDir 后）');
      process.exit(1);
    }
    const resolved = path.resolve(inputDir.replace(/^["']|["']$/g, ''));
    const candidate = fs.existsSync(path.join(resolved, 'data', 'default-user')) ? path.join(resolved, 'data', 'default-user') : resolved;
    if (!fs.existsSync(candidate)) {
      console.log(`路径不存在：${candidate}，已取消安装。`);
      process.exit(1);
    }
    saveLocalBridgeConfig({ tavernUserDir: candidate });
    report = inspectEnvironment();
  } else if (report.env.candidates.length > 1 && process.stdin.isTTY && !process.argv.includes('--yes') && !process.argv.includes('-y')) {
    console.log('\n检测到多个酒馆环境：');
    report.env.candidates.forEach((c, idx) => console.log(`  [${idx + 1}] ${c.label}（${c.userDir}）`));
    const choice = await promptInput(`请选择要安装到的酒馆序号（默认 1）`);
    const picked = report.env.candidates[(Number(choice || '1') - 1)];
    if (picked) {
      saveLocalBridgeConfig({ tavernUserDir: picked.kind === 'sillytavern' ? picked.userDir : null });
      report = inspectEnvironment();
    }
  }
}

if (isRemove) {
  const ok = await promptConfirm(`确认从「${report.env.label}」卸载 tt-card-bridge 扩展（${report.env.extDst}）并清理后台启动协议吗？`);
  if (!ok) {
    console.log('已取消卸载。');
    process.exit(0);
  }
  if (report.env.kind === 'sillytavern') {
    await removeBackgroundDaemon();
    backupExtension(report.env.extDst, report.env.dataRoot);
    fs.rmSync(report.env.extDst, { recursive: true, force: true });
    console.log(`已卸载扩展：${report.env.extDst}`);
    process.exit(0);
  }
  if (tavernRunning() && needsSettingsWrite(report.env.userDir, true)) {
    console.log('酒馆开着时改设置会被酒馆覆盖。先关掉酒馆再运行。');
    process.exit(1);
  }
  await removeBackgroundDaemon();
  {
    const backupDir = path.join(report.env.dataRoot, 'backups', 'tt-card-bridge', `agent-setup-removed-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const r = removeAgentSetup({ dataRoot: report.env.dataRoot, backupDir });
    for (const f of r.removed) console.log(`已删除：${f}`);
    if (r.backups.length) console.log(`删除前备份：${r.backups.join('；')}`);
  }
  if (fs.existsSync(report.env.extDst)) {
    backupExtension(report.env.extDst, report.env.dataRoot);
    fs.rmSync(report.env.extDst, { recursive: true, force: true });
    console.log(`已卸载扩展：${report.env.extDst}`);
  } else console.log('扩展没有安装');
  console.log(setOldScript(report.env.userDir, true));
  process.exit(0);
}

// 3. 正式安装前向用户询问确认
const confirmInstall = await promptConfirm(`是否确认按上述计划将 tt-card-bridge 安装/更新到「${report.env.label}」（${report.env.extDst}）？`);
if (!confirmInstall) {
  console.log('已取消安装（未执行任何修改）。');
  process.exit(0);
}

if (report.env.kind === 'sillytavern') {
  const info = installExtension(report.env.extDst, report.env.dataRoot, report.cardsRoot);
  await ensureBackgroundDaemon(info);
  console.log(`已安装扩展：${report.env.extDst}\n在 SillyTavern 网页里刷新一次，扩展 → 管理扩展 里应能看到「tt-card-bridge（卡工程同步设置）」。`);
  process.exit(0);
}

if (tavernRunning() && needsSettingsWrite(report.env.userDir, false)) {
  console.log('酒馆开着时改设置会被酒馆覆盖。先关掉酒馆再运行。');
  process.exit(1);
}

const info = installExtension(report.env.extDst, report.env.dataRoot, report.cardsRoot);
await ensureBackgroundDaemon(info);
{
  const backupDir = path.join(report.env.dataRoot, 'backups', 'tt-card-bridge', `agent-setup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const r = installAgentSetup({ dataRoot: report.env.dataRoot, base: BRIDGE_BASE, token: info.token, backupDir });
  if (r.skipped) console.log(`没有自动登记 MCP：${r.reason}\n${manualSteps({ base: BRIDGE_BASE })}`);
  else {
    console.log(`已写 MCP 登记：${r.registration}`);
    console.log(`已写「卡工程」Agent 档案：${r.profile}`);
    if (r.backups.length) console.log(`旧文件备份：${r.backups.join('；')}`);
    console.log(manualSteps({ base: BRIDGE_BASE }));
  }
}
const ver = readInstalledExtVersion(report.env.extDst) ?? report.srcVer;
console.log(`已安装扩展 ${ver}：${report.env.extDst}`);
console.log(setOldScript(report.env.userDir, false));
console.log('打开酒馆后，在 扩展 → 管理扩展 里应能看到「tt-card-bridge（卡工程同步设置）」。');
