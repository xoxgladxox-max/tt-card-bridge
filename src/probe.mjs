// tt-probe.mjs — 只读查看酒馆角色卡 PNG 的内部数据（测试用，不写任何文件）
// 用法：node scripts/tt-probe.mjs "<卡文件名.png>"
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseChunks } from './png.mjs';
import { tavernCharDir } from './paths.mjs';

const CHAR_DIR = tavernCharDir();

const name = process.argv[2];
if (!name) {
  console.log('characters 目录：' + CHAR_DIR);
  console.log(fs.readdirSync(CHAR_DIR).filter(f => f.endsWith('.png')).join('\n'));
  process.exit(0);
}

const buf = fs.readFileSync(path.join(CHAR_DIR, name));
const chunks = parseChunks(buf);
console.log('chunk 类型：' + chunks.map(c => c.type).join(', '));
for (const c of chunks.filter(c => c.type === 'tEXt')) {
  const data = Buffer.from(c.data);
  const sep = data.indexOf(0);
  const keyword = data.subarray(0, sep).toString('latin1');
  const json = JSON.parse(Buffer.from(data.subarray(sep + 1).toString('latin1'), 'base64').toString('utf8'));
  console.log(`\n== tEXt 关键字：${keyword} ==`);
  console.log('spec：' + json.spec + ' ' + (json.spec_version ?? ''));
  const d = json.data ?? json;
  for (const [k, v] of Object.entries(d)) {
    let desc;
    if (typeof v === 'string') desc = `字符串 ${v.length} 字`;
    else if (Array.isArray(v)) desc = `数组 ${v.length} 项`;
    else if (v && typeof v === 'object') desc = `对象：${Object.keys(v).join(', ')}`;
    else desc = JSON.stringify(v);
    console.log(`  ${k}: ${desc}`);
  }
}
