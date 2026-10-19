// Node project -> Tavern. Assembly, comparison, backups and baseline commits live in SyncEngine.
import { runSyncCli } from './sync-cli.mjs';
try { await runSyncCli('push'); }
catch (e) { console.error(`${e.code ?? 'ERROR'}: ${e.message}`); process.exitCode = 1; }
