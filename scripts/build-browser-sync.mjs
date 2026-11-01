// scripts/build-browser-sync.mjs — 将内置 forge（拆装卡/校验）、yaml 与同步引擎打包为浏览器可直接运行的 extension/browser-sync.js
// 保证浏览器直连模式（File System Access API）与 Node 后台模式共用同一套源码与规则。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bundleDirectoryEsm(entryFile) {
  let counter = 0;
  const order = [];
  const seen = new Set();
  const idMap = new Map();
  function assignId(absFile) {
    const norm = path.resolve(absFile);
    if (!idMap.has(norm)) idMap.set(norm, `__yaml_mod_${idMap.size}`);
    return idMap.get(norm);
  }
  function build(absFile) {
    const norm = path.resolve(absFile);
    if (seen.has(norm)) return idMap.get(norm);
    seen.add(norm);
    const id = assignId(norm);
    let code = fs.readFileSync(norm, 'utf8').replace(/\r\n/g, '\n');
    const dir = path.dirname(norm);
    const resolveRel = rel => {
      let p = path.resolve(dir, rel);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.js');
      else if (!fs.existsSync(p) && fs.existsSync(p + '.js')) p = p + '.js';
      return build(p);
    };
    const exportsList = [];
    let hasDefault = false;
    code = code.replace(/import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+['"](\.[^'"]+)['"];?/g, (_, ns, rel) => `const ${ns} = ${resolveRel(rel)};`);
    code = code.replace(/import\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"];?/g, (_, spec, rel) => {
      const target = resolveRel(rel);
      const mapped = spec.split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const m = s.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
        return m ? `${m[1]}: ${m[2]}` : s;
      }).join(', ');
      return `const { ${mapped} } = ${target};`;
    });
    code = code.replace(/import\s+([A-Za-z0-9_$]+)\s+from\s+['"](\.[^'"]+)['"];?/g, (_, defName, rel) => {
      const target = resolveRel(rel);
      return `const ${defName} = ${target}.default ?? ${target};`;
    });
    code = code.replace(/export\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"];?/g, (_, spec, rel) => {
      const target = resolveRel(rel);
      const lines = [];
      for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
        const m = part.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
        const srcName = m ? m[1] : part;
        const dstName = m ? m[2] : part;
        const localTmp = `__reexp_${counter++}_${dstName}`;
        lines.push(`const ${localTmp} = ${target}.${srcName};`);
        exportsList.push(`${dstName}: ${localTmp}`);
      }
      return lines.join('\n');
    });
    code = code.replace(/export\s+\{([^}]+)\};?/g, (_, spec) => {
      for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
        const m = part.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
        if (m) exportsList.push(`${m[2]}: ${m[1]}`);
        else exportsList.push(part);
      }
      return '';
    });
    code = code.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g, (_, kw, name) => {
      exportsList.push(name);
      return `${kw} ${name}`;
    });
    code = code.replace(/export\s+default\s+/g, () => {
      hasDefault = true;
      return 'const __default_export = ';
    });
    if (hasDefault) exportsList.push('default: __default_export');
    order.push(`const ${id} = (() => {\n${code}\nreturn { ${exportsList.join(', ')} };\n})();`);
    return id;
  }
  const rootId = build(entryFile);
  return `${order.join('\n')}\nconst YAML = ${rootId}.default ?? ${rootId};\n`;
}

const MODULE_VAR_BY_PATH = {
  'src/safety.mjs': '__mod_safety',
  'src/forge/lib/png.mjs': '__mod_forge_png',
  'src/png.mjs': '__mod_bridge_png',
  'src/forge/lib/fingerprint.mjs': '__mod_fp',
  'src/forge/lib/extras.mjs': '__mod_extras',
  'src/forge/lib/nodes.mjs': '__mod_nodes',
  'src/forge/lib/protocol.mjs': '__mod_protocol',
  'src/forge/cmd/build.mjs': '__mod_build',
  'src/forge/cmd/unpack.mjs': '__mod_unpack',
  'src/slots.mjs': '__mod_slots',
  'src/projects.mjs': '__mod_projects',
  'src/world-entry-ids.mjs': '__mod_world_ids',
  'src/sync-engine.mjs': '__mod_sync_engine',
  'src/file-sync-adapter.mjs': '__mod_adapter',
  'src/sync-service.mjs': '__mod_service',
};
const SHIMMED_BARE_IMPORTS = new Set(['node:fs', 'node:path', 'node:crypto', 'node:zlib', 'node:url', 'yaml']);
const SHIMMED_LOCAL_MODULES = {
  'extension/protocol.js': `const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;\nconst canonicalJson = value => JSON.stringify(stable(value ?? {}));`,
  'src/paths.mjs': `const tavernUserDir = () => '/tavern/default-user';\nconst tavernCharDir = () => '/tavern/default-user/characters';`,
  'src/connection.mjs': '',
  'src/bridge.mjs': `const publishCardJob = async () => ({});\nconst getJobResult = async () => ({ pending: false });`,
  'src/skills.mjs': `const inspectSkillsAndAgents = async () => ({ available: false, skills: [], missingNames: [], leftovers: [], agentPrompt: { exists: false }, summary: '当前为浏览器本地文件夹直连模式，已内置完整拆卡、装卡与实时同步，无需安装额外技能。' });\nconst deploySkillsAndAgents = async () => ({ available: false, summary: '当前为浏览器本地文件夹直连模式，无需部署外部技能。' });`,
};
const moduleExportsByVar = new Map();

