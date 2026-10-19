import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fail } from './safety.mjs';

export const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRIDGE_PORT = Number(process.env.TT_BRIDGE_PORT ?? 18789);
export const BRIDGE_BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
export function connection({ root = BRIDGE_ROOT, env = process.env } = {}) {
  if (env.TT_BRIDGE_TOKEN) {
    if (env.TT_BRIDGE_TOKEN.length < 32) fail('INVALID_TOKEN', 'TT_BRIDGE_TOKEN 至少32字符', 500);
    return { token: env.TT_BRIDGE_TOKEN };
  }
  const file = path.join(root, '.runtime', 'connection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ token: crypto.randomBytes(32).toString('hex') }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof config.token !== 'string' || config.token.length < 32) fail('INVALID_TOKEN', '运行配置令牌无效；不会覆盖现有配置', 500);
  return config;
}
export function authorized(header, token) {
  const actual = Buffer.from(header ?? ''), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
export const allowedOrigins = () => (process.env.TT_BRIDGE_ORIGINS ?? 'tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:8000,http://localhost:1430,http://127.0.0.1:1430').split(',').filter(Boolean);
export async function bridgeRequest(endpoint, body, { base = BRIDGE_BASE, token = connection().token } = {}) {
  const r = await fetch(`${base}/tt-bridge/${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json();
  if (!r.ok) fail(data.error?.code ?? 'BRIDGE_HTTP', data.error?.message ?? `HTTP ${r.status}`, r.status);
  return data;
}
