// Read-only ID planning. The normal backed-up write phase persists these exact texts.
import { fail, hashObject } from './safety.mjs';

export const isWorldEntryPath = rel => /^world_book\/(?:[^/]+\/)*[^/]+\.md$/.test(rel.replaceAll('\\', '/'));
export const entryUid = (node, fp) => node.frontmatter?.tavern?.id ?? fp.fnv1a(node.id);
// 文件里没写 id：按文件位置推出的 id 会随改名变，同步时补一个固定 id
const missingId = node => node.idImplied === true || node.id === null || node.id === undefined || node.id === '';
export const reliableBaseline = (saved, cardFile) => saved?.cardFile === cardFile && !!saved.slots && typeof saved.slots === 'object' && !Array.isArray(saved.slots) && Object.values(saved.slots).every(h => typeof h === 'string' && /^[0-9a-f]{16}$/i.test(h));

function insertId(raw, id, lib, YAML) {
  const match = raw.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  // 没有开头设置的散文件：补上只含 id 的开头和正文标记，正文原样保留
  if (!match) return `---${eol}${YAML.stringify({ id }).trimEnd()}${eol}---${eol}${eol}<!-- body -->${eol}${raw.replace(/^\uFEFF/, '')}`;
  const doc = YAML.parseDocument(lib.quoteBarePosition(match[2]));
  if (doc.errors.length || !YAML.isMap(doc.contents)) fail('INVALID_PROJECT', 'frontmatter 不是有效键值表，不能补 id');
  let frontmatter;
  if (!doc.has('id')) {
    // The common case changes only one added line, retaining comments/formatting verbatim.
    frontmatter = match[2] + eol + YAML.stringify({ id }).trimEnd();
  } else {
    const scalar = doc.get('id', true);
    if (YAML.isScalar(scalar)) scalar.value = id; else doc.set('id', id);
    frontmatter = String(doc).trimEnd().replaceAll('\n', eol);
  }
  return match[1] + frontmatter + raw.slice(match[1].length + match[2].length);
}

export function planWorldEntryIds(scan, rawFiles, remoteSlots, baseline, { nodes: lib, fp, YAML }) {
  const book = lib.bookNodesOf(scan), ids = new Set(scan.nodes.filter(n => !missingId(n)).map(n => String(n.id)));
  const historical = new Set([...Object.keys(baseline?.slots ?? {}), ...Object.keys(baseline?.pending ?? {})]);
  const remote = new Set(Object.keys(remoteSlots));
  const reserved = new Set([...remote, ...historical]);
  const counts = new Map();
  for (const n of book) {
    if (missingId(n) && n.frontmatter?.tavern?.id == null) continue;
    const key = `entry:${entryUid(n, fp)}`; reserved.add(key); counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const assignments = [];
  for (const n of book) {
    if (!missingId(n) || !isWorldEntryPath(n.relPath) || n.problems.length) continue;
    const relPath = n.relPath.replaceAll('\\', '/'), raw = rawFiles[relPath];
    if (raw === undefined) fail('STALE_LOCAL', '扫描期间节点文件集合改变');
    const explicitUid = n.frontmatter?.tavern?.id;
    if (explicitUid != null) {
      const key = `entry:${explicitUid}`;
      if (remote.has(key) || historical.has(key) || counts.get(key) > 1) fail('ENTRY_UID_COLLISION', `${relPath} 指定的 tavern.id 已被节点、酒馆或历史基线占用；不会改写作者 UID`);
    }
    const seed = hashObject({ relPath, raw }).slice(0, 24); let id, uid;
    for (let attempt = 0; attempt < 10_000; attempt++) {
      id = `world-${seed}${attempt ? `-${attempt}` : ''}`; uid = explicitUid ?? fp.fnv1a(id);
      if (!ids.has(id) && (explicitUid != null || !reserved.has(`entry:${uid}`))) break;
      id = null;
    }
    if (!id) fail('ENTRY_UID_COLLISION', '无法分配未占用的条目UID；没有写入');
    const text = insertId(raw, id, lib, YAML), parsed = lib.parseNodeFile(text, n.relPath);
    const merged = { ...(n.implied ?? {}), ...parsed.frontmatter };
    const { id: ignored, ...rest } = merged, { id: oldId, ...original } = n.frontmatter;
    if (parsed.problems.length || hashObject(rest) !== hashObject(original) || parsed.body !== n.body) fail('INVALID_PROJECT', '补id将改变其他设置或正文；没有写入');
    n.id = id; n.idImplied = false; n.frontmatter = merged;
    ids.add(id); reserved.add(`entry:${uid}`);
    assignments.push({ relPath, id, uid, text });
  }
  return assignments;
}

export function assertUniqueEntryUids(scan, lib, fp) {
  const seen = new Map();
  for (const n of lib.bookNodesOf(scan)) {
    const key = String(entryUid(n, fp));
    if (seen.has(key)) fail('ENTRY_UID_COLLISION', `世界书UID ${key} 被 ${seen.get(key)} 与 ${n.relPath} 重复使用；不会覆盖`);
    seen.set(key, n.relPath);
  }
}
