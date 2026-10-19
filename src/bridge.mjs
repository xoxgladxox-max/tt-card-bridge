// One FIFO owns both card and skill jobs. A timed-out caller never cancels a write.
import http from 'node:http';
import { BRIDGE_PORT, BRIDGE_BASE, connection, authorized, allowedOrigins, bridgeRequest } from './connection.mjs';
import { fail, segment, hashObject } from './safety.mjs';
export { BRIDGE_PORT };

export class JobQueue {
  jobs = [];
  results = new Map();
  publish(kind, job) {
    if (!['card', 'skills'].includes(kind) || !job || typeof job.id !== 'string' || !job.id || job.id.length > 200) fail('INVALID_JOB', '任务需要有效 id', 400);
    if (kind === 'card') {
      if (job.avatar !== undefined) segment(job.avatar, '卡文件名');
      if (job.worldName !== undefined && job.worldName !== null) segment(job.worldName, '世界书名');
      if (job.card?.data?.extensions?.world) segment(job.card.data.extensions.world, '世界书名');
      if (job.op !== undefined && !['create', 'rename', 'restore'].includes(job.op)) fail('INVALID_JOB', '未知卡任务', 400);
      if (job.op === 'create') { segment(job.name, '卡名'); segment(job.fileName, '卡文件名'); }
      if (job.op === 'rename') segment(job.newName, '新卡名');
    }
    if (this.jobs.some(x => x.job.id === job.id) || this.results.has(job.id)) fail('DUPLICATE_JOB', '任务 id 已存在');
    if (this.jobs.length >= 100) fail('QUEUE_FULL', '任务队列已满', 429);
    this.jobs.push({ kind, job });
    return { id: job.id, position: this.jobs.length };
  }
  get active() { return this.jobs[0] ?? null; }
  claim({ id, consumerId }) {
    if (typeof consumerId !== 'string' || !consumerId || consumerId.length > 200) fail('INVALID_CONSUMER', 'consumerId 无效', 400);
    if (this.active?.job.id !== id) fail('STALE_JOB', '只能领取当前任务');
    const active = this.active;
    if (!active.consumerId) active.consumerId = consumerId;
    return { claimed: active.consumerId === consumerId, consumerId: active.consumerId };
  }
  finish(result) {
    const done = this.results.get(result?.id);
    if (done) { if (hashObject(done) === hashObject(result)) return; fail('STALE_RESULT', '任务已经回报，不能替换结果'); }
    if (!result || this.active?.job.id !== result.id) fail('STALE_RESULT', '回报不属于当前任务');
    if (!this.active.consumerId || result.consumerId !== this.active.consumerId) fail('UNCLAIMED_RESULT', '回报者没有领取此任务');
    this.results.set(result.id, result);
    this.jobs.shift();
    while (this.results.size > 200) this.results.delete(this.results.keys().next().value);
  }
  result(id) { return this.results.get(id) ?? { pending: true }; }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => { size += c.length; if (size <= maxBytes) chunks.push(c); });
    req.on('error', reject);
    req.on('end', () => {
      try {
        if (size > maxBytes) fail('BODY_TOO_LARGE', '请求体超过上限', 413);
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_JSON', '请求体必须为对象', 400);
        resolve(value);
      } catch (e) { if (!e.status) { e.status = 400; e.code = 'INVALID_JSON'; } reject(e); }
    });
  });
}
export function createBridgeServer({ token, origins = allowedOrigins(), service = null, queue = new JobQueue(), maxBodyBytes = 16 * 1024 * 1024 } = {}) {
  if (!token) fail('INVALID_TOKEN', '服务必须启用鉴权', 500);
  let version = Date.now(), files = [];
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin', ...(origin && origins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } : {}) });
      res.end(code === 204 ? undefined : JSON.stringify(data));
    };
    try {
      if (origin && !origins.includes(origin)) fail('FORBIDDEN_ORIGIN', '此来源不允许连接', 403);
      // Preflight contains no credentials or state; every actual endpoint requires Bearer.
      if (req.method === 'OPTIONS') return send(204, {});
      if (!authorized(req.headers.authorization, token)) fail('UNAUTHORIZED', '需要连接令牌', 401);
      const url = new URL(req.url, BRIDGE_BASE);
      const endpoint = url.pathname;
      if (req.method === 'GET' && endpoint === '/tt-bridge/version') {
        const active = queue.active;
        return send(200, { version, files, cardJob: active?.kind === 'card' ? active.job : null, skillJob: active?.kind === 'skills' ? active.job : null, queueDepth: queue.jobs.length, jobClaim: active?.consumerId ? { id: active.job.id, consumerId: active.consumerId } : null });
      }
      if (req.method === 'GET' && endpoint === '/tt-bridge/status') {
        if (!service) fail('NO_SERVICE', '当前进程只有 CLI 任务服务；请启动 mirror', 503);
        return send(200, { ok: true, data: await service.status() });
      }
      if (req.method === 'GET' && endpoint === '/tt-bridge/skills/result') return send(200, queue.result(url.searchParams.get('id')));
      if (req.method !== 'POST') return send(404, { ok: false, error: { code: 'NOT_FOUND', message: '未知端点' } });
      const body = await readBody(req, maxBodyBytes);
      if (endpoint === '/tt-bridge/control') {
        if (!service) fail('NO_SERVICE', '请启动 mirror 管理服务', 503);
        return send(200, { ok: true, data: await service.control(body) });
      }
      if (endpoint === '/tt-bridge/bump') {
        if (!Array.isArray(body.files) || !body.files.every(x => typeof x === 'string')) fail('INVALID_JOB', 'files 必须为字符串数组', 400);
        files = body.files; version++;
        return send(200, { version });
      }
      if (endpoint === '/tt-bridge/jobs/claim') return send(200, queue.claim(body));
      if (endpoint === '/tt-bridge/card/publish') return send(200, queue.publish('card', body));
      if (endpoint === '/tt-bridge/skills/publish') return send(200, queue.publish('skills', body));
      if (endpoint === '/tt-bridge/skills/result') { queue.finish(body); return send(200, { ok: true }); }
      send(404, { ok: false, error: { code: 'NOT_FOUND', message: '未知端点' } });
    } catch (e) { send(e.status ?? 500, { ok: false, error: { code: e.code ?? 'INTERNAL', message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } }); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server, queue, bump(list) { files = list; version++; } };
}