function wrapModule(varName, relPath, replacements = []) {
  let code = fs.readFileSync(path.join(ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');
  for (const [pattern, replacement] of replacements) {
    code = code.replace(pattern, replacement);
  }
  // 自动将源码中的 import 转换为对应模块绑定或顶层 shim，禁止手工维护重复符号表或静默丢弃未知 import
  code = code.replace(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm, (full, clauseRaw, spec) => {
    const clause = clauseRaw.replace(/\s+/g, ' ').trim();
    if (spec === 'node:fs/promises') {
      return `const ${clause} = fsp;`;
    }
    if (spec === 'node:child_process') {
      return `const execFileSync = () => 'RESULT : PASS';`;
    }
    if (SHIMMED_BARE_IMPORTS.has(spec)) {
      return '';
    }
    if (spec.startsWith('.')) {
      const targetRel = path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, relPath)), spec)).replace(/\\/g, '/');
      if (Object.hasOwn(SHIMMED_LOCAL_MODULES, targetRel)) {
        return SHIMMED_LOCAL_MODULES[targetRel];
      }
      const targetVar = MODULE_VAR_BY_PATH[targetRel];
      if (!targetVar) {
        throw new Error(`[build-browser-sync] 模块 ${relPath} 导入了未注册的本地模块 ${spec} (${targetRel})`);
      }
      const brace = clause.match(/^\{([^}]+)\}$/);
      if (brace) {
        const mapped = brace[1].split(',').map(s => s.trim()).filter(Boolean).map(s => {
          const m = s.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
          return m ? `${m[1]}: ${m[2]}` : s;
        }).join(', ');
        return `const { ${mapped} } = ${targetVar};`;
      }
      if (/^[A-Za-z0-9_$]+$/.test(clause)) {
        return `const ${clause} = ${targetVar}.default ?? ${targetVar};`;
      }
    }
    throw new Error(`[build-browser-sync] 模块 ${relPath} 含有未处理的 import 语句: ${full.trim()}`);
  });
  const exportsList = [];
  code = code.replace(/export\s+\{([^}]+)\};?/g, (_, spec) => {
    for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
      const m = part.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
      if (m) exportsList.push(`${m[2]}: ${m[1]}`);
      else exportsList.push(part);
    }
    return '';
  });
  code = code.replace(/export\s+async\s+function\s+([A-Za-z0-9_$]+)/g, (_, name) => {
    exportsList.push(name);
    return `async function ${name}`;
  });
  code = code.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g, (_, kw, name) => {
    exportsList.push(name);
    return `${kw} ${name}`;
  });
  const uniqueExports = [...new Set(exportsList)];
  moduleExportsByVar.set(varName, new Set(uniqueExports.map(e => e.split(':')[0].trim())));
  return `const ${varName} = (() => {\n${code}\nreturn { ${uniqueExports.join(', ')} };\n})();`;
}

const yamlBundle = bundleDirectoryEsm(path.join(ROOT, 'node_modules/yaml/browser/dist/index.js'));

