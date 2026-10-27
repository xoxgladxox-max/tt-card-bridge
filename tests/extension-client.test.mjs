import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createBridgeClient, createJobConsumer } from '../extension/client.js';
import { createTavernMutations } from '../extension/tavern-mutations.js';
import { sha256Hex, worldDigest } from '../extension/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG_URL = 'http://tavern.test/connection.json';
const TOKEN = 'test-only-token-'.repeat(4);
const LAUNCH = { script: path.join(ROOT, 'src', 'mirror.mjs'), cardsRoot: path.join(ROOT, '.runtime', 'test-only-cards'), cwd: ROOT };
function httpClient(handler, { config = {}, ...options } = {}) {
    return createBridgeClient({ ...options, configUrl: CONFIG_URL, fetchImpl: async (url, init) => String(url) === CONFIG_URL
        ? Response.json({ base: 'http://127.0.0.1:18789', token: TOKEN, launch: LAUNCH, ...config }) : handler(String(url), init) });
}
function shellFixture(onSpawn = () => {}) {
    const events = {}, calls = [];
    const command = {
        on: (event, handler) => { events[event] = handler; },
        stderr: { on: (_event, handler) => { events.stderr = handler; } },
        spawn: async () => { calls.push('spawn'); await onSpawn(events); return { pid: 123 }; },
    };
    return { calls, Command: { create: (...args) => { calls.push(args); return command; } } };
}

test('missing installed configuration is explicit and does not need a native host', async () => {
    const client = createBridgeClient({ fetchImpl: async () => new Response('', { status: 404 }) });
    await assert.rejects(client.control('resume'), { code: 'CONFIG_UNAVAILABLE' });
});

test('one authenticated HTTP client serves control, status and job polling', async () => {
    const calls = [];
    const client = httpClient(async (url, init) => {
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
        calls.push([url, init.method, init.body ? JSON.parse(init.body) : undefined]);
        return Response.json(url.endsWith('/version') ? { version: 1 } : { ok: true, data: { paused: true } });
    });
    assert.deepEqual(await client.status(), { paused: true });
    assert.deepEqual(await client.control('pause'), { paused: true });
    assert.deepEqual(await client.request('version'), { version: 1 });
    assert.deepEqual(calls, [
        ['http://127.0.0.1:18789/tt-bridge/status', 'GET', undefined],
        ['http://127.0.0.1:18789/tt-bridge/control', 'POST', { action: 'pause' }],
        ['http://127.0.0.1:18789/tt-bridge/version', 'GET', undefined],
    ]);
    assert.deepEqual(await client.connectionInfo(), { base: 'http://127.0.0.1:18789', mode: 'shell' });
    await assert.rejects(client.request('exec', { command: 'node' }), { code: 'INVALID_OPERATION' });
});

test('service errors retain code and details instead of becoming success', async () => {
    const client = httpClient(async () => Response.json({ ok: false, error: { code: 'STALE_PREVIEW', message: '已变化', details: { projectId: 'p' } } }, { status: 409 }));
    await assert.rejects(client.control('connect'), error => error.code === 'STALE_PREVIEW' && error.details.projectId === 'p');
    await assert.rejects(client.startSync(), { code: 'STALE_PREVIEW' });
});

test('stopped background points to the start button instead of a manual BAT', async () => {
    const client = httpClient(async () => { throw new TypeError('fetch failed'); });
    await assert.rejects(client.status(), error => error.code === 'CONNECTION_FAILED' && error.message.includes('启动同步') && !error.message.includes('.bat'));
});

test('starting an already running service resumes once and never spawns another process', async () => {
    let paused = true, resumes = 0;
    const client = httpClient(async (url, init) => {
        if (url.endsWith('/control')) { assert.equal(JSON.parse(init.body).action, 'resume'); resumes++; paused = false; }
        return Response.json({ ok: true, data: { paused } });
    }, { getShellCommand: () => { throw new Error('must not launch a second process'); } });
    assert.equal((await client.startSync()).paused, false);
    assert.equal((await client.startSync()).paused, false);
    assert.equal(resumes, 1);
});

