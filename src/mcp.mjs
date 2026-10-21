// 给 TT Agent 用的 MCP 接口（Streamable HTTP，只回 JSON，不开 SSE）。
// 所有路径都限定在工作区目录 cardsRoot 内；Agent 没有改目录、执行命令的工具。
// 写入规则：已有文件必须带 baseHash（读文件时拿到的），对不上就拒绝；覆盖、删除、移动前一律先备份
// （不看「覆盖写入前自动备份」开关）；同一张卡的写入和后台同步共用一条队列，不会交错。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { contained, digest, fail, atomicJson, readJson } from './safety.mjs';
import { BACKUPS_DIR } from './projects.mjs';

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const FILE_BACKUPS = 'files';
const MAX_READ_BYTES = 2 * 1024 * 1024;
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.js', '.mjs', '.html', '.css', '.csv']);

// ---------- 路径 ----------
function normRel(raw, { allowRoot = false } = {}) {
  if (raw === undefined || raw === null) raw = '';
  if (typeof raw !== 'string') fail('INVALID_PATH', 'path 必须是字符串', 400);
  const rel = raw.trim().replaceAll('\\', '/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '');
  if (!rel || rel === '.') { if (allowRoot) return ''; fail('INVALID_PATH', '需要工作区目录内的相对路径', 400); }
  return rel;
}
const abs = (root, rel) => rel ? contained(root, rel) : path.resolve(root);
// 写入时额外拦住：.card-forge 等点开头的内部目录、工作区目录下的 backups/
function assertWritable(rel) {
  const parts = rel.split('/');
  if (parts.some(p => p.startsWith('.'))) fail('FORBIDDEN_PATH', '不能写点开头的内部文件或目录（如 .card-forge）', 403);
  if (parts[0].toLowerCase() === BACKUPS_DIR) fail('FORBIDDEN_PATH', 'backups/ 由后台管理，不能直接写；恢复请用 restore_backup', 403);
}
const lockKey = rel => { const parts = rel.split('/'); return parts.length > 1 ? parts[0].toLowerCase() : null; };
const fileHash = file => digest(fs.readFileSync(file));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

// ---------- 工具定义 ----------
const str = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PATH = str('工作区目录内的相对路径，用 / 分隔，如「示例卡/world_book/地点/城门.md」');
const HASH = str('读文件时返回的 hash；修改、删除、移动已有文件时必须带上，对不上说明文件已被别人改过');
const PROJECT = str('卡工程名，即工作区目录下的卡文件夹名');
export const TOOLS = [
  { name: 'status', description: '查看工作区目录、同步是否暂停、酒馆当前打开的卡和世界书、各卡工程的同步状态。', inputSchema: obj({}), annotations: { readOnlyHint: true } },
  { name: 'list_files', description: '列出目录内容（不含点开头的内部文件）。depth 默认 1，最大 6。', inputSchema: obj({ path: str('目录相对路径，留空为工作区目录根'), depth: { type: 'integer', minimum: 1, maximum: 6 } }), annotations: { readOnlyHint: true } },
  { name: 'read_file', description: '读取文本文件，返回内容和 hash。可用 startLine/endLine 只读一段，hash 始终是整份文件的。', inputSchema: obj({ path: PATH, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, ['path']), annotations: { readOnlyHint: true } },
  { name: 'search_files', description: '在文本文件里按关键字（或正则）搜索，返回文件、行号和该行内容。', inputSchema: obj({ query: str('要找的文字'), path: str('只在这个目录下找，留空为全部'), regex: { type: 'boolean' }, maxResults: { type: 'integer', minimum: 1, maximum: 500 } }, ['query']), annotations: { readOnlyHint: true } },
  { name: 'file_info', description: '查看文件或目录是否存在、类型、大小、修改时间；文件还会给出 hash。', inputSchema: obj({ path: PATH }, ['path']), annotations: { readOnlyHint: true } },
  { name: 'write_file', description: '写入整份文件。新建时不带 baseHash；覆盖已有文件时必须带 baseHash，覆盖前自动备份。', inputSchema: obj({ path: PATH, content: str('完整文件内容'), baseHash: HASH }, ['path', 'content']) },
  { name: 'apply_patch', description: '按原文精确替换。每处 oldText 必须在文件里恰好出现一次。必须带 baseHash，改前自动备份。', inputSchema: obj({ path: PATH, baseHash: HASH, edits: { type: 'array', minItems: 1, items: obj({ oldText: str('要替换的原文（必须与文件完全一致）'), newText: str('替换后的文字') }, ['oldText', 'newText']) } }, ['path', 'baseHash', 'edits']) },
  { name: 'create_dir', description: '新建目录（可多层）。', inputSchema: obj({ path: PATH }, ['path']) },
  { name: 'move', description: '移动或改名。目标不能已存在。移动文件要带 baseHash；不能移动卡工程文件夹本身。', inputSchema: obj({ from: PATH, to: PATH, baseHash: HASH }, ['from', 'to']) },
  { name: 'delete', description: '删除文件或子目录：实际是移入备份，可用 restore_backup 找回。删文件要带 baseHash；不能删卡工程文件夹本身。', inputSchema: obj({ path: PATH, baseHash: HASH }, ['path']) },
  { name: 'disassemble_card', description: '把酒馆里当前打开的那张卡拆到工作区目录（只能拆当前打开的卡）。文件夹已存在时需 overwrite:true，覆盖前自动备份。', inputSchema: obj({ overwrite: { type: 'boolean' } }) },
  { name: 'assemble_card', description: '把工作区目录里的卡工程合成后写进酒馆，写前自动备份。酒馆已有同名卡时需选 overwrite 或 createNewCopy。', inputSchema: obj({ projectId: PROJECT, overwrite: { type: 'boolean' }, createNewCopy: { type: 'boolean' } }, ['projectId']) },
  { name: 'sync_now', description: '立即对一张已接入酒馆的卡做一次双向同步，写前自动备份。两边都改过时返回冲突，不会自动覆盖。', inputSchema: obj({ projectId: PROJECT }, ['projectId']) },
  { name: 'validate_card', description: '按 card-forge 协议检查卡工程，列出错误和警告，不写任何文件。', inputSchema: obj({ projectId: PROJECT }, ['projectId']), annotations: { readOnlyHint: true } },
  { name: 'validate_worldbook', description: '只检查卡工程 world_book/ 里的条目，不写任何文件。', inputSchema: obj({ projectId: PROJECT }, ['projectId']), annotations: { readOnlyHint: true } },
  { name: 'list_backups', description: '列出备份：kind=file 为文件改动前的备份（可按 path 过滤）；kind=card 为整卡同步前的备份（需 projectId）。', inputSchema: obj({ kind: { type: 'string', enum: ['file', 'card'] }, path: str('只看这个路径的文件备份'), projectId: PROJECT, limit: { type: 'integer', minimum: 1, maximum: 200 } }), annotations: { readOnlyHint: true } },
  { name: 'restore_backup', description: '恢复备份。kind=file：把文件放回原位，原位已有文件时要带它当前的 baseHash，并先备份当前文件。kind=card：第一次调用只返回预览和 previewId，带 previewId 与 confirm:true 再调用才写进酒馆。', inputSchema: obj({ kind: { type: 'string', enum: ['file', 'card'] }, backupId: str('list_backups 返回的 id'), baseHash: HASH, projectId: PROJECT, previewId: str('kind=card 第二步用'), confirm: { type: 'boolean' } }, ['kind', 'backupId']) },
];

// ---------- 工具实现 ----------
export function createMcpTools(service) {
  const root = () => service.cardsRoot;
  const withLock = (rels, label, fn) => {
    const keys = [...new Set(rels.map(lockKey))];
    // 涉及两张卡（跨卡移动）或根目录文件时走全局队列
    const key = keys.length === 1 ? keys[0] : null;
    return service.queue.run({ action: `mcp:${label}`, projectId: key }, fn, key);
  };
  const backupsRoot = () => path.join(root(), BACKUPS_DIR, FILE_BACKUPS);
  // 改动前备份：copy 用于覆盖，move 用于删除/移动（同一个盘内直接改名，不复制大目录）
  function backupPath(rel, op, mode = 'copy') {
    const src = abs(root(), rel);
    if (!fs.existsSync(src)) return null;
    const id = `${stamp()}-${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(backupsRoot(), id);
    fs.mkdirSync(dir, { recursive: true });
    const isDir = fs.statSync(src).isDirectory();
    const dst = path.join(dir, 'content');
    if (mode === 'move') fs.renameSync(src, dst);
    else if (isDir) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
    atomicJson(path.join(dir, 'meta.json'), { id, path: rel, op, isDir, hash: isDir ? null : fileHash(dst), at: new Date().toISOString() });
    return id;
  }
  function checkHash(file, rel, baseHash, required) {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).isDirectory()) return;
    if (!baseHash) { if (required) fail('BASE_HASH_REQUIRED', `「${rel}」已存在，需要先 read_file 拿到 hash 再写`, 409); return; }
    const now = fileHash(file);
    if (now !== baseHash) fail('HASH_MISMATCH', `「${rel}」在你读取之后被改过（可能是作者在 VS Code 里改的或同步写回的），请重新读取再改`, 409, { currentHash: now });
  }
  function writeAtomic(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, file);
  }
  const isTopDir = rel => !rel.includes('/');
  function walk(dirAbs, relBase, depth, out, limit = 5000) {
    for (const e of fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      if (!relBase && e.name.toLowerCase() === BACKUPS_DIR) continue;
      if (out.length >= limit) return;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push({ path: rel, type: 'dir' }); if (depth > 1) walk(path.join(dirAbs, e.name), rel, depth - 1, out, limit); }
      else if (e.isFile()) out.push({ path: rel, type: 'file', size: fs.statSync(path.join(dirAbs, e.name)).size });
    }
  }
  const projectDir = id => {
    if (typeof id !== 'string' || !id.trim()) fail('PROJECT_REQUIRED', '需要 projectId（卡文件夹名）', 400);
    const dir = contained(root(), id.trim());
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail('PROJECT_NOT_FOUND', `工作区目录里没有「${id}」`, 404);
    return dir;
  };
  async function validate(projectId, onlyBook) {
    const dir = projectDir(projectId);
    const { nodes, protocol } = await service.adapter.libraries();
    const report = protocol.validateNodes(await nodes.scanCard(dir));
    const pick = list => list.filter(x => !onlyBook || String(x.node ?? '').replaceAll('\\', '/').startsWith('world_book'))
      .map(x => ({ file: String(x.node ?? '').replaceAll('\\', '/'), rule: x.rule, message: x.message }));
    const errors = pick(report.errors), warnings = pick(report.warnings);
    return { projectId, ok: !errors.length, errors, warnings };
  }
  const control = body => service.control(body);
  const forcedBackup = { skipBackup: false };

  return {
    async status() {
      const s = await service.status();
      return {
        cardsRoot: s.cardsRoot, paused: s.paused, activeCardFile: s.activeCardFile, activeWorld: s.activeWorld,
        currentTask: s.currentTask, queuedTasks: s.queuedTasks,
        projects: s.projects.map(p => ({ id: p.id, cardFile: p.cardFile, attached: p.attached, status: p.status, error: p.lastResult?.error ? { code: p.lastResult.error.code, message: p.lastResult.error.message } : null })),
      };
    },
    async list_files({ path: p, depth = 1 } = {}) {
      const rel = normRel(p, { allowRoot: true }), dir = abs(root(), rel);
      if (!fs.existsSync(dir)) fail('NOT_FOUND', `不存在：${rel || '/'}`, 404);
      if (!fs.statSync(dir).isDirectory()) fail('NOT_A_DIRECTORY', `不是目录：${rel}`, 400);
      const out = []; walk(dir, rel, Math.min(Math.max(1, depth | 0 || 1), 6), out);
      return { path: rel, entries: out, truncated: out.length >= 5000 };
    },
    async read_file({ path: p, startLine, endLine }) {
      const rel = normRel(p), file = abs(root(), rel);
      if (!fs.existsSync(file)) fail('NOT_FOUND', `不存在：${rel}`, 404);
      const st = fs.statSync(file);
      if (st.isDirectory()) fail('IS_DIRECTORY', `是目录：${rel}，请用 list_files`, 400);
      const buf = fs.readFileSync(file), hash = digest(buf);
      if (buf.includes(0)) fail('BINARY_FILE', `「${rel}」不是文本文件`, 415, { hash, size: st.size });
      let content = buf.toString('utf8');
      const totalLines = content.split('\n').length;
      if (startLine || endLine) {
        const lines = content.split('\n'), s = (startLine ?? 1) - 1, e = endLine ?? lines.length;
        content = lines.slice(s, e).join('\n');
      } else if (buf.length > MAX_READ_BYTES) fail('FILE_TOO_LARGE', `「${rel}」超过 2MB，请用 startLine/endLine 分段读`, 413, { hash, size: st.size, totalLines });
      return { path: rel, hash, size: st.size, totalLines, ...(startLine || endLine ? { startLine: startLine ?? 1, endLine: Math.min(endLine ?? totalLines, totalLines) } : {}), content };
    },
    async search_files({ query, path: p, regex = false, maxResults = 100 }) {
      if (typeof query !== 'string' || !query) fail('INVALID_QUERY', 'query 不能为空', 400);
      let re;
      try { re = regex ? new RegExp(query, 'i') : null; } catch (e) { fail('INVALID_QUERY', `正则无效：${e.message}`, 400); }
      const needle = query.toLowerCase();
      const rel = normRel(p, { allowRoot: true }), dir = abs(root(), rel);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail('NOT_FOUND', `目录不存在：${rel || '/'}`, 404);
      const files = []; walk(dir, rel, 30, files, 20000);
      const hits = [];
      for (const f of files) {
        if (f.type !== 'file' || !TEXT_EXT.has(path.extname(f.path).toLowerCase()) || f.size > MAX_READ_BYTES) continue;
        const lines = fs.readFileSync(abs(root(), f.path), 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle)) {
            hits.push({ path: f.path, line: i + 1, text: lines[i].slice(0, 300) });
            if (hits.length >= maxResults) return { results: hits, truncated: true };
          }
        }
      }
      return { results: hits, truncated: false };
    },
    async file_info({ path: p }) {
      const rel = normRel(p), file = abs(root(), rel);
      if (!fs.existsSync(file)) return { path: rel, exists: false };
      const st = fs.statSync(file);
      return { path: rel, exists: true, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtime.toISOString(), ...(st.isDirectory() ? {} : { hash: fileHash(file) }) };
    },
    async write_file({ path: p, content, baseHash }) {
      const rel = normRel(p); assertWritable(rel);
      if (typeof content !== 'string') fail('INVALID_CONTENT', 'content 必须是字符串', 400);
      return withLock([rel], 'write_file', async () => {
        const file = abs(root(), rel);
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) fail('IS_DIRECTORY', `是目录：${rel}`, 400);
        const existed = fs.existsSync(file);
        if (!existed && baseHash) fail('HASH_MISMATCH', `「${rel}」不存在（可能已被移走），不能按旧 hash 写`, 409);
        checkHash(file, rel, baseHash, true);
        const backupId = existed ? backupPath(rel, 'write_file') : null;
        writeAtomic(file, content);
        return { path: rel, created: !existed, hash: fileHash(file), backupId };
      });
    },
    async apply_patch({ path: p, baseHash, edits }) {
      const rel = normRel(p); assertWritable(rel);
      if (!Array.isArray(edits) || !edits.length) fail('INVALID_PATCH', 'edits 不能为空', 400);
      return withLock([rel], 'apply_patch', async () => {
        const file = abs(root(), rel);
        if (!fs.existsSync(file)) fail('NOT_FOUND', `不存在：${rel}`, 404);
        if (!baseHash) fail('BASE_HASH_REQUIRED', '需要先 read_file 拿到 hash', 409);
        checkHash(file, rel, baseHash, true);
        let text = fs.readFileSync(file, 'utf8');
        // 文件可能是 CRLF：原文按 LF 写来时也能对上，替换后保持文件原来的换行
        const crlf = text.includes('\r\n');
        if (crlf) text = text.replaceAll('\r\n', '\n');
        edits.forEach((e, i) => {
          if (typeof e?.oldText !== 'string' || !e.oldText || typeof e.newText !== 'string') fail('INVALID_PATCH', `第 ${i + 1} 处缺少 oldText/newText`, 400);
          const oldText = e.oldText.replaceAll('\r\n', '\n'), newText = e.newText.replaceAll('\r\n', '\n');
          const count = text.split(oldText).length - 1;
          if (count !== 1) fail('PATCH_NOT_UNIQUE', `第 ${i + 1} 处原文在文件里出现 ${count} 次，必须恰好 1 次`, 409);
          text = text.replace(oldText, () => newText);
        });
        const backupId = backupPath(rel, 'apply_patch');
        writeAtomic(file, crlf ? text.replaceAll('\n', '\r\n') : text);
        return { path: rel, hash: fileHash(file), backupId, applied: edits.length };
      });
    },
    async create_dir({ path: p }) {
      const rel = normRel(p); assertWritable(rel);
      const dir = abs(root(), rel);
      if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) fail('ALREADY_EXISTS', `同名文件已存在：${rel}`, 409);
      fs.mkdirSync(dir, { recursive: true });
      return { path: rel, created: true };
    },
    async move({ from, to, baseHash }) {
      const a = normRel(from), b = normRel(to); assertWritable(a); assertWritable(b);
      if (isTopDir(a) && fs.existsSync(abs(root(), a)) && fs.statSync(abs(root(), a)).isDirectory()) fail('FORBIDDEN_PATH', '不能移动卡工程文件夹本身（它和酒馆里的卡绑定着）', 403);
      return withLock([a, b], 'move', async () => {
        const src = abs(root(), a), dst = abs(root(), b);
        if (!fs.existsSync(src)) fail('NOT_FOUND', `不存在：${a}`, 404);
        if (fs.existsSync(dst)) fail('ALREADY_EXISTS', `目标已存在：${b}`, 409);
        checkHash(src, a, baseHash, true);
        const backupId = backupPath(a, 'move');
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        return { from: a, to: b, backupId };
      });
    },
    async delete({ path: p, baseHash }) {
      const rel = normRel(p); assertWritable(rel);
      if (isTopDir(rel) && fs.existsSync(abs(root(), rel)) && fs.statSync(abs(root(), rel)).isDirectory()) fail('FORBIDDEN_PATH', '不能删除卡工程文件夹本身；请作者在资源管理器里处理', 403);
      return withLock([rel], 'delete', async () => {
        const file = abs(root(), rel);
        if (!fs.existsSync(file)) fail('NOT_FOUND', `不存在：${rel}`, 404);
        checkHash(file, rel, baseHash, true);
        const backupId = backupPath(rel, 'delete', 'move');
        return { path: rel, deleted: true, backupId };
      });
    },
    async disassemble_card({ overwrite = false } = {}) {
      const cardFile = service.state.activeCardFile;
      if (!cardFile) fail('NO_ACTIVE_CARD', '酒馆里没有打开角色卡（或是群聊）；请作者先在酒馆里打开要拆的卡', 409);
      return control({ action: 'attach', cardFile, overwrite: Boolean(overwrite), ...forcedBackup });
    },
    async assemble_card({ projectId, overwrite = false, createNewCopy = false }) {
      projectDir(projectId);
      return control({ action: 'importFromWorkspace', projectId: projectId.trim(), overwrite: Boolean(overwrite), createNewCopy: Boolean(createNewCopy), ...forcedBackup });
    },
    async sync_now({ projectId }) {
      projectDir(projectId);
      return control({ action: 'sync', projectId: projectId.trim(), ...forcedBackup });
    },
    validate_card: ({ projectId }) => validate(projectId, false),
    validate_worldbook: ({ projectId }) => validate(projectId, true),
    async list_backups({ kind = 'file', path: p, projectId, limit = 50 } = {}) {
      if (kind === 'card') {
        projectDir(projectId);
        const res = await control({ action: 'backups', projectId: projectId.trim() });
        return { kind, projectId, backups: (res.backups ?? []).slice(0, limit) };
      }
      const dir = backupsRoot(), filter = p ? normRel(p) : null;
      const list = fs.existsSync(dir) ? fs.readdirSync(dir).sort().reverse().map(id => readJson(path.join(dir, id, 'meta.json'))).filter(Boolean) : [];
      return { kind, backups: list.filter(m => !filter || m.path === filter || m.path.startsWith(`${filter}/`)).slice(0, limit) };
    },
    async restore_backup({ kind, backupId, baseHash, projectId, previewId, confirm }) {
      if (kind === 'card') {
        projectDir(projectId);
        if (!previewId) return { step: 'preview', ...(await control({ action: 'restorePreview', projectId: projectId.trim(), backupId })), next: '确认无误后带 previewId 和 confirm:true 再调用一次' };
        if (confirm !== true) fail('CONFIRMATION_REQUIRED', '写进酒馆前需要 confirm:true', 400);
        return control({ action: 'restore', projectId: projectId.trim(), previewId, confirm: true, ...forcedBackup });
      }
      if (typeof backupId !== 'string' || !/^[\w-]+$/.test(backupId)) fail('INVALID_BACKUP', 'backupId 无效', 400);
      const dir = path.join(backupsRoot(), backupId), meta = readJson(path.join(dir, 'meta.json'));
      if (!meta) fail('BACKUP_NOT_FOUND', `没有这个备份：${backupId}`, 404);
      const rel = normRel(meta.path); assertWritable(rel);
      return withLock([rel], 'restore_backup', async () => {
        const target = abs(root(), rel), src = path.join(dir, 'content');
        if (!fs.existsSync(src)) fail('BACKUP_NOT_FOUND', '备份内容已不在', 404);
        let replacedBackupId = null;
        if (fs.existsSync(target)) {
          if (meta.isDir || fs.statSync(target).isDirectory()) fail('ALREADY_EXISTS', `原位置已有目录「${rel}」，请先移走`, 409);
          checkHash(target, rel, baseHash, true);
          replacedBackupId = backupPath(rel, 'restore_backup');
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (meta.isDir) fs.cpSync(src, target, { recursive: true }); else fs.copyFileSync(src, target);
        return { path: rel, restoredFrom: backupId, replacedBackupId, ...(meta.isDir ? {} : { hash: fileHash(target) }) };
      });
    },
  };
}

// ---------- JSON-RPC ----------
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
export function createMcpHandler(service, { version = '0' } = {}) {
  const tools = createMcpTools(service);
  async function one(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid Request');
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return null;
    const { id, method, params = {} } = msg;
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return { jsonrpc: '2.0', id, result: {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tt-card-bridge', version },
          instructions: '卡工程工作区目录的文件工具。路径都是相对工作区目录的，用 / 分隔。改已有文件前先 read_file 拿 hash，写入时作为 baseHash 传回。',
        } };
      }
      case 'ping': return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const name = params?.name, fn = tools[name];
        if (!fn) return rpcError(id, -32602, `未知工具：${name}`);
        try {
          const data = await fn(params.arguments ?? {});
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false } };
        } catch (e) {
          const error = { code: e.code ?? 'INTERNAL', message: e.message, ...(e.details === undefined ? {} : { details: e.details }) };
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }], isError: true } };
        }
      }
      default: return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
  // 返回 null 表示全是通知，HTTP 层回 202
  return async function handle(body) {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(one))).filter(Boolean);
      return out.length ? out : null;
    }
    return one(body);
  };
}
