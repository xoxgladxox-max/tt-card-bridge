// paths.mjs — 找到酒馆实际使用的用户数据目录，并提供只读环境探测
// 默认优先检查环境变量 TAVERN_USER_DIR 与本地配置 tavernUserDir；
// 未指定时自动探测 TauriTavern（tauritavern-runtime.json）与同级/父级原生 SillyTavern 目录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'com.tauritavern.client');
const CONFIG = path.join(ROOT, 'config.json');
const LOCAL_CONFIG = path.join(ROOT, '.runtime', 'config.local.json');
const EXAMPLE_CONFIG = path.join(ROOT, 'config.example.json');

function readJsonSafe(file) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; }
  catch { return {}; }
}

export function readBridgeConfig() {
  return { ...readJsonSafe(EXAMPLE_CONFIG), ...readJsonSafe(CONFIG), ...readJsonSafe(LOCAL_CONFIG) };
}

export function saveLocalBridgeConfig(patch) {
  fs.mkdirSync(path.dirname(LOCAL_CONFIG), { recursive: true });
  const next = { ...readJsonSafe(LOCAL_CONFIG), ...patch };
  fs.writeFileSync(LOCAL_CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

const isInsideTavernExtensions = () => {
  const p1 = path.basename(path.dirname(ROOT)).toLowerCase();
  const p2 = path.basename(path.resolve(ROOT, '..', '..')).toLowerCase();
  return p1 === 'extensions' || (p1 === 'third-party' && p2 === 'extensions');
};

export function resolveCardsRoot(override) {
  if (override) return path.resolve(ROOT, override);
  if (process.env.TT_BRIDGE_CARDS_ROOT) return path.resolve(ROOT, process.env.TT_BRIDGE_CARDS_ROOT);
  const cfg = readBridgeConfig();
  if (cfg.cardsRoot && !(cfg.cardsRoot === './cards' && isInsideTavernExtensions())) {
    const candidate = path.resolve(ROOT, cfg.cardsRoot);
    // 如果写的是本仓库相对路径，或磁盘上真实存在该目录（或其父目录存在），则采用；否则回退到默认 cards 目录
    if (!path.isAbsolute(cfg.cardsRoot) || fs.existsSync(candidate) || fs.existsSync(path.dirname(candidate))) {
      return candidate;
    }
  }
  return isInsideTavernExtensions() ? path.join(tavernDataRoot(), 'cards') : path.join(ROOT, 'cards');
}

export function resolveSkillsRoot(override) {
  const raw = override ?? process.env.TT_SKILLS_ROOT ?? readBridgeConfig().skillsRoot ?? '../card-forge-lab';
  if (!raw) return null;
  const resolved = path.resolve(ROOT, raw);
  return fs.existsSync(path.join(resolved, 'skills')) ? resolved : null;
}

function autoDetectNativeSillyTavern() {
  // 1. 如果插件被直接克隆在 SillyTavern/data/<user>/extensions/tt-card-bridge 下
  const p2 = path.resolve(ROOT, '..', '..');
  if (fs.existsSync(path.join(p2, 'characters')) && fs.existsSync(path.join(p2, 'worlds')) && !fs.existsSync(path.join(path.dirname(p2), '_tauritavern'))) return p2;
  // 2. 如果被克隆在 SillyTavern/public/scripts/extensions/third-party/tt-card-bridge 下
  const p4 = path.resolve(ROOT, '..', '..', '..', '..');
  if (fs.existsSync(path.join(p4, 'data', 'default-user', 'characters'))) return path.join(p4, 'data', 'default-user');
  // 3. 如果与 SillyTavern 并列放在同一父目录下
  for (const name of ['SillyTavern', 'SillyTavern-Launcher']) {
    const u = path.resolve(ROOT, '..', name, 'data', 'default-user');
    if (fs.existsSync(path.join(u, 'characters'))) return u;
  }
  return null;
}

function configured() {
  if (process.env.TAVERN_USER_DIR) return path.resolve(process.env.TAVERN_USER_DIR);
  const v = readBridgeConfig().tavernUserDir;
  if (v) return path.resolve(ROOT, v);
  return null;
}

function detectTauriTavernDataRoot() {
  const cfg = path.join(APP_ROOT, 'tauritavern-runtime.json');
  if (fs.existsSync(cfg)) {
    try {
      const { data_root } = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      if (data_root) return data_root;
    } catch { /* ignore */ }
  }
  const fallback = path.join(APP_ROOT, 'data');
  return fs.existsSync(fallback) ? fallback : null;
}

export function detectTavernEnvironment() {
  const explicitUser = configured();
  const ttRoot = detectTauriTavernDataRoot();
  const autoStUser = autoDetectNativeSillyTavern();
  const candidates = [];
  if (ttRoot && fs.existsSync(path.join(ttRoot, 'default-user'))) {
    candidates.push({ kind: 'tauritavern', label: 'TauriTavern', dataRoot: ttRoot, userDir: path.join(ttRoot, 'default-user') });
  }
  if (explicitUser) {
    candidates.push({ kind: 'sillytavern', label: '普通酒馆（原生 SillyTavern，已配置）', dataRoot: path.dirname(explicitUser), userDir: explicitUser });
  } else if (autoStUser) {
    candidates.push({ kind: 'sillytavern', label: '普通酒馆（原生 SillyTavern，自动发现）', dataRoot: path.dirname(autoStUser), userDir: autoStUser });
  }
  if (explicitUser) {
    return {
      found: fs.existsSync(explicitUser),
      kind: 'sillytavern',
      label: '普通酒馆（原生 SillyTavern）',
      dataRoot: path.dirname(explicitUser),
      userDir: explicitUser,
      extDst: isInsideTavernExtensions() ? ROOT : path.join(explicitUser, 'extensions', 'tt-card-bridge'),
      candidates,
    };
  }
  if (ttRoot) {
    const userDir = path.join(ttRoot, 'default-user');
    return {
      found: fs.existsSync(userDir),
      kind: 'tauritavern',
      label: 'TauriTavern',
      dataRoot: ttRoot,
      userDir,
      extDst: isInsideTavernExtensions() ? ROOT : path.join(ttRoot, 'extensions', 'third-party', 'tt-card-bridge'),
      candidates,
    };
  }
  if (autoStUser) {
    return {
      found: true,
      kind: 'sillytavern',
      label: '普通酒馆（原生 SillyTavern）',
      dataRoot: path.dirname(autoStUser),
      userDir: autoStUser,
      extDst: isInsideTavernExtensions() ? ROOT : path.join(autoStUser, 'extensions', 'tt-card-bridge'),
      candidates,
    };
  }
  const fallbackRoot = path.join(APP_ROOT, 'data');
  return {
    found: false,
    kind: 'missing',
    label: '未检测到酒馆数据目录',
    dataRoot: fallbackRoot,
    userDir: path.join(fallbackRoot, 'default-user'),
    extDst: path.join(fallbackRoot, 'extensions', 'third-party', 'tt-card-bridge'),
    candidates,
  };
}

export function tavernDataRoot() {
  const u = configured();
  if (u) return path.dirname(u);
  const ttRoot = detectTauriTavernDataRoot();
  if (ttRoot) return ttRoot;
  const autoSt = autoDetectNativeSillyTavern();
  if (autoSt) return path.dirname(autoSt);
  return path.join(APP_ROOT, 'data');
}

// 是不是原生 SillyTavern（技能部署、Agent 配置只支持 TauriTavern）
export const isNativeSillyTavern = () => Boolean(configured() || (!detectTauriTavernDataRoot() && autoDetectNativeSillyTavern()));
export const tavernUserDir = () => configured() ?? (detectTauriTavernDataRoot() ? path.join(detectTauriTavernDataRoot(), 'default-user') : (autoDetectNativeSillyTavern() ?? path.join(APP_ROOT, 'data', 'default-user')));
export const tavernCharDir = () => path.join(tavernUserDir(), 'characters');