test('one click shares one official Shell launch, waits for readiness, then resumes', async () => {
    let ready = false, waits = 0;
    const steps = [], shell = shellFixture(() => { steps.push('spawn'); });
    const client = httpClient(async (url, init) => {
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
        if (url.endsWith('/status')) {
            steps.push('status');
            if (!ready) throw new TypeError('not listening yet');
            return Response.json({ ok: true, data: { paused: true } });
        }
        assert.equal(JSON.parse(init.body).action, 'resume');
        steps.push('resume');
        return Response.json({ ok: true, data: { paused: false } });
    }, { getShellCommand: () => shell.Command, wait: async () => { waits++; ready = true; } });
    const first = client.startSync(), second = client.startSync();
    assert.equal(first, second);
    assert.equal((await first).paused, false);
    assert.deepEqual(steps, ['status', 'spawn', 'status', 'status', 'resume']);
    assert.equal(waits, 1);
    assert.deepEqual(shell.calls, [[
        'tt-card-bridge', [LAUNCH.script, LAUNCH.cardsRoot],
        { cwd: LAUNCH.cwd, env: { TT_BRIDGE_PORT: '18789', TT_BRIDGE_TOKEN: TOKEN, TT_BRIDGE_MANAGED: '1' } },
    ], 'spawn']);
});

test('missing launch configuration is explicit and launches nothing', async () => {
    const shell = shellFixture(), opened = [];
    for (const options of [
        { getShellCommand: () => undefined, openLaunchUrl: url => opened.push(url), config: { launch: LAUNCH } },
        { getShellCommand: () => shell.Command, config: { launch: null } },
    ]) {
        const client = httpClient(async () => { throw new TypeError('offline'); }, options);
        await assert.rejects(client.startSync(), { code: 'LAUNCH_CONFIG_UNAVAILABLE' });
    }
    assert.deepEqual(shell.calls, []);
    assert.deepEqual(opened, []);
});

test('without a host Shell plugin the button opens the registered launch link once, then waits and resumes', async () => {
    let ready = false;
    const opened = [], steps = [];
    const client = httpClient(async (url, init) => {
        if (url.endsWith('/status')) { steps.push('status'); if (!ready) throw new TypeError('not yet'); return Response.json({ ok: true, data: { paused: true } }); }
        assert.equal(JSON.parse(init.body).action, 'resume');
        steps.push('resume');
        return Response.json({ ok: true, data: { paused: false } });
    }, { getShellCommand: () => undefined, openLaunchUrl: url => opened.push(url), wait: async () => { ready = true; }, config: { launch: { ...LAUNCH, url: 'tt-card-bridge://start' } } });
    const first = client.startSync(), second = client.startSync();
    assert.equal(first, second);
    assert.equal((await first).paused, false);
    assert.deepEqual(opened, ['tt-card-bridge://start']);
    assert.deepEqual(steps, ['status', 'status', 'status', 'resume']);
});

test('launch link that never brings the service up times out without enabling sync', async () => {
    let resumes = 0;
    const client = httpClient(async url => { if (url.endsWith('/control')) resumes++; throw new TypeError('offline'); },
        { getShellCommand: () => undefined, openLaunchUrl: () => {}, startupTimeoutMs: 0, config: { launch: { ...LAUNCH, url: 'tt-card-bridge://start' } } });
    await assert.rejects(client.startSync(), error => error.code === 'STARTUP_TIMEOUT' && error.message.includes('允许'));
    assert.equal(resumes, 0);
});

