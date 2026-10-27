// One source for bindings and target occupancy, shared by service and standalone CLI.
import fs from 'node:fs';
import path from 'node:path';
import { contained, segment, readJson } from './safety.mjs';

export const occupiesTarget = record => record.attached || !!record.pendingOperation;
export const reservedTargets = record => occupiesTarget(record) ? [...new Set([record.cardFile, record.pendingOperation?.targetCardFile].filter(Boolean).map(x => x.toLowerCase()))] : [];
export const targetOccupied = (record, target) => reservedTargets(record).includes(target.toLowerCase());
// 工作区布局：cards/<卡名>/ 一张卡一个文件夹；cards/backups/ 是旧版备份目录，不是工程
export const BACKUPS_DIR = 'backups';
export const INTERNAL_SUBDIRS = new Set([
  'backups', 'dist', 'world_book', 'message', 'regex', 'scripts', 'note',
  '记录', '候选', '待归位',
  'world', 'character', 'greeting', 'output', 'style', 'archive', 'export', 'logs', 'tools',
]);
export function isSingleCardDirectory(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, 'card.md')) || fs.existsSync(path.join(dir, 'index.md')) || fs.existsSync(path.join(dir, '.card-forge'))) return true;
  if (fs.existsSync(path.join(dir, 'world_book')) || fs.existsSync(path.join(dir, 'message'))) return true;
  if (fs.existsSync(path.join(dir, 'world')) && fs.existsSync(path.join(dir, 'character'))) return true;
  return false;
}
export function isLegacyNodeDirectory(dir) {
  if (!dir || !fs.existsSync(dir) || fs.existsSync(path.join(dir, 'card.md'))) return false;
  if (fs.existsSync(path.join(dir, 'index.md'))) return true;
  return ['world', 'character', 'greeting', 'output', 'style'].some(sub => {
    const p = path.join(dir, sub);
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  });
}
export function projectRecordFromDir(dir, id = segment(path.basename(dir))) {
  const resolved = path.resolve(dir);
  const folderName = path.basename(resolved);
  const binding = readJson(contained(resolved, '.card-forge/bridge.json'), {});
  const mirror = readJson(contained(resolved, '.card-forge/mirror.json'));
  const baseline = readJson(contained(resolved, '.card-forge/tavern-sync.json'));
  const operation = readJson(contained(resolved, '.card-forge/operation.json'));
  const pendingOperation = operation ? { jobId: operation.jobId, state: operation.state, targetCardFile: operation.targetCardFile ?? binding.operation?.targetCardFile ?? null } : binding.operation ?? null;
  const cardFile = binding.cardFile ?? mirror?.cardFile ?? baseline?.cardFile ?? operation?.cardFile ?? pendingOperation?.targetCardFile ?? null;
  const targetKind = cardFile?.startsWith('world:') ? 'world' : 'card';
  if (cardFile) segment(targetKind === 'world' ? cardFile.slice(6) : cardFile, '同步目标');
  return {
    id,
    dir: resolved,
    name: folderName,
    cardFile,
    targetKind,
    binding,
    attached: !!cardFile && !binding.detached,
    detached: binding.detached ?? false,
    paused: binding.paused ?? false,
    projectName: binding.projectName ?? (targetKind === 'card' && cardFile ? cardFile.slice(0, -4) : folderName),
    pendingOperation,
  };
}
// 工作区目录里的卡工程：只认已有 card.md 或 .card-forge 的文件夹；普通文件夹（素材、仓库、下载）一律不算卡工程
export function isCardProjectDirectory(dir) {
  return fs.existsSync(path.join(dir, 'card.md')) || fs.existsSync(path.join(dir, '.card-forge'));
}
export function discoverProjects(cardsRoot, { accept = isCardProjectDirectory } = {}) {
  if (!cardsRoot || !fs.existsSync(cardsRoot)) return [];
  const records = [];
  for (const entry of fs.readdirSync(cardsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === BACKUPS_DIR) continue;
    const id = segment(entry.name), dir = contained(cardsRoot, id);
    if (INTERNAL_SUBDIRS.has(entry.name) && !fs.existsSync(path.join(dir, '.card-forge', 'bridge.json')) && !fs.existsSync(path.join(dir, 'card.md'))) continue;
    if (!accept(dir)) continue;
    records.push(projectRecordFromDir(dir, id));
  }
  return records;
}
export function sameProjectPath(a, b) { return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b); }