let local = null;
export async function startBridge(log = console.log, options = {}) {
  if (local) return true;
  const instance = createBridgeServer({ token: connection().token, ...options });
  return new Promise((resolve, reject) => {
    instance.server.once('error', async e => {
      if (e.code !== 'EADDRINUSE') return reject(e);
      try { await bridgeRequest('version'); log(`刷新通知：复用已鉴权的 ${BRIDGE_BASE}`); resolve(false); }
      catch (error) { reject(error); }
    });
    instance.server.listen(BRIDGE_PORT, '127.0.0.1', () => { local = instance; log(`刷新通知：${BRIDGE_BASE}（已启用鉴权）`); resolve(true); });
  });
}
export function stopBridge() { if (local) { local.server.close(); local = null; } }
export async function notifyTavern(files) {
  if (local) local.bump(files); else await bridgeRequest('bump', { files });
  return true;
}
export const getJobResult = id => local ? Promise.resolve(local.queue.result(id)) : bridgeRequest(`skills/result?id=${encodeURIComponent(id)}`);
export const publishSkillJob = (job, opts) => publishJob('skills', job, opts);
export const publishCardJob = (job, opts) => publishJob('card', job, opts);
async function publishJob(kind, job, { timeoutMs = 150_000, pollMs = 500 } = {}) {
  if (local) local.queue.publish(kind, job); else await bridgeRequest(`${kind}/publish`, job);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await getJobResult(job.id);
    if (!result.pending) return result;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  fail('JOB_TIMEOUT', '酒馆任务仍未确认；没有取消任务，不会标记同步成功', 504, { jobId: job.id });
}
