// Tavern -> existing node bodies. Conflicts and unsupported structural changes are never assumed safe.
import { runSyncCli } from './sync-cli.mjs';
try { await runSyncCli('pull'); }
catch (e) { console.error(`${e.code ?? 'ERROR'}: ${e.message}`); process.exitCode = 1; }