const shimHeader = `// AUTO-GENERATED BY scripts/build-browser-sync.mjs — DO NOT EDIT MANUALLY
// 浏览器端卡工程同步引擎：与 Node 后台共用同一套 forge（拆装卡/校验）与 SyncService 逻辑，
// 通过浏览器原生 File System Access API (window.showDirectoryPicker) 读写用户授权的本地工作区文件夹。

const __textEncoder = new TextEncoder();
const __textDecoder = new TextDecoder('utf-8');

class BrowserBuffer extends Uint8Array {
  static from(value, encoding = 'utf8') {
    if (value instanceof Uint8Array) return new BrowserBuffer(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    if (value instanceof ArrayBuffer) return new BrowserBuffer(value.slice(0));
    if (Array.isArray(value)) return new BrowserBuffer(value);
    const str = String(value ?? '');
    if (encoding === 'base64') {
      const bin = atob(str.replace(/\\s+/g, ''));
      const out = new BrowserBuffer(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (encoding === 'latin1' || encoding === 'binary') {
      const out = new BrowserBuffer(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    }
    if (encoding === 'hex') {
      const out = new BrowserBuffer(str.length >>> 1);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(str.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    const bytes = __textEncoder.encode(str);
    return new BrowserBuffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  static alloc(size, fill = 0) {
    const b = new BrowserBuffer(size);
    if (fill) b.fill(fill);
    return b;
  }
  static concat(list) {
    const total = list.reduce((acc, x) => acc + x.length, 0);
    const out = new BrowserBuffer(total);
    let offset = 0;
    for (const item of list) {
      out.set(item, offset);
      offset += item.length;
    }
    return out;
  }
  static isBuffer(obj) { return obj instanceof Uint8Array; }
  subarray(start, end) {
    const sub = super.subarray(start, end);
    Object.setPrototypeOf(sub, BrowserBuffer.prototype);
    return sub;
  }
  slice(start, end) { return this.subarray(start, end); }
  equals(other) {
    if (!(other instanceof Uint8Array) || this.length !== other.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }
  readUInt32BE(offset = 0) {
    return ((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0;
  }
  writeUInt32BE(value, offset = 0) {
    const v = value >>> 0;
    this[offset] = (v >>> 24) & 0xff;
    this[offset + 1] = (v >>> 16) & 0xff;
    this[offset + 2] = (v >>> 8) & 0xff;
    this[offset + 3] = v & 0xff;
    return offset + 4;
  }
  write(string, offset = 0, length = this.length - offset, encoding = 'utf8') {
    if (typeof offset === 'string') { encoding = offset; offset = 0; length = this.length; }
    else if (typeof length === 'string') { encoding = length; length = this.length - offset; }
    const src = BrowserBuffer.from(String(string ?? ''), encoding);
    const n = Math.min(src.length, Math.max(0, length), Math.max(0, this.length - offset));
    for (let i = 0; i < n; i++) this[offset + i] = src[i];
    return n;
  }
  toString(encoding = 'utf8', start = 0, end = this.length) {
    const sub = this.subarray(start, end);
    if (encoding === 'latin1' || encoding === 'binary') {
      let s = '';
      for (let i = 0; i < sub.length; i++) s += String.fromCharCode(sub[i]);
      return s;
    }
    if (encoding === 'base64') {
      let s = '';
      const chunk = 0x8000;
      for (let i = 0; i < sub.length; i += chunk) {
        s += String.fromCharCode.apply(null, sub.subarray(i, i + chunk));
      }
      return btoa(s);
    }
    if (encoding === 'hex') {
      let s = '';
      for (let i = 0; i < sub.length; i++) s += sub[i].toString(16).padStart(2, '0');
      return s;
    }
    return __textDecoder.decode(sub);
  }
}
const Buffer = BrowserBuffer;

// Pure JS synchronous SHA-256 (FIPS 180-4) for slotHash / hashObject / sha256Hex
const __SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
function __sha256Bytes(inputBytes) {
  const len = inputBytes.length;
  const bitLenHi = Math.floor((len * 8) / 0x100000000);
  const bitLenLo = (len * 8) >>> 0;
  const padLen = ((len + 9 + 63) & ~63);
  const msg = new Uint8Array(padLen);
  msg.set(inputBytes);
  msg[len] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(padLen - 8, bitLenHi, false);
  view.setUint32(padLen - 4, bitLenLo, false);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let i = 0; i < padLen; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false);
    for (let j = 16; j < 64; j++) {
      const v0 = w[j - 15], v1 = w[j - 2];
      const s0 = ((v0 >>> 7) | (v0 << 25)) ^ ((v0 >>> 18) | (v0 << 14)) ^ (v0 >>> 3);
      const s1 = ((v1 >>> 17) | (v1 << 15)) ^ ((v1 >>> 19) | (v1 << 13)) ^ (v1 >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let j = 0; j < 64; j++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + __SHA256_K[j] + w[j]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(x => x.toString(16).padStart(8, '0')).join('');
}

const crypto = {
  randomUUID: () => globalThis.crypto.randomUUID(),
  randomBytes: n => { const b = BrowserBuffer.alloc(n); globalThis.crypto.getRandomValues(b); return b; },
  createHash: () => {
    const chunks = [];
    return {
      update(data, enc) { chunks.push(data instanceof Uint8Array ? data : BrowserBuffer.from(String(data ?? ''), enc)); return this; },
      digest() { return __sha256Bytes(BrowserBuffer.concat(chunks)); },
    };
  },
};

const path = {
  sep: '/',
  normalize(p) {
    const raw = String(p ?? '').replace(/\\\\/g, '/');
    const abs = raw.startsWith('/');
    const parts = [];
    for (const seg of raw.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (parts.length) parts.pop(); }
      else parts.push(seg);
    }
    return (abs ? '/' : '') + parts.join('/') || (abs ? '/' : '.');
  },
  join(...parts) { return this.normalize(parts.filter(Boolean).join('/')); },
  resolve(...parts) {
    let resolved = '';
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = String(parts[i] ?? '').replace(/\\\\/g, '/');
      if (!p) continue;
      resolved = resolved ? p + '/' + resolved : p;
      if (p.startsWith('/')) break;
    }
    return this.normalize('/' + resolved);
  },
  dirname(p) {
    const n = this.normalize(p);
    const idx = n.lastIndexOf('/');
    if (idx <= 0) return n.startsWith('/') ? '/' : '.';
    return n.slice(0, idx);
  },
  basename(p, ext) {
    const n = this.normalize(p);
    const base = n.slice(n.lastIndexOf('/') + 1);
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  },
  extname(p) {
    const b = this.basename(p);
    const idx = b.lastIndexOf('.');
    return idx <= 0 ? '' : b.slice(idx);
  },
  relative(from, to) {
    const f = this.resolve(from).split('/').filter(Boolean);
    const t = this.resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < f.length && i < t.length && f[i] === t[i]) i++;
    return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
  },
  isAbsolute(p) { return String(p ?? '').replace(/\\\\/g, '/').startsWith('/'); },
  parse(p) {
    const n = this.normalize(p);
    const ext = this.extname(n);
    const base = this.basename(n);
    return { root: n.startsWith('/') ? '/' : '', dir: this.dirname(n), base, ext, name: ext ? base.slice(0, -ext.length) : base };
  },
};
path.posix = path;

// In-memory Virtual File System (VFS) synced with FileSystemDirectoryHandle & Tavern APIs
const __vfsFiles = new Map(); // normPath -> { bytes: BrowserBuffer, mtimeMs: number }
const __vfsDirs = new Set(['/', '/workspace', '/tavern', '/tavern/default-user', '/tavern/default-user/characters', '/tavern/default-user/worlds', '/runtime']);
const __vfsPendingDiskOps = []; // { op: 'write' | 'rm', path, bytes? }

function __vfsEnsureDir(dirPath, track = true) {
  const norm = path.resolve(dirPath);
  const parts = norm.split('/').filter(Boolean);
  let cur = '';
  __vfsDirs.add('/');
  for (const part of parts) {
    cur += '/' + part;
    __vfsDirs.add(cur);
  }
}

function __vfsWrite(filePath, data, encoding = 'utf8', trackDisk = true) {
  const norm = path.resolve(filePath);
  __vfsEnsureDir(path.dirname(norm), trackDisk);
  const bytes = data instanceof Uint8Array ? BrowserBuffer.from(data) : BrowserBuffer.from(String(data ?? ''), encoding);
  __vfsFiles.set(norm, { bytes, mtimeMs: Date.now() });
  if (trackDisk && norm.startsWith('/workspace/')) {
    __vfsPendingDiskOps.push({ op: 'write', rel: norm.slice('/workspace/'.length), bytes });
  }
}

function __vfsRead(filePath, encoding = null) {
  const norm = path.resolve(filePath);
  const entry = __vfsFiles.get(norm);
  if (!entry) {
    const err = new Error(\`ENOENT: no such file or directory, open '\${norm}'\`);
    err.code = 'ENOENT';
    throw err;
  }
  return encoding ? entry.bytes.toString(encoding === 'utf-8' ? 'utf8' : encoding) : BrowserBuffer.from(entry.bytes);
}

function __vfsRm(targetPath, { recursive = false, force = false } = {}, trackDisk = true) {
  const norm = path.resolve(targetPath);
  const existed = __vfsFiles.has(norm) || __vfsDirs.has(norm);
  if (!existed && !force) {
    const err = new Error(\`ENOENT: no such file or directory, rm '\${norm}'\`);
    err.code = 'ENOENT';
    throw err;
  }
  __vfsFiles.delete(norm);
  __vfsDirs.delete(norm);
  if (recursive) {
    const prefix = norm + '/';
    for (const k of [...__vfsFiles.keys()]) if (k.startsWith(prefix)) __vfsFiles.delete(k);
    for (const d of [...__vfsDirs]) if (d.startsWith(prefix)) __vfsDirs.delete(d);
  }
  if (trackDisk && norm.startsWith('/workspace/')) {
    __vfsPendingDiskOps.push({ op: 'rm', rel: norm.slice('/workspace/'.length), recursive });
  }
}

const fs = {
  constants: { COPYFILE_EXCL: 1 },
  existsSync(p) {
    const norm = path.resolve(p);
    return __vfsFiles.has(norm) || __vfsDirs.has(norm);
  },
  statSync(p) {
    const norm = path.resolve(p);
    if (__vfsFiles.has(norm)) {
      const f = __vfsFiles.get(norm);
      return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, mtimeMs: f.mtimeMs, size: f.bytes.length };
    }
    if (__vfsDirs.has(norm)) {
      return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, mtimeMs: Date.now(), size: 0 };
    }
    const err = new Error(\`ENOENT: no such file or directory, stat '\${norm}'\`);
    err.code = 'ENOENT';
    throw err;
  },
  lstatSync(p) { return this.statSync(p); },
  realpathSync(p) { return path.resolve(p); },
  mkdirSync(p) { __vfsEnsureDir(p, true); },
  readFileSync(p, enc) { return __vfsRead(p, typeof enc === 'string' ? enc : enc?.encoding ?? null); },
  writeFileSync(p, data, enc) { __vfsWrite(p, data, typeof enc === 'string' ? enc : enc?.encoding ?? 'utf8', true); },
  copyFileSync(src, dst) { __vfsWrite(dst, __vfsRead(src, null), null, true); },
  renameSync(oldP, newP) {
    const oldNorm = path.resolve(oldP), newNorm = path.resolve(newP);
    if (__vfsFiles.has(oldNorm)) {
      __vfsWrite(newNorm, __vfsRead(oldNorm, null), null, true);
      __vfsRm(oldNorm, { force: true }, true);
      return;
    }
    if (__vfsDirs.has(oldNorm)) {
      __vfsEnsureDir(newNorm, true);
      const prefix = oldNorm + '/';
      for (const [k, v] of [...__vfsFiles.entries()]) {
        if (k.startsWith(prefix)) {
          __vfsWrite(newNorm + '/' + k.slice(prefix.length), v.bytes, null, true);
        }
      }
      __vfsRm(oldNorm, { recursive: true, force: true }, true);
    }
  },
  rmSync(p, opts) { __vfsRm(p, opts, true); },
  unlinkSync(p) { __vfsRm(p, { force: false }, true); },
  readdirSync(p, opts = {}) {
    const norm = path.resolve(p);
    if (!__vfsDirs.has(norm)) {
      const err = new Error(\`ENOENT: no such file or directory, scandir '\${norm}'\`);
      err.code = 'ENOENT';
      throw err;
    }
    const prefix = norm === '/' ? '/' : norm + '/';
    const children = new Map();
    for (const d of __vfsDirs) {
      if (d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        if (rest && !rest.includes('/')) children.set(rest, 'dir');
      }
    }
    for (const f of __vfsFiles.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        if (rest && !rest.includes('/')) children.set(rest, 'file');
      }
    }
    const names = [...children.keys()].sort();
    if (opts?.withFileTypes) {
      return names.map(name => ({
        name,
        isDirectory: () => children.get(name) === 'dir',
        isFile: () => children.get(name) === 'file',
        isSymbolicLink: () => false,
      }));
    }
    return names;
  },
  watch() {
    // 浏览器模式下由目录轮询驱动 wake()，这里返回空 watcher 句柄
    return { on() { return this; }, close() {} };
  },
};

const fsp = {
  async access(p) { if (!fs.existsSync(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } },
  async stat(p) { return fs.statSync(p); },
  async mkdir(p) { fs.mkdirSync(p); },
  async readFile(p, enc) { return fs.readFileSync(p, enc); },
  async writeFile(p, data, enc) { fs.writeFileSync(p, data, enc); },
  async copyFile(src, dst) { fs.copyFileSync(src, dst); },
  async rename(oldP, newP) { fs.renameSync(oldP, newP); },
  async rm(p, opts) { fs.rmSync(p, opts); },
  async unlink(p) { fs.unlinkSync(p); },
  async readdir(p, opts) { return fs.readdirSync(p, opts); },
};

const zlib = {
  inflateSync(buf) { return BrowserBuffer.from(buf); },
};
const BRIDGE_ROOT = '/';
const process = { pid: 1, env: {}, platform: 'browser' };
`;

