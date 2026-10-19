// tt-paths.mjs — 找到酒馆实际使用的用户数据目录
// 默认是 TauriTavern：tauritavern-runtime.json 里的 data_root 优先，否则用默认的 AppData 目录。
// 用原生 SillyTavern 时，设环境变量 TAVERN_USER_DIR 指向它的用户目录（如 D:\SillyTavern\data\default-user），
// 或在 config.json 里写 "tavernUserDir"。环境变量优先。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'com.tauritavern.client');
const CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

function configured() {
  if (process.env.TAVERN_USER_DIR) return path.resolve(process.env.TAVERN_USER_DIR);
  try {
    const v = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).tavernUserDir;
    return v ? path.resolve(v) : null;
  } catch { return null; }
}

export function tavernDataRoot() {
  const u = configured();
  if (u) return path.dirname(u);
  const cfg = path.join(APP_ROOT, 'tauritavern-runtime.json');
  if (fs.existsSync(cfg)) {
    const { data_root } = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    if (data_root) return data_root;
  }
  return path.join(APP_ROOT, 'data');
}

// 是不是原生 SillyTavern（技能部署、Agent 配置只支持 TauriTavern）
export const isNativeSillyTavern = () => !!configured();
export const tavernUserDir = () => configured() ?? path.join(tavernDataRoot(), 'default-user');
export const tavernCharDir = () => path.join(tavernUserDir(), 'characters');
