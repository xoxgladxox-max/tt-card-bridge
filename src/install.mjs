// install.mjs — 把 extension/ 装进酒馆的第三方扩展目录，并停用旧的酒馆助手脚本「卡片同步刷新」
//   tt-card install            安装或更新扩展（酒馆需关着）
//   tt-card install --remove   卸载扩展，并重新启用旧脚本（回到改动之前）
// 两者不能同时启用：同时启用时，一次技能任务会被执行两遍。
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tavernDataRoot, tavernUserDir, isNativeSillyTavern } from './paths.mjs';
import { copyTree } from './safety.mjs';
import { connection, BRIDGE_BASE, BRIDGE_PORT } from './connection.mjs';
import { installAgentSetup, removeAgentSetup, manualSteps } from './tt-agent-setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_SRC = path.join(ROOT, 'extension');
const NATIVE = isNativeSillyTavern();
// 原生 SillyTavern：装到当前用户的扩展目录（data/default-user/extensions/）；TauriTavern：装到 data/extensions/third-party/
const EXT_DST = NATIVE
  ? path.join(tavernUserDir(), 'extensions', 'tt-card-bridge')
  : path.join(tavernDataRoot(), 'extensions', 'third-party', 'tt-card-bridge');
const OLD_SCRIPT = '卡片同步刷新';

// 目录复制与备份、MCP 共用 safety.mjs 的 copyTree（fs.cpSync 在当前 Windows Node 24 上不可靠）

function backupExtension() {
  if (!fs.existsSync(EXT_DST)) return null;
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const backup = path.join(tavernDataRoot(), 'backups', 'tt-card-bridge', stamp);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  copyTree(EXT_DST, backup);
  console.log(`扩展备份：${backup}`);
  return backup;
}

function installExtension() {
  const { token } = connection();
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const launch = {
    script: path.join(ROOT, 'src', 'mirror.mjs'),
    cardsRoot: path.resolve(ROOT, process.env.TT_BRIDGE_CARDS_ROOT ?? config.cardsRoot ?? '../cards'),
    cwd: ROOT,
  };
  backupExtension();
  fs.rmSync(EXT_DST, { recursive: true, force: true });
  // Preserve the source layout and configure this installation from the same token as the server.
  copyTree(EXT_SRC, EXT_DST);
  fs.writeFileSync(path.join(EXT_DST, 'connection.json'), JSON.stringify({ base: BRIDGE_BASE, token, launch: { ...launch, url: LAUNCH_URL } }) + '\n', { mode: 0o600 });
  return { token, launch };
}

// 面板「启动同步」打开 tt-card-bridge://start，Windows 按这里登记的命令静默启动后台。
// 只写当前用户的注册表（HKCU\Software\Classes），不是开机启动；install --remove 会删掉
const LAUNCH_URL = 'tt-card-bridge://start';
const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\tt-card-bridge';
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

// 早期安装方式会往开机启动文件夹写 tt-card-bridge.vbs；后台不开机自启，这里只负责清掉这个文件
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

// 停掉旧后台，并确认端口真的空出来了；停不掉就报错，不假装成功
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

// install 只登记启动方式并停掉旧后台；后台统一由用户在面板「启动同步」里拉起，酒馆关闭后自动退出（mirror.mjs）
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

function setOldScript(enabled) {
  const file = path.join(tavernUserDir(), 'settings.json');
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

if (NATIVE) {
  // 原生 SillyTavern 没有旧脚本，不动 settings.json；复制文件不受酒馆开关影响，装完刷新网页即可
  if (process.argv[2] === '--remove') {
    await removeBackgroundDaemon();
    backupExtension();
    fs.rmSync(EXT_DST, { recursive: true, force: true });
    console.log(`已卸载扩展：${EXT_DST}`);
  } else {
    const info = installExtension();
    await ensureBackgroundDaemon(info);
    console.log(`已安装扩展：${EXT_DST}\n在 SillyTavern 网页里刷新一次，扩展 → 管理扩展 里应能看到「tt-card-bridge（卡工程同步设置）」。`);
  }
  process.exit(0);
}

function needsSettingsWrite(targetEnabled) {
  try {
    const file = path.join(tavernUserDir(), 'settings.json');
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const old = s.extension_settings?.tavern_helper?.script?.scripts?.find(x => x.name === OLD_SCRIPT);
    return Boolean(old && old.enabled !== targetEnabled);
  } catch { return false; }
}

if (tavernRunning() && needsSettingsWrite(process.argv[2] === '--remove')) {
  console.log('酒馆开着时改设置会被酒馆覆盖。先关掉酒馆再运行。');
  process.exit(1);
}

if (process.argv[2] === '--remove') {
  await removeBackgroundDaemon();
  {
    const backupDir = path.join(tavernDataRoot(), 'backups', 'tt-card-bridge', `agent-setup-removed-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const r = removeAgentSetup({ dataRoot: tavernDataRoot(), backupDir });
    for (const f of r.removed) console.log(`已删除：${f}`);
    if (r.backups.length) console.log(`删除前备份：${r.backups.join('；')}`);
  }
  if (fs.existsSync(EXT_DST)) { backupExtension(); fs.rmSync(EXT_DST, { recursive: true, force: true }); console.log(`已卸载扩展：${EXT_DST}`); }
  else console.log('扩展没有安装');
  console.log(setOldScript(true));
  process.exit(0);
}

const info = installExtension();
await ensureBackgroundDaemon(info);
{
  const backupDir = path.join(tavernDataRoot(), 'backups', 'tt-card-bridge', `agent-setup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const r = installAgentSetup({ dataRoot: tavernDataRoot(), base: BRIDGE_BASE, token: info.token, backupDir });
  if (r.skipped) console.log(`没有自动登记 MCP：${r.reason}\n${manualSteps({ base: BRIDGE_BASE })}`);
  else {
    console.log(`已写 MCP 登记：${r.registration}`);
    console.log(`已写「卡工程」Agent 档案：${r.profile}`);
    if (r.backups.length) console.log(`旧文件备份：${r.backups.join('；')}`);
    console.log(manualSteps({ base: BRIDGE_BASE }));
  }
}
const ver = JSON.parse(fs.readFileSync(path.join(EXT_DST, 'manifest.json'), 'utf8')).version;
console.log(`已安装扩展 ${ver}：${EXT_DST}`);
console.log(setOldScript(false));
console.log('打开酒馆后，在 扩展 → 管理扩展 里应能看到「tt-card-bridge（卡工程同步设置）」。');
