// Managed background service. Existing mirror/sync records are read in place, never reset.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { BRIDGE_ROOT } from './connection.mjs';
import { tavernUserDir, resolveCardsRoot, resolveSkillsRoot, saveLocalBridgeConfig } from './paths.mjs';
import { FileSyncAdapter } from './file-sync-adapter.mjs';
import { SyncService } from './sync-service.mjs';
import { startBridge, stopBridge, getLastClientSeenAt } from './bridge.mjs';

const configFile = path.join(BRIDGE_ROOT, 'config.json');
const skillsRoot = resolveSkillsRoot();
const cardsRoot = resolveCardsRoot(process.argv[2]);
const adapter = new FileSyncAdapter({ skillsRoot, userDir: tavernUserDir() });
let stopping = false, parentWatch = null;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(parentWatch);
  console.log('正在停止：等待当前写入完成，不强杀任务');
  await service.stop(); stopBridge();
}
function saveCardsRoot(newRoot) {
  try {
    saveLocalBridgeConfig({ cardsRoot: newRoot });
    if (fs.existsSync(configFile)) {
      const current = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      current.cardsRoot = newRoot;
      fs.writeFileSync(configFile, JSON.stringify(current, null, 2) + '\n', 'utf8');
    }
  } catch { /* ignore */ }
}
const service = new SyncService({ cardsRoot, runtimeRoot: path.join(BRIDGE_ROOT, '.runtime'), adapter, onShutdown: shutdown, onCardsRootChange: saveCardsRoot });
if (!(await startBridge(console.log, { service }))) throw new Error('已有 bridge 进程；不会同时启动第二个同步服务');
service.start();
console.log(`同步服务已启动：${cardsRoot}；${service.state.paused ? '全局暂停，等待明确启用' : '恢复上次启用状态'}`);
// 后台跟酒馆同进同出（不开机启动，关掉酒馆后台也关）。
// 见过酒馆进程之后酒馆没了就退出；启动后 2 分钟内一直没见到酒馆（比如 install 时酒馆关着）也退出。
// TT_BRIDGE_STAY=1 时不跟随（只用命令行、不开酒馆时用）
const TAVERN_EXE = /^(tauritavern|tauri-tavern)\.exe$/i;
function tavernAlive() {
  // 普通酒馆（原生 SillyTavern）运行在浏览器里，靠前端扩展心跳判断；TauriTavern 同时支持进程名与前端心跳
  if (getLastClientSeenAt() > 0 && Date.now() - getLastClientSeenAt() < 15000) return true;
  try { return execSync('tasklist /FO CSV /NH', { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).some(line => TAVERN_EXE.test(line.split('","')[0].replace(/^"/, ''))); }
  catch { return true; } // 查不到时不乱退出
}
if (process.platform === 'win32' && process.env.TT_BRIDGE_STAY !== '1') {
  const startedAt = Date.now(); let seen = false;
  parentWatch = setInterval(() => {
    if (tavernAlive()) { seen = true; return; }
    if (seen || Date.now() - startedAt > 120000) { console.log('酒馆已关闭，后台随之退出'); void shutdown(); }
  }, 3000);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