test('failed, exited or timed out startup never enables synchronization', async () => {
    for (const mode of ['permission', 'close', 'error', 'timeout']) {
        let resumes = 0;
        const shell = shellFixture(events => {
            if (mode === 'permission') throw new Error('shell spawn denied');
            if (mode === 'close') { events.stderr('startup failure'); events.close({ code: 1 }); }
            if (mode === 'error') events.error('node not found');
        });
        const client = httpClient(async url => {
            if (url.endsWith('/control')) resumes++;
            throw new TypeError('offline');
        }, { getShellCommand: () => shell.Command, startupTimeoutMs: 0 });
        await assert.rejects(client.startSync(), { code: mode === 'timeout' ? 'STARTUP_TIMEOUT' : 'LAUNCH_FAILED' });
        assert.equal(resumes, 0);
    }
});

test('lost receipt retries only the receipt, never executes the write twice', async () => {
    let executions = 0, receipts = 0, claims = 0;
    const client = { request: async op => {
        if (op === 'claim') { claims++; return { claimed: true }; }
        if (op === 'result' && ++receipts === 1) throw new Error('connection lost');
        return { ok: true };
    } };
    const consumer = createJobConsumer({ client, consumerId: 'page-1', execute: async (_, job) => { executions++; return { id: job.id, card: 'written' }; } });
    const snapshot = { cardJob: { id: 'one' } };
    await assert.rejects(consumer.consume(snapshot), /connection lost/);
    const result = await consumer.consume(snapshot);
    assert.equal(result.report.consumerId, 'page-1');
    assert.equal(executions, 1); assert.equal(claims, 1); assert.equal(receipts, 2);
});

test('a new page does not replay a claimed job of the old page', async () => {
    let executions = 0;
    const consumer = createJobConsumer({ consumerId: 'new-page', client: { request: async () => ({ claimed: false, consumerId: 'old-page' }) }, execute: async () => { executions++; } });
    const result = await consumer.consume({ cardJob: { id: 'in-flight' } });
    assert.equal(result.blocked, true); assert.equal(executions, 0);
});

test('execution failure is reported with the matching job and consumer', async () => {
    let receipt;
    const consumer = createJobConsumer({ consumerId: 'page', client: { request: async (op, data) => {
        if (op === 'claim') return { claimed: true };
        receipt = data; return { ok: true };
    } }, execute: async () => { throw new Error('save failed'); } });
    await consumer.consume({ skillJob: { id: 's' } });
    assert.deepEqual(receipt, { id: 's', fatal: 'save failed', consumerId: 'page' });
});

async function mutationFixture(options = {}) {
    const png = new Uint8Array([137, 80, 78, 71, 4, 1]);
    let world = options.world ?? { entries: { 0: { uid: 0, content: 'base' } } };
    const worldNames = new Set(options.worldNames ?? ['book', 'taken']);
    const calls = [], writes = [];
    const context = {
        characters: options.characters ?? [],
        getCharacters: async () => {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-only' }),
        loadWorldInfo: async () => options.workingWorld ?? world,
        saveWorldInfo: async (name, value, immediately) => { assert.equal(immediately, true); writes.push('world'); if (options.failWorld) throw new Error('world save failed'); worldNames.add(name); world = value; },
        convertCharacterBook: book => ({ entries: Object.fromEntries(book.entries.map(e => [e.uid, e])) }),
        updateWorldInfoList: async () => {}, reloadWorldInfoEditor: async () => {},
    };
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        if (url.startsWith('/characters/')) return new Response(png, { status: options.pngStatus ?? 200 });
        if (url === '/api/settings/get') return Response.json(options.invalidWorldList ? {} : { world_names: [...worldNames] });
        if (url === '/api/worldinfo/get') {
            const name = JSON.parse(init.body).name;
            return name === 'taken' ? Response.json({ entries: {} }) : Response.json(world);
        }
        if (url === '/api/characters/import') {
            assert.ok(init.body instanceof FormData);
            assert.equal(init.body.get('preserved_name'), 'x.png');
            assert.equal(init.body.get('file_type'), 'png');
            assert.equal(init.headers.has('Content-Type'), false);
            assert.equal(init.headers.get('X-CSRF-Token'), 'test-only');
            writes.push('import');
            return Response.json({ file_name: 'x', character: { avatar: 'x.png' } }, { status: options.failImport ? 500 : 200 });
        }
        if (url === '/api/characters/merge-attributes') { writes.push('card'); return new Response('{}', { status: options.failCard ? 500 : 200 }); }
        throw new Error(`Unexpected URL: ${url}`);
    };
    const mutations = createTavernMutations({ getContext: () => context, fetchImpl, refreshCards: async () => 'test' });
    const expected = { card: await sha256Hex(png), worldName: 'book', world: await worldDigest(world) };
    return { mutations, calls, writes, expected };
}

