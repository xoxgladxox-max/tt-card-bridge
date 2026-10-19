#!/usr/bin/env node
// tt-card：一个入口，按第一个参数转到对应模块
//   tt-card mirror ["<cards 目录>"]      管理同步服务；首次全局暂停，由面板明确启用
//   tt-card push "<节点工程>" "<卡.png>" [--watch]  节点工程 → 酒馆（卡 + 卡绑定的世界书）
//   tt-card pull "<节点工程>" "<卡.png>" [--dry-run]  酒馆 → 节点工程；冲突交面板决定
//   tt-card skills status|deploy|versions|rollback|install-script
//   tt-card probe ...                     只读查看酒馆角色卡
//   tt-card install [--remove]            把酒馆扩展装进酒馆（酒馆需关着）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODS = { mirror: 'mirror.mjs', push: 'push.mjs', pull: 'pull.mjs', skills: 'skills.mjs', probe: 'probe.mjs', install: 'install.mjs' };
const [sub, ...rest] = process.argv.slice(2);
if (!MODS[sub]) {
  console.log('用法：tt-card <mirror|push|pull|skills|probe|install> ...\n  tt-card mirror ["<cards 目录>"]\n  tt-card push "<节点工程>" "<卡.png>" [--watch] [--force]\n  tt-card push "<节点工程>" --book ["<世界书名>"] [--watch] [--force]\n  tt-card pull "<节点工程>" "<卡.png>" [--dry-run]\n  tt-card pull "<节点工程>" --book ["<世界书名>"] [--dry-run]\n  tt-card skills status');
  process.exit(2);
}
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', MODS[sub]);
process.argv = [process.argv[0], file, ...rest];
await import(pathToFileURL(file).href);