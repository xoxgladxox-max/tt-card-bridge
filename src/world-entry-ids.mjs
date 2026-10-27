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
    // 文件写了 tavern.id 只是缺 id：它就是酒馆里那条（拆卡时记下的编号），和写了 id 的文件一样按编号和酒馆对比。
    // 不再因为酒馆或基线里有这个编号就拒绝（旧做法会把同一条当成「被占用」，每轮都报错）。
    // 正文不同时由三方对比列给作者选；只有本地两个文件用同一编号才拒绝
    if (explicitUid != null && counts.get(`entry:${explicitUid}`) > 1) fail('ENTRY_UID_COLLISION', `${relPath} 的 tavern.id ${explicitUid} 和本地另一个条目文件重复；没有写入`);
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

// 改连：本地条目记的是旧卡的编号，删卡重导后酒馆重新编了号。按标题和正文把两边配成对，算出每个本地文件该用的编号。
//   标题和正文都相同：同一条，用酒馆的编号
//   编号和标题都相同、正文不同：同一条，正文差异交给后面的选边
//   只有标题相同：交作者选（choices[relPath] === 'pair' 才配对，否则当两条）
//   配不上的本地条目：编号被酒馆其他条目占用时换一个空编号，否则不动
// locals: [{ relPath, title, body, uid }]；remotes: [{ uid, title, body }]（正文已统一换行和首尾空白）
export function matchRebindEntries(locals, remotes, choices = {}) {
  const used = new Set(), pair = new Map(), ambiguous = [];
  const take = (l, test) => {
    const r = remotes.find(r => !used.has(r) && test(r));
    if (r) { used.add(r); pair.set(l, r); }
    return r;
  };
  for (const l of locals) take(l, r => r.title === l.title && r.body === l.body && String(r.uid) === String(l.uid));
  for (const l of locals) if (!pair.has(l)) take(l, r => r.title === l.title && r.body === l.body);
  for (const l of locals) if (!pair.has(l)) take(l, r => r.title === l.title && String(r.uid) === String(l.uid));
  for (const l of locals) {
    if (pair.has(l)) continue;
    const r = remotes.find(r => !used.has(r) && r.title === l.title);
    if (!r) continue;
    ambiguous.push({ relPath: l.relPath, title: l.title, localUid: l.uid, remoteUid: r.uid });
    if (choices[l.relPath] === 'pair') { used.add(r); pair.set(l, r); }
  }
  const remoteUids = new Set(remotes.map(r => String(r.uid))), finals = new Set();
  let next = Math.max(0, ...remotes.map(r => Number(r.uid)).filter(Number.isFinite)) + 1;
  const changes = [], localOnly = [];
  for (const l of locals) {
    const r = pair.get(l);
    let uid = r ? r.uid : l.uid, reason = 'paired';
    if (!r) {
      localOnly.push({ relPath: l.relPath, title: l.title });
      if (remoteUids.has(String(uid)) || finals.has(String(uid))) {
        while (remoteUids.has(String(next)) || finals.has(String(next))) next++;
        uid = next++; reason = 'reassigned';
      }
    }
    finals.add(String(uid));
    if (String(uid) !== String(l.uid)) changes.push({ relPath: l.relPath, title: l.title, from: l.uid, to: uid, reason });
  }
  const remoteOnly = remotes.filter(r => !used.has(r)).map(r => ({ uid: r.uid, title: r.title }));
  return { pairedCount: pair.size, changes, ambiguous, localOnly, remoteOnly };
}

// 只改文件开头的 tavern.id（没有 id 时顺便补上），正文和其他设置不动；改完解析一遍核对
export function setEntryUid(raw, { uid, id = null }, lib, YAML) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const match = raw.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  let text;
  if (!match) {
    text = `---${eol}${YAML.stringify({ ...(id ? { id } : {}), tavern: { id: uid } }).trimEnd().replaceAll('\n', eol)}${eol}---${eol}${eol}<!-- body -->${eol}${raw.replace(/^\uFEFF/, '')}`;
  } else {
    const doc = YAML.parseDocument(lib.quoteBarePosition(match[2]));
    if (doc.errors.length || !YAML.isMap(doc.contents)) fail('INVALID_PROJECT', '文件开头设置不是有效键值表，不能改编号');
    if (id && !doc.has('id')) doc.set('id', id);
    doc.setIn(['tavern', 'id'], uid);
    text = match[1] + String(doc).trimEnd().replaceAll('\n', eol) + raw.slice(match[1].length + match[2].length);
  }
  return text;
}