test('card precondition hashes the raw asset, not the normalized export endpoint', async () => {
    const f = await mutationFixture();
    const report = await f.mutations.runCard({ id: 'c', avatar: '中文 卡.png', expected: f.expected, card: { data: {} } });
    assert.equal(report.card, 'written');
    assert.deepEqual(f.writes, ['card']);
    assert.equal(f.calls[0].url, `/characters/${encodeURIComponent('中文 卡.png')}`);
    assert.equal(f.calls[0].init.cache, 'no-store');
    assert.equal(f.calls.some(call => call.url.includes('/export')), false);
});

test('partial PNG responses are not accepted as full-file fingerprints', async () => {
    const f = await mutationFixture({ pngStatus: 206 });
    await assert.rejects(f.mutations.runCard({ id: 'c', avatar: 'x.png', expected: f.expected, card: { data: {} } }), /完整200/);
    assert.deepEqual(f.writes, []);
});

test('changed card, world, or unsaved world edit blocks all writes', async () => {
    for (const mode of ['card', 'world', 'working']) {
        const f = await mutationFixture(mode === 'working' ? { workingWorld: { entries: { 0: { content: 'unsaved' } } } } : {});
        if (mode !== 'working') f.expected[mode] = 'stale';
        await assert.rejects(f.mutations.runCard({ id: mode, avatar: 'x.png', expected: f.expected, card: { data: {} } }));
        assert.deepEqual(f.writes, []);
    }
});

test('missing world and existing empty world are distinguished by the fresh list', async () => {
    const missing = await mutationFixture({ worldNames: [] });
    missing.expected.world = null;
    await missing.mutations.runCard({ id: 'missing', avatar: 'x.png', expected: missing.expected, card: { data: {} } });
    assert.deepEqual(missing.writes, ['card']);
    assert.equal(missing.calls.some(c => c.url === '/api/worldinfo/get'), false);
    const existing = await mutationFixture({ world: { entries: {} } });
    existing.expected.world = null;
    await assert.rejects(existing.mutations.runCard({ id: 'existing', avatar: 'x.png', expected: existing.expected, card: { data: {} } }), /世界书在预览后发生变化/);
    assert.deepEqual(existing.writes, []);
});

test('failed world list never becomes an empty list permitting a write', async () => {
    const f = await mutationFixture({ invalidWorldList: true });
    f.expected.world = null;
    await assert.rejects(f.mutations.runCard({ id: 'c', avatar: 'x.png', expected: f.expected, card: { data: {} } }), /无法取得世界书列表/);
    assert.deepEqual(f.writes, []);
});

test('target world appearing after preview blocks the card write', async () => {
    const f = await mutationFixture();
    f.expected.targetWorld = { name: 'taken', hash: null };
    await assert.rejects(f.mutations.runCard({ id: 'c', avatar: 'x.png', expected: f.expected, card: { data: {} } }), /名称已被占用/);
    assert.deepEqual(f.writes, []);
});

test('world write failure after card write is a failure, not a success receipt', async () => {
    const f = await mutationFixture({ failWorld: true });
    await assert.rejects(f.mutations.runCard({ id: 'c', avatar: 'x.png', expected: f.expected, card: { data: { extensions: { world: 'book' }, character_book: { entries: [{ uid: 0, content: 'new' }] } } } }), /world save failed/);
    assert.deepEqual(f.writes, ['card', 'world']);
});