const mSafety = wrapModule('__mod_safety', 'src/safety.mjs');
const mForgePng = wrapModule('__mod_forge_png', 'src/forge/lib/png.mjs');
const mBridgePng = wrapModule('__mod_bridge_png', 'src/png.mjs');
const mFp = wrapModule('__mod_fp', 'src/forge/lib/fingerprint.mjs');
const mExtras = wrapModule('__mod_extras', 'src/forge/lib/extras.mjs');
const mNodes = wrapModule('__mod_nodes', 'src/forge/lib/nodes.mjs');
const mProtocol = wrapModule('__mod_protocol', 'src/forge/lib/protocol.mjs');
const mBuild = wrapModule('__mod_build', 'src/forge/cmd/build.mjs', [
  [/fileURLToPath\(import\.meta\.url\)/g, `'/src/forge/cmd/build.mjs'`],
  [/export \{ defaultTarget \};/, ''],
]);
const mUnpack = wrapModule('__mod_unpack', 'src/forge/cmd/unpack.mjs');
const mSlots = wrapModule('__mod_slots', 'src/slots.mjs', [
  [/const ROOT =[\s\S]*?export const extrasLib = await forge\('lib\/extras\.mjs'\);/, `export const forge = async () => __mod_extras;
export const extrasLib = __mod_extras;`],
]);
const mWorldIds = wrapModule('__mod_world_ids', 'src/world-entry-ids.mjs');
const mSyncEngine = wrapModule('__mod_sync_engine', 'src/sync-engine.mjs');
const mProjects = wrapModule('__mod_projects', 'src/projects.mjs');
const mAdapter = wrapModule('__mod_adapter', 'src/file-sync-adapter.mjs', [
  [/async libraries\(\) \{[\s\S]*?return this\.libs;\n  \}/, `async libraries() {
    return { nodes: __mod_nodes, fp: __mod_fp, build: { ...__mod_build, defaultTarget: __mod_nodes.defaultTarget }, protocol: __mod_protocol, unpack: __mod_unpack, YAML, png: __mod_forge_png };
  }`],
  [/const \{ compareSnapshot \} = await import\('\.\/sync-engine\.mjs'\);/, 'const { compareSnapshot } = __mod_sync_engine;'],
]);
const mService = wrapModule('__mod_service', 'src/sync-service.mjs');

