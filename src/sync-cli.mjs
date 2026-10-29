import fs from 'node:fs';
import path from 'node:path';
import { BRIDGE_ROOT, bridgeRequest } from './connection.mjs';
import { tavernUserDir, resolveCardsRoot, resolveSkillsRoot } from './paths.mjs';
import { FileSyncAdapter } from './file-sync-adapter.mjs';
import { SyncEngine } from './sync-engine.mjs';
import { startBridge, stopBridge } from './bridge.mjs';
import { fail, nodeFiles, hashObject } from './safety.mjs';

// CLI remains an entry into the same engine. If a service already owns the port,
// managed projects enter its queue rather than performing filesystem writes in a second process.
export async function runSyncCli(direction, args = process.argv.slice(2)) {
  const [dirArg, targetArg] = args.filter(a => !a.startsWith('--'));
  const dry = args.includes('--dry-run'), watch = args.includes('--watch'), force = args.includes('--force'), book = args.includes('--book');
  if (!dirArg || (!targetArg && !book)) fail('USAGE', `tt-card ${direction} <节点工程> <卡.png> [--dry-run] [--watch] [--force]\n独立世界书：tt-card ${direction} <节点工程> --book [世界书名]`, 400);
  const skillsRoot = resolveSkillsRoot();
  const cardsRoot = resolveCardsRoot();
  const adapter = new FileSyncAdapter({ skillsRoot, userDir: tavernUserDir(), cardsRoot });
  const dir = path.resolve(dirArg);
  if (!fs.existsSync(path.join(dir, 'card.md'))) fail('INVALID_PROJECT', '卡工程没有 card.md', 400);
  let target = targetArg;
  if (book && !target) { const { nodes, build } = await adapter.libraries(); target = build.assemble(await nodes.scanCard(dir)).card.data?.extensions?.world; }
  if (!target) fail('INVALID_PROJECT', '缺少世界书名', 400);
  const project = { dir, cardFile: book ? `world:${target}` : target };
  const engine = new SyncEngine(adapter);
  // --dry-run does not start a listener, create credentials, backups, baselines or runtime files.
  if (dry) { console.log(JSON.stringify(await engine.inspect(project), null, 2)); return; }
  const owned = await startBridge();
  let remoteProjectId = null;
  if (!owned) {
    const status = (await bridgeRequest('status')).data;
    const relative = path.relative(status.cardsRoot, dir).split(path.sep).join('/');
    let bound = status.projects.find(p => p.id === relative && p.cardFile === project.cardFile && p.attached);
    if (!bound && book) bound = (await bridgeRequest('control', { action: 'bindWorld', projectId: relative, worldName: target })).data;
    if (!bound) fail('SERVICE_OWNS_WRITES', '后台正在管理同步；此工程尚未接管，不能通过第二条 CLI 路径写入');
    remoteProjectId = relative;
  }
  const run = async () => {
    const result = remoteProjectId
      ? (await bridgeRequest('control', { action: 'sync', projectId: remoteProjectId, direction, force })).data.results[0]
      : await engine.run(project, { direction, force });
    if (result.error) fail(result.error.code, result.error.message, 409, result.error.details);
    console.log(JSON.stringify(result, null, 2));
  };
  if (!watch) { try { await run(); } finally { if (owned) stopBridge(); } return; }
  let busy = false, last = null;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const hash = hashObject(Object.fromEntries(nodeFiles(dir).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')])));
      if (hash !== last) { await run(); last = hash; }
    } catch (e) { console.error(`${e.code ?? 'ERROR'}: ${e.message}`); }
    finally { busy = false; }
  };
  await tick();
  const timer = setInterval(tick, 2000);
  process.on('SIGINT', () => { clearInterval(timer); if (owned) stopBridge(); });
}