test('create imports PNG with preserved_name, creates new world book, and refuses existing card or world names', async () => {
    const f = await mutationFixture({ worldNames: [] });
    const report = await f.mutations.create({ id: 'new-1', op: 'create', avatar: 'x.png', pngBase64: Buffer.from('new-png').toString('base64'), worldName: 'fresh-book', book: { entries: [{ uid: 0, content: 'new world' }] } });
    assert.equal(report.created, true);
    assert.equal(report.avatar, 'x.png');
    assert.deepEqual(f.writes, ['import', 'world']);
    const clashCard = await mutationFixture({ characters: [{ avatar: 'X.png' }], worldNames: [] });
    await assert.rejects(clashCard.mutations.create({ id: 'new-2', op: 'create', avatar: 'x.png', pngBase64: Buffer.from('new-png').toString('base64') }), /已经有「x.png」/);
    assert.deepEqual(clashCard.writes, []);
    const clashWorld = await mutationFixture({ worldNames: ['taken'] });
    await assert.rejects(clashWorld.mutations.create({ id: 'new-3', op: 'create', avatar: 'x.png', pngBase64: Buffer.from('new-png').toString('base64'), worldName: 'taken' }), /已经有世界书「taken」/);
    assert.deepEqual(clashWorld.writes, []);
});

test('failed import does not create the world or report create success', async () => {
    const f = await mutationFixture({ failImport: true, worldNames: [] });
    await assert.rejects(f.mutations.create({ id: 'new-fail', op: 'create', avatar: 'x.png', pngBase64: Buffer.from('new-png').toString('base64'), worldName: 'fresh-book', book: { entries: [] } }), /建卡失败/);
    assert.deepEqual(f.writes, ['import']);
});

test('installer ships the complete module tree and backs up replaced and removed extensions (isolated data only)', t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-bridge-install-test-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const userDir = path.join(temp, 'data', 'default-user');
    const extension = path.join(userDir, 'extensions', 'tt-card-bridge');
    fs.mkdirSync(extension, { recursive: true });
    fs.writeFileSync(path.join(extension, 'index.js'), 'old extension');
    const cardsRoot = path.join(temp, 'cards');
    const env = { ...process.env, TAVERN_USER_DIR: userDir, TT_BRIDGE_TOKEN: TOKEN, TT_BRIDGE_PORT: '18789', TT_BRIDGE_CARDS_ROOT: cardsRoot };
    execFileSync(process.execPath, ['bin/tt-card.mjs', 'install'], { cwd: ROOT, env });
    for (const name of ['manifest.json', 'index.js', 'client.js', 'settings.js', 'protocol.js', 'tavern-mutations.js', 'style.css']) {
        assert.equal(fs.readFileSync(path.join(extension, name), 'utf8'), fs.readFileSync(path.join(ROOT, 'extension', name), 'utf8'));
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(extension, 'connection.json'), 'utf8')), {
        base: 'http://127.0.0.1:18789', token: TOKEN,
        launch: { script: path.join(ROOT, 'src', 'mirror.mjs'), cardsRoot, cwd: ROOT, url: 'tt-card-bridge://start' },
    });
    const backupRoot = path.join(temp, 'data', 'backups', 'tt-card-bridge');
    const first = fs.readdirSync(backupRoot);
    assert.equal(first.length, 1);
    assert.equal(fs.readFileSync(path.join(backupRoot, first[0], 'index.js'), 'utf8'), 'old extension');
    execFileSync(process.execPath, ['bin/tt-card.mjs', 'install', '--remove'], { cwd: ROOT, env });
    assert.equal(fs.existsSync(extension), false);
    assert.equal(fs.readdirSync(backupRoot).length, 2);
});
