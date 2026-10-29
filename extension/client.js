// One authenticated loopback transport serves panel commands, jobs and receipts.
const ROUTES = { version: ['GET', 'version'], status: ['GET', 'status'], claim: ['POST', 'jobs/claim'], result: ['POST', 'skills/result'], control: ['POST', 'control'] };
export class BridgeError extends Error {
    constructor(message, code, details) { super(message); this.name = 'BridgeError'; this.code = code; this.details = details; }
}
export function createBridgeClient({
    fetchImpl = (...args) => fetch(...args), configUrl = new URL('./connection.json', import.meta.url),
    getShellCommand = () => globalThis.__TAURI__?.shell?.Command,
    // 酒馆没有“运行程序”插件时，用 install 登记的 tt-card-bridge:// 链接让 Windows 启动后台（不是开机启动）
    openLaunchUrl = url => {
        const frame = document.createElement('iframe');
        frame.style.display = 'none';
        frame.src = url;
        document.body.append(frame);
        setTimeout(() => frame.remove(), 5000);
    },
    startupTimeoutMs = 15000, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    let configuration, starting;
    async function connection() {
        if (!configuration) configuration = (async () => {
            try {
                const response = await fetchImpl(configUrl, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
                if (!response.ok) throw new Error('missing configuration');
                const config = await response.json();
                const url = new URL(config.base);
                if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || typeof config.token !== 'string' || config.token.length < 32) throw new Error('invalid configuration');
                return { base: url.origin, token: config.token, launch: config.launch };
            } catch {
                configuration = null;
                throw new BridgeError('首次通过酒馆 Git URL 安装后，请到本扩展文件夹内双击运行一次 install.bat 完成本机同步授权（会先识别环境并询问确认），之后刷新页面点「启动同步」即可。', 'CONFIG_UNAVAILABLE');
            }
        })();
        return configuration;
    }
    async function request(operation, payload) {
        if (!Object.hasOwn(ROUTES, operation)) throw new BridgeError('未知后台操作', 'INVALID_OPERATION');
        const config = await connection();
        const [method, endpoint] = ROUTES[operation];
        let response;
        try {
            response = await fetchImpl(`${config.base}/tt-bridge/${endpoint}`, {
                method, cache: 'no-store', signal: AbortSignal.timeout(operation === 'control' ? 180000 : 5000),
                headers: { Authorization: `Bearer ${config.token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
                ...(method === 'POST' ? { body: JSON.stringify(payload ?? {}) } : {}),
            });
        } catch {
            throw new BridgeError('本机后台未连接或请求超时。可以点击「启动同步」建立连接；若写入已开始，请先查看状态，不要重复提交。', 'CONNECTION_FAILED');
        }
        const result = await response.json();
        if (!response.ok || result?.ok === false) throw new BridgeError(result.error?.message ?? `后台请求失败：HTTP ${response.status}`, result.error?.code ?? 'BRIDGE_HTTP', result.error?.details);
        return ['control', 'status'].includes(operation) ? result.data : result;
    }
    async function connectForStart() {
        try { return await request('status'); }
        catch (error) { if (error.code !== 'CONNECTION_FAILED') throw error; }
        const Command = getShellCommand();
        const config = await connection(), launch = config.launch;
        if (!Command?.create) {
            if (!launch?.url) throw new BridgeError('缺少后台启动配置。请关掉酒馆重新运行一次 tt-card install。', 'LAUNCH_CONFIG_UNAVAILABLE');
            try { openLaunchUrl(launch.url); }
            catch (error) { throw new BridgeError(`无法启动同步后台：${error?.message ?? error}`, 'LAUNCH_FAILED'); }
            return waitReady(null, '后台没有在规定时间内启动。如果弹出了“是否打开”的询问，请选允许后再点一次「启动同步」。');
        }
        if (!launch || ['script', 'cardsRoot', 'cwd'].some(key => typeof launch[key] !== 'string' || !launch[key])) {
            throw new BridgeError('缺少后台启动配置。请重新运行 tt-card install，由安装器配置工程位置。', 'LAUNCH_CONFIG_UNAVAILABLE');
        }
        let failure, stderr = '';
        // The official plugin owns process creation; this client only waits for HTTP readiness.
        try {
            const command = Command.create('tt-card-bridge', [launch.script, launch.cardsRoot], {
                cwd: launch.cwd,
                env: { TT_BRIDGE_PORT: new URL(config.base).port || '80', TT_BRIDGE_TOKEN: config.token, TT_BRIDGE_MANAGED: '1' },
            });
            command.stderr.on('data', line => { stderr = `${stderr}${line}\n`.slice(-2000); });
            command.on('error', error => { failure = new BridgeError(`后台启动失败：${String(error)}`, 'LAUNCH_FAILED'); });
            command.on('close', result => { failure = new BridgeError(`后台在连接完成前退出（${result.code ?? result.signal ?? '未知原因'}）。${stderr.trim()}`, 'LAUNCH_FAILED'); });
            await command.spawn();
        } catch (error) {
            throw new BridgeError(`无法启动同步后台：${error?.message ?? error}`, 'LAUNCH_FAILED');
        }
        return waitReady(() => failure, '后台已提交启动，但未在规定时间内连接成功。同步没有启用；请检查启动日志与连接地址。');
    }
    async function waitReady(getFailure, timeoutMessage) {
        const deadline = Date.now() + startupTimeoutMs;
        for (;;) {
            if (getFailure?.()) throw getFailure();
            try { return await request('status'); }
            catch (error) { if (error.code !== 'CONNECTION_FAILED') throw error; }
            if (getFailure?.()) throw getFailure();
            if (Date.now() >= deadline) throw new BridgeError(timeoutMessage, 'STARTUP_TIMEOUT');
            await wait(250);
        }
    }
    function startSync() {
        if (!starting) starting = (async () => {
            const status = await connectForStart();
            return status.paused === false ? status : request('control', { action: 'resume' });
        })().finally(() => { starting = null; });
        return starting;
    }
    return {
        connectionInfo: async () => ({ base: (await connection()).base, mode: 'shell' }),
        request, startSync,
        status: () => request('status'),
        control: (action, args = {}) => request('control', { ...args, action }),
    };
}

// Claims do not expire: a page reload cannot prove an in-flight write did not happen.
// The same page retries only its saved receipt after a transport failure.
export function createJobConsumer({ client, execute, consumerId = globalThis.crypto.randomUUID() }) {
    let pendingReceipt = null;
    let busy = false;
    return {
        consumerId,
        async consume(snapshot) {
            if (busy) return { busy: true };
            busy = true;
            try {
                if (pendingReceipt) {
                    await client.request('result', pendingReceipt);
                    const report = pendingReceipt;
                    pendingReceipt = null;
                    // This snapshot still contained the just-acknowledged job. Poll again, don't run it.
                    return { report };
                }
                const job = snapshot.cardJob ?? snapshot.skillJob;
                if (!job) return { idle: true };
                const claim = await client.request('claim', { id: job.id, consumerId });
                if (!claim.claimed) return { blocked: true, jobId: job.id, message: '任务已由另一页面领取，执行结果未确认。已停止重复执行；请检查两侧差异后处理。' };
                let report;
                try { report = await execute(snapshot.cardJob ? 'card' : 'skills', job); }
                catch (error) { report = { id: job.id, fatal: String(error?.message ?? error) }; }
                pendingReceipt = { ...report, id: job.id, consumerId };
                await client.request('result', pendingReceipt);
                pendingReceipt = null;
                return { report };
            } finally { busy = false; }
        },
    };
}