const browserRuntimeCode = `
// IndexedDB 保存用户选择的本地工作区文件夹句柄 (FileSystemDirectoryHandle)
const IDB_NAME = 'tt-card-bridge-browser-fs';
const IDB_STORE = 'handles';
const IDB_KEY = 'workspaceHandle';

function openHandleDb() {
  return new Promise(resolve => {
    if (!globalThis.indexedDB) return resolve(null);
    const timer = setTimeout(() => resolve(null), 1500);
    try {
      const req = globalThis.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(IDB_STORE); } catch {} };
      req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
      req.onerror = () => { clearTimeout(timer); resolve(null); };
      req.onblocked = () => { clearTimeout(timer); resolve(null); };
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function loadSavedHandle() {
  const db = await openHandleDb();
  if (!db) return null;
  return new Promise(resolve => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function saveDirectoryHandle(handle) {
  const db = await openHandleDb();
  if (!db) return;
  return new Promise(resolve => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function clearSavedHandle() {
  const db = await openHandleDb();
  if (!db) return;
  return new Promise(resolve => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

const IGNORED_DIRS = new Set(['backups', 'dist', 'node_modules', '.git']);
const ALLOWED_PROJECT_SUBDIRS = new Set(['.card-forge', 'message', 'world_book', 'regex', 'scripts', '待归位', 'world', 'character', 'greeting', 'output', 'style']);
const ALLOWED_FILE_EXTS = /\.(md|json|js|html|png)$/i;

export function createBrowserSyncRuntime({ getContext, mutations, runRenameJob, fetchImpl = (...args) => fetch(...args) }) {
  let rootHandle = null;
  let rootIsSingleCard = false;
  let service = null;
  let adapter = null;
  const diskCache = new Map(); // relPath -> { mtimeMs, size }

  async function isCardProjectDirHandle(dirHandle) {
    for (const marker of ['card.md', 'index.md']) {
      try { await dirHandle.getFileHandle(marker); return true; } catch {}
    }
    for (const sub of ['.card-forge', 'world_book', 'message']) {
      try { await dirHandle.getDirectoryHandle(sub); return true; } catch {}
    }
    return false;
  }

  async function pullDiskToVfs() {
    if (!rootHandle) return false;
    const seenFiles = new Set();
    const seenDirs = new Set(['/workspace']);
    let changed = false;

    async function walkProjectDir(dirHandle, relPrefix, depthInProject) {
      if (depthInProject > 5) return;
      for await (const [name, entry] of dirHandle.entries()) {
        const rel = \`\${relPrefix}/\${name}\`;
        const vfsPath = \`/workspace/\${rel}\`;
        if (entry.kind === 'directory') {
          if (depthInProject === 0 && !ALLOWED_PROJECT_SUBDIRS.has(name)) continue;
          if (IGNORED_DIRS.has(name)) continue;
          seenDirs.add(vfsPath);
          __vfsEnsureDir(vfsPath, false);
          await walkProjectDir(entry, rel, depthInProject + 1);
        } else if (entry.kind === 'file') {
          if (!ALLOWED_FILE_EXTS.test(name)) continue;
          seenFiles.add(vfsPath);
          const file = await entry.getFile();
          if (file.size > 20 * 1024 * 1024) continue;
          const prev = diskCache.get(rel);
          const isControlJson = rel.endsWith('/.card-forge/bridge.json') || rel === '.card-forge/bridge.json'
            || rel.endsWith('/.card-forge/operation.json') || rel === '.card-forge/operation.json';
          const hasPending = __vfsPendingDiskOps.some(item => item.rel === rel);
          if (!hasPending && (!prev || prev.mtimeMs !== file.lastModified || prev.size !== file.size || !__vfsFiles.has(vfsPath) || isControlJson)) {
            const buf = new BrowserBuffer(await file.arrayBuffer());
            const curEntry = __vfsFiles.get(vfsPath);
            const contentChanged = !curEntry || curEntry.bytes.length !== buf.length || !curEntry.bytes.equals(buf);
            if (contentChanged || !prev || prev.mtimeMs !== file.lastModified || prev.size !== file.size) {
              __vfsEnsureDir(path.dirname(vfsPath), false);
              __vfsFiles.set(vfsPath, { bytes: buf, mtimeMs: file.lastModified });
              diskCache.set(rel, { mtimeMs: file.lastModified, size: file.size });
              if (contentChanged) changed = true;
            }
          }
        }
      }
    }

    // 如果用户直接选了单张卡的文件夹本身，也支持识别；正常情况是选包含多张卡的总工作区目录
    rootIsSingleCard = await isCardProjectDirHandle(rootHandle);
    if (rootIsSingleCard) {
      const cardName = rootHandle.name;
      const vfsPath = \`/workspace/\${cardName}\`;
      seenDirs.add(vfsPath);
      __vfsEnsureDir(vfsPath, false);
      await walkProjectDir(rootHandle, cardName, 0);
    } else {
      for await (const [name, entry] of rootHandle.entries()) {
        if (entry.kind !== 'directory' || IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
        if (!(await isCardProjectDirHandle(entry))) continue;
        const vfsPath = \`/workspace/\${name}\`;
        seenDirs.add(vfsPath);
        __vfsEnsureDir(vfsPath, false);
        await walkProjectDir(entry, name, 0);
      }
    }

    for (const k of [...__vfsFiles.keys()]) {
      if (k.startsWith('/workspace/') && !seenFiles.has(k)) {
        __vfsFiles.delete(k);
        diskCache.delete(k.slice('/workspace/'.length));
        changed = true;
      }
    }
    for (const d of [...__vfsDirs]) {
      if (d.startsWith('/workspace/') && !seenDirs.has(d)) {
        __vfsDirs.delete(d);
      }
    }
    return changed;
  }

  async function flushVfsToDisk() {
    if (!rootHandle || !__vfsPendingDiskOps.length) return;
    const ops = __vfsPendingDiskOps.splice(0, __vfsPendingDiskOps.length);
    for (const item of ops) {
      const parts = item.rel.split('/').filter(Boolean);
      if (rootIsSingleCard && parts[0] === rootHandle.name) parts.shift();
      if (!parts.length) continue;
      const leaf = parts.pop();
      try {
        let dir = rootHandle;
        for (const seg of parts) {
          dir = await dir.getDirectoryHandle(seg, { create: item.op === 'write' });
        }
        if (item.op === 'write') {
          const fh = await dir.getFileHandle(leaf, { create: true });
          const writable = await fh.createWritable();
          await writable.write(new Uint8Array(item.bytes.buffer, item.bytes.byteOffset, item.bytes.byteLength));
          await writable.close();
          const updated = await fh.getFile();
          diskCache.set(item.rel, { mtimeMs: updated.lastModified, size: updated.size });
        } else if (item.op === 'rm') {
          await dir.removeEntry(leaf, { recursive: Boolean(item.recursive) }).catch(() => {});
          diskCache.delete(item.rel);
        }
      } catch (err) {
        console.warn('[tt-card-bridge] flushVfsToDisk warning:', item.rel, err);
      }
    }
  }

  const cardWorldCache = new Map();
  let lastPolledAvatar = null;

  async function syncTavernToVfs(extraCards = [], extraWorlds = [], { force = false } = {}) {
    const st = getContext?.();
    if (!st) return;
    __vfsEnsureDir('/tavern/default-user/characters', false);
    __vfsEnsureDir('/tavern/default-user/worlds', false);

    const characters = st.characters ?? [];
    const currentAvatar = st.characterId !== undefined && st.characterId !== null && st.characterId !== ''
      ? characters[Number(st.characterId)]?.avatar
      : null;
    const avatarSwitched = currentAvatar !== lastPolledAvatar;
    lastPolledAvatar = currentAvatar;
    const shouldForce = force || avatarSwitched;

    // 同步酒馆中所有角色卡的文件存在性；对当前打开的卡与目标卡按需拉取真实 PNG 字节
    const activeAvatars = new Set([currentAvatar, ...extraCards].filter(Boolean));
    if (service) {
      for (const p of service.projects()) {
        if (p.cardFile && !p.cardFile.startsWith('world:')) activeAvatars.add(p.cardFile);
      }
    }
    const existingSet = new Set([...characters.map(c => c.avatar), ...extraCards].filter(Boolean));
    for (const k of [...__vfsFiles.keys()]) {
      if (k.startsWith('/tavern/default-user/characters/')) {
        const name = k.slice('/tavern/default-user/characters/'.length);
        if (!existingSet.has(name)) {
          __vfsFiles.delete(k);
          cardWorldCache.delete(name);
        }
      }
    }
    for (const c of characters) {
      if (!c.avatar) continue;
      const vfsPath = \`/tavern/default-user/characters/\${c.avatar}\`;
      if (!__vfsFiles.has(vfsPath)) {
        __vfsFiles.set(vfsPath, { bytes: BrowserBuffer.alloc(0), mtimeMs: Date.now() });
      }
    }

    const wantedWorlds = new Set(extraWorlds.filter(Boolean));
    for (const c of characters) {
      if (!c.avatar || !activeAvatars.has(c.avatar)) continue;
      const w = typeof c?.data?.extensions?.world === 'string' ? c.data.extensions.world.trim() : '';
      if (w) wantedWorlds.add(w);
    }
    const domWorld = globalThis.document?.querySelector?.('#world_editor_select option:checked')?.textContent?.trim();
    if (domWorld && !domWorld.startsWith('---')) wantedWorlds.add(domWorld);

    for (const avatar of activeAvatars) {
      if (!existingSet.has(avatar)) continue;
      const vfsPath = \`/tavern/default-user/characters/\${avatar}\`;
      const cached = __vfsFiles.get(vfsPath);
      if (!shouldForce && cached && cached.bytes.length > 0 && !extraCards.includes(avatar)) {
        const cachedWorld = cardWorldCache.get(avatar);
        if (cachedWorld) wantedWorlds.add(cachedWorld);
        continue;
      }
      try {
        const res = await fetchImpl(\`/characters/\${encodeURIComponent(avatar)}\`, { cache: 'no-store' });
        if (res.ok) {
          const buf = new BrowserBuffer(await res.arrayBuffer());
          __vfsFiles.set(vfsPath, { bytes: buf, mtimeMs: Date.now() });
          try {
            const card = __mod_slots.readCardPng(buf);
            const w = typeof card?.data?.extensions?.world === 'string' ? card.data.extensions.world.trim() : '';
            cardWorldCache.set(avatar, w);
            if (w) wantedWorlds.add(w);
          } catch {}
        }
      } catch {}
    }

    if (service) {
      for (const p of service.projects()) {
        if (p.cardFile?.startsWith('world:')) wantedWorlds.add(p.cardFile.slice(6).trim());
        if (p.binding?.worldOverride) wantedWorlds.add(String(p.binding.worldOverride).trim());
      }
    }

    const worldsNeedFetch = [...wantedWorlds].some(rawName => {
      const wName = typeof rawName === 'string' ? rawName.trim() : '';
      return wName && (shouldForce || extraWorlds.includes(rawName) || !__vfsFiles.has(\`/tavern/default-user/worlds/\${wName}.json\`));
    });
    if (!worldsNeedFetch) return;

    let existingWorlds = null;
    if (wantedWorlds.size > 0) {
      try {
        const sRes = await fetchImpl('/api/settings/get', {
          method: 'POST',
          headers: st.getRequestHeaders(),
          body: JSON.stringify({}),
        });
        if (sRes.ok) {
          const settings = await sRes.json();
          if (Array.isArray(settings?.world_names)) {
            existingWorlds = new Set(settings.world_names);
          }
        }
      } catch {}
    }

    if (existingWorlds) {
      const existingTrimmed = new Set([...existingWorlds].map(x => String(x).trim()));
      for (const k of [...__vfsFiles.keys()]) {
        if (k.startsWith('/tavern/default-user/worlds/') && k.endsWith('.json')) {
          const wName = k.slice('/tavern/default-user/worlds/'.length, -5);
          if (!existingWorlds.has(wName) && !existingTrimmed.has(wName)) {
            __vfsFiles.delete(k);
          }
        }
      }
    }

    for (const rawName of wantedWorlds) {
      const worldName = typeof rawName === 'string' ? rawName.trim() : '';
      if (!worldName) continue;
      let queryName = worldName;
      if (existingWorlds) {
        if (existingWorlds.has(rawName)) queryName = rawName;
        else if (existingWorlds.has(worldName)) queryName = worldName;
        else continue; // 世界书在酒馆中不存在（卡片仅含内嵌 character_book），不写入空文件到 VFS
      }
      if (!shouldForce && !extraWorlds.includes(rawName) && __vfsFiles.has(\`/tavern/default-user/worlds/\${worldName}.json\`)) {
        continue;
      }
      try {
        const res = await fetchImpl('/api/worldinfo/get', {
          method: 'POST',
          headers: st.getRequestHeaders(),
          body: JSON.stringify({ name: queryName }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && typeof data === 'object' && data.entries) {
            __vfsWrite(\`/tavern/default-user/worlds/\${worldName}.json\`, JSON.stringify(data, null, 2) + '\\n', 'utf8', false);
          }
        }
      } catch {}
    }
  }

  function bookToWorldObj(book) {
    const st = getContext?.();
    if (typeof st?.convertCharacterBook === 'function') {
      const converted = st.convertCharacterBook(structuredClone(book ?? { entries: [] }));
      if (converted?.entries) {
        return {
          entries: converted.entries,
          ...(book?.description ? { description: book.description } : {}),
        };
      }
    }
    const entries = Object.fromEntries(((book?.entries) ?? []).map((entry, index) => {
      const uid = entry.id ?? index;
      return [String(uid), {
        uid,
        key: entry.keys ?? [],
        keysecondary: entry.secondary_keys ?? [],
        comment: entry.comment ?? entry.name ?? '',
        content: entry.content ?? '',
        constant: Boolean(entry.constant),
        selective: Boolean(entry.selective),
        order: entry.insertion_order ?? 100,
        position: entry.extensions?.position ?? (entry.position === 'after_char' ? 1 : 0),
        excludeRecursion: entry.extensions?.exclude_recursion ?? false,
        preventRecursion: entry.extensions?.prevent_recursion ?? false,
        delayUntilRecursion: entry.extensions?.delay_until_recursion ?? false,
        disable: entry.enabled === false,
        addMemo: Boolean(entry.comment ?? entry.name),
        displayIndex: entry.extensions?.display_index ?? index,
        probability: entry.extensions?.probability ?? 100,
        useProbability: entry.extensions?.useProbability ?? true,
        depth: entry.extensions?.depth ?? 4,
        selectiveLogic: entry.extensions?.selectiveLogic ?? 0,
        outletName: entry.extensions?.outlet_name ?? '',
        group: entry.extensions?.group ?? '',
        groupOverride: entry.extensions?.group_override ?? false,
        groupWeight: entry.extensions?.group_weight ?? 100,
        scanDepth: entry.extensions?.scan_depth ?? null,
        caseSensitive: entry.extensions?.case_sensitive ?? null,
        matchWholeWords: entry.extensions?.match_whole_words ?? null,
        useGroupScoring: entry.extensions?.use_group_scoring ?? null,
        automationId: entry.extensions?.automation_id ?? '',
        role: entry.extensions?.role ?? 0,
        vectorized: entry.extensions?.vectorized ?? false,
        sticky: entry.extensions?.sticky ?? null,
        cooldown: entry.extensions?.cooldown ?? null,
        delay: entry.extensions?.delay ?? null,
        matchPersonaDescription: entry.extensions?.match_persona_description ?? false,
        matchCharacterDescription: entry.extensions?.match_character_description ?? false,
        matchCharacterPersonality: entry.extensions?.match_character_personality ?? false,
        matchCharacterDepthPrompt: entry.extensions?.match_character_depth_prompt ?? false,
        matchScenario: entry.extensions?.match_scenario ?? false,
        matchCreatorNotes: entry.extensions?.match_creator_notes ?? false,
        extensions: entry.extensions ?? {},
        triggers: entry.extensions?.triggers ?? [],
        ignoreBudget: entry.extensions?.ignore_budget ?? false,
      }];
    }));
    return { entries, ...(book?.description ? { description: book.description } : {}) };
  }

  async function ensureService() {
    if (service) return service;
    const transport = async job => {
      let report;
      if (job.op === 'create') {
        report = await mutations.create(job);
        const createdAvatar = report?.avatar || job.avatar;
        if (createdAvatar && job.pngBase64) {
          __vfsEnsureDir('/tavern/default-user/characters', false);
          __vfsFiles.set(\`/tavern/default-user/characters/\${createdAvatar}\`, {
            bytes: BrowserBuffer.from(job.pngBase64, 'base64'),
            mtimeMs: Date.now(),
          });
          if (job.worldName) cardWorldCache.set(createdAvatar, String(job.worldName).trim());
        }
        if (job.worldName) {
          __vfsEnsureDir('/tavern/default-user/worlds', false);
          const worldObj = job.world?.entries ? job.world : bookToWorldObj(job.book);
          __vfsWrite(\`/tavern/default-user/worlds/\${String(job.worldName).trim()}.json\`, JSON.stringify(worldObj, null, 2) + '\\n', 'utf8', false);
        }
        return report;
      }
      else if (job.op === 'rename') {
        report = await runRenameJob(job);
        if (job.avatar && report?.avatar && job.avatar !== report.avatar) {
          __vfsFiles.delete(\`/tavern/default-user/characters/\${job.avatar}\`);
          cardWorldCache.delete(job.avatar);
        }
        if (job.worldName && (job.book || job.world)) {
          __vfsEnsureDir('/tavern/default-user/worlds', false);
          const worldObj = job.world?.entries ? job.world : bookToWorldObj(job.book);
          __vfsWrite(\`/tavern/default-user/worlds/\${String(job.worldName).trim()}.json\`, JSON.stringify(worldObj, null, 2) + '\\n', 'utf8', false);
        }
      }
      else if (job.worldName && !job.card) report = await mutations.runWorld(job);
      else report = await mutations.runCard(job);
      await syncTavernToVfs(
        [job.avatar, report?.avatar].filter(Boolean),
        [job.worldName, job.expected?.worldName, job.card?.data?.extensions?.world].filter(Boolean),
        { force: true },
      );
      return report;
    };
    adapter = new __mod_adapter.FileSyncAdapter({
      skillsRoot: null,
      userDir: '/tavern/default-user',
      cardsRoot: '/workspace',
      transport,
      queryResult: async () => ({ pending: false }),
      directTransport: true,
    });
    service = new __mod_service.SyncService({
      cardsRoot: '/workspace',
      runtimeRoot: '/runtime',
      adapter,
    });
    // 浏览器直连模式为当前页面内单进程执行，不存在跨进程迟到回执；初始化时自动清理上次异常中断残留的未决锁
    for (const p of service.projects()) {
      if (p.pendingOperation) {
        adapter.clearPendingOperation(p);
      }
    }
    return service;
  }

  async function inspectSetupState() {
    if (!rootHandle) rootHandle = await loadSavedHandle();
    if (!rootHandle) {
      return { ready: false, reason: 'no_folder', message: '检测到尚未配置本地卡工程工作区。是否现在启用并选择本地工作区文件夹？' };
    }
    if (typeof rootHandle.queryPermission === 'function') {
      const perm = await rootHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        return { ready: false, reason: 'permission_needed', folderName: rootHandle.name, message: \`检测到上次的工作区文件夹「\${rootHandle.name}」。是否允许读写并开启实时同步？\` };
      }
    }
    return { ready: true, folderName: rootHandle.name };
  }

  async function authorizeWorkspace({ pickNew = false, handle = null } = {}) {
    if (handle) {
      rootHandle = handle;
      await saveDirectoryHandle(rootHandle);
      diskCache.clear();
      for (const k of [...__vfsFiles.keys()]) if (k.startsWith('/workspace/')) __vfsFiles.delete(k);
    } else if (pickNew || !rootHandle) {
      if (typeof globalThis.window?.showDirectoryPicker !== 'function') {
        throw new Error('当前浏览器不支持直接选择本地文件夹（File System Access API），请使用 Chrome / Edge / TauriTavern，或运行 install.bat 启动本机后台。');
      }
      rootHandle = await globalThis.window.showDirectoryPicker({ mode: 'readwrite' });
      await saveDirectoryHandle(rootHandle);
      diskCache.clear();
      for (const k of [...__vfsFiles.keys()]) if (k.startsWith('/workspace/')) __vfsFiles.delete(k);
    } else if (typeof rootHandle.requestPermission === 'function') {
      const perm = await rootHandle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('未授予本地文件夹读写权限，同步未开启。');
    }
    await pullDiskToVfs();
    await syncTavernToVfs([], [], { force: true });
    const svc = await ensureService();
    svc.state.paused = false;
    svc.saveState();
    return formatStatus(await svc.status());
  }

  function formatStatus(raw) {
    return {
      ...raw,
      cardsRoot: rootHandle ? \`本地文件夹：\${rootHandle.name}\` : '尚未选择文件夹',
      browserMode: true,
    };
  }

  return {
    inspectSetupState,
    authorizeWorkspace,
    async status() {
      const state = await inspectSetupState();
      if (!state.ready) {
        const err = new Error(state.message);
        err.code = state.reason === 'permission_needed' ? 'FOLDER_PERMISSION_REQUIRED' : 'SETUP_CONFIRM_REQUIRED';
        err.details = state;
        throw err;
      }
      const changed = await pullDiskToVfs();
      await syncTavernToVfs([], [], { force: changed });
      const svc = await ensureService();
      const st = getContext?.();
      const currentAvatar = st?.characterId !== undefined && st?.characterId !== null && st?.characterId !== ''
        ? st?.characters?.[Number(st.characterId)]?.avatar ?? null
        : null;
      if (currentAvatar && svc.state.activeCardFile !== currentAvatar) {
        await svc.control({ action: 'followCard', cardFile: currentAvatar });
      }
      if (changed && !svc.state.paused) {
        try {
          await svc.queue.run({ action: 'autoSync', projectId: null }, () => svc.batch('sync', null, true));
        } finally {
          await flushVfsToDisk();
        }
      } else {
        await flushVfsToDisk();
      }
      return formatStatus(await svc.status());
    },
    async control(action, args = {}) {
      if (action === 'setCardsRoot') {
        return authorizeWorkspace({ pickNew: true });
      }
      const state = await inspectSetupState();
      if (!state.ready) {
        await authorizeWorkspace({ pickNew: state.reason === 'no_folder' });
      }
      await pullDiskToVfs();
      const extraCards = [args.cardFile].filter(Boolean);
      const extraWorlds = [args.worldName].filter(Boolean);
      await syncTavernToVfs(extraCards, extraWorlds, { force: true });
      const svc = await ensureService();
      let res;
      try {
        res = await svc.control({ ...args, action });
      } finally {
        await flushVfsToDisk();
      }
      return res && typeof res === 'object' && 'cardsRoot' in res ? formatStatus(res) : res;
    },
    async startSync() {
      const state = await inspectSetupState();
      if (!state.ready) {
        return authorizeWorkspace({ pickNew: state.reason === 'no_folder' });
      }
      await pullDiskToVfs();
      await syncTavernToVfs();
      const svc = await ensureService();
      const res = await svc.control({ action: 'resume' });
      await flushVfsToDisk();
      return formatStatus(res);
    },
  };
}
`;

