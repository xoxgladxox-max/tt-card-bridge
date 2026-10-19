// png.mjs — PNG tEXt/zTXt/iTXt 中 chara 负载的嵌入与解出
// 原则：只动 chara/ccv3 负载块，其余数据块逐字节保留。
import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// crc32（查表法，覆盖 chunk type + data）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function parseChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG 文件（签名不符）');
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) throw new Error(`PNG 块 ${type} 长度越界，文件可能损坏`);
    chunks.push({ type, data: buf.subarray(dataStart, dataEnd), raw: buf.subarray(off, dataEnd + 4) });
    off = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function makeChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function chunkKeyword(type, data) {
  // tEXt: keyword\0text；zTXt: keyword\0method...；iTXt: keyword\0flag method lang\0trans\0text
  const nul = data.indexOf(0);
  if (nul < 0) return null;
  return data.toString('latin1', 0, nul);
}

function decodeTextChunk(type, data) {
  const nul = data.indexOf(0);
  if (type === 'tEXt') return data.toString('latin1', nul + 1);
  if (type === 'zTXt') return zlib.inflateSync(data.subarray(nul + 2)).toString('latin1');
  if (type === 'iTXt') {
    const flag = data[nul + 1];
    // keyword\0 flag method lang\0 trans\0 text
    let p = nul + 3;
    const langEnd = data.indexOf(0, p); p = langEnd + 1;
    const transEnd = data.indexOf(0, p); p = transEnd + 1;
    const text = data.subarray(p);
    return flag === 1 ? zlib.inflateSync(text).toString('utf8') : text.toString('utf8');
  }
  throw new Error(`不支持的文本块类型 ${type}`);
}

export function extractChara(pngBuf) {
  const chunks = parseChunks(pngBuf);
  for (const c of chunks) {
    if (!['tEXt', 'zTXt', 'iTXt'].includes(c.type)) continue;
    const kw = chunkKeyword(c.type, c.data);
    if (kw !== 'chara' && kw !== 'ccv3') continue;
    const text = decodeTextChunk(c.type, c.data);
    const json = Buffer.from(text.trim(), 'base64').toString('utf8');
    return { keyword: kw, card: JSON.parse(json) };
  }
  return null;
}

export function embedChara(pngBuf, cardJson) {
  const chunks = parseChunks(pngBuf);
  const payload = Buffer.concat([
    Buffer.from('chara', 'latin1'), Buffer.from([0]),
    Buffer.from(Buffer.from(JSON.stringify(cardJson), 'utf8').toString('base64'), 'latin1'),
  ]);
  const charaChunk = makeChunk('tEXt', payload);
  const kept = chunks.filter(c =>
    !(['tEXt', 'zTXt', 'iTXt'].includes(c.type) && ['chara', 'ccv3'].includes(chunkKeyword(c.type, c.data))));
  const iend = kept.findIndex(c => c.type === 'IEND');
  if (iend < 0) throw new Error('PNG 缺 IEND 块，文件可能损坏');
  const parts = [PNG_SIG, ...kept.slice(0, iend).map(c => c.raw), charaChunk, ...kept.slice(iend).map(c => c.raw)];
  return Buffer.concat(parts);
}