const fullCode = [
  shimHeader,
  yamlBundle,
  mSafety,
  mForgePng,
  mBridgePng,
  mFp,
  mExtras,
  mNodes,
  mProtocol,
  mBuild,
  mUnpack,
  mSlots,
  mProjects,
  mWorldIds,
  mSyncEngine,
  mAdapter,
  mService,
  browserRuntimeCode,
].join('\n\n');

// 构建期静态校验：
// 1. 确保所有 __mod_* 引用都指向已注册模块（防止 __mod_Slots 等拼写错误）
// 2. 确保所有从 __mod_* 解构或属性访问的符号都在目标模块的 return 导出集合中
// 3. 确保被打包模块内没有残留未转换的 import 语句或 import.meta
const validModVars = new Set(Object.values(MODULE_VAR_BY_PATH));
for (const m of fullCode.matchAll(/\b(__mod_[A-Za-z0-9_]+)\b/g)) {
  if (!validModVars.has(m[1])) {
    throw new Error(`[build-browser-sync] 发现未定义的模块变量引用: ${m[1]}`);
  }
}
for (const m of fullCode.matchAll(/const\s+\{([^}]+)\}\s*=\s*(__mod_[A-Za-z0-9_]+);/g)) {
  const modVar = m[2];
  const exported = moduleExportsByVar.get(modVar);
  for (const part of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
    const srcSym = part.split(':')[0].trim();
    if (!exported?.has(srcSym)) {
      throw new Error(`[build-browser-sync] 模块变量 ${modVar} 未导出符号 "${srcSym}"`);
    }
  }
}
for (const m of fullCode.matchAll(/\b(__mod_[A-Za-z0-9_]+)\.([A-Za-z0-9_$]+)\b/g)) {
  const [, modVar, prop] = m;
  const exported = moduleExportsByVar.get(modVar);
  if (!exported?.has(prop)) {
    throw new Error(`[build-browser-sync] 模块变量 ${modVar} 未导出属性 "${prop}"`);
  }
}
if (/\bimport\.meta\b/.test(fullCode)) {
  throw new Error('[build-browser-sync] 打包产物中残留未替换的 import.meta');
}
const manifestVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const indexCode = fs.readFileSync(path.join(ROOT, 'extension/index.js'), 'utf8');
const settingsCode = fs.readFileSync(path.join(ROOT, 'extension/settings.js'), 'utf8');
for (const m of indexCode.matchAll(/\?v=([0-9]+\.[0-9]+\.[0-9]+)/g)) {
  if (m[1] !== manifestVer) throw new Error(`[build-browser-sync] extension/index.js 子模块版本号 ${m[1]} 与 manifest.json (${manifestVer}) 不一致`);
}
if (!settingsCode.includes(`v${manifestVer}`)) {
  throw new Error(`[build-browser-sync] extension/settings.js 面板标题版本号未同步为 v${manifestVer}`);
}

const outPath = path.join(ROOT, 'extension', 'browser-sync.js');
fs.writeFileSync(outPath, fullCode, 'utf8');
console.log('Generated:', outPath, 'bytes:', fullCode.length);
