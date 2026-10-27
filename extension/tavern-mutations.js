import { sha256Hex, worldDigest } from './protocol.js';

// Existing SillyTavern write APIs remain the only writers. This checks the preview
// before starting; these APIs do not yet provide an atomic compare-and-swap transaction.
export function createTavernMutations({ getContext, fetchImpl = (...args) => fetch(...args), refreshCards }) {
    async function request(url, body, { allowMissing = false } = {}) {
        const response = await fetchImpl(url, {
            method: 'POST', cache: 'no-store',
            headers: getContext().getRequestHeaders(),
            body: JSON.stringify(body),
        });
        if (allowMissing && response.status === 404) return null;
        if (!response.ok) throw new Error(`${url} 失败：HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
        return response;
    }
    async function readWorld(name) {
        if (!name) return null;
        // TauriTavern returns {entries:{}} with HTTP 200 for a missing book.
        // Existence must come from the fresh list, not from an empty payload.
        const settings = await (await request('/api/settings/get', {})).json();
        if (!Array.isArray(settings.world_names)) throw new Error('无法取得世界书列表；未将查询失败当作文件不存在。');
        if (!settings.world_names.includes(name)) return null;
        return (await request('/api/worldinfo/get', { name })).json();
    }
    async function readCardBytes(avatar) {
        // The export endpoint rewrites metadata. Only the original asset can be
        // compared with the raw PNG fingerprint held by the Node service.
        const response = await fetchImpl(`/characters/${encodeURIComponent(avatar)}`, { cache: 'no-store' });
        if (response.status === 404) return null;
        if (response.status !== 200) throw new Error(`读取角色卡原文件失败：HTTP ${response.status}；需要完整200响应。`);
        return response.arrayBuffer();
    }
    async function assertExpected(job, { worldOnly = false } = {}) {
        if (!job.expected) throw new Error('任务缺少预览校验信息；已拒绝写入，请更新同步后台。');
        if (!worldOnly) {
            const bytes = await readCardBytes(job.avatar);
            const actual = bytes === null ? null : await sha256Hex(bytes);
            if (actual !== job.expected.card) throw new Error('角色卡在预览后发生变化，已拒绝写入。请重新查看差异。');
        }
        const diskWorld = await readWorld(job.expected.worldName);
        const actualWorld = await worldDigest(diskWorld);
        if (actualWorld !== job.expected.world) throw new Error('世界书在预览后发生变化，已拒绝写入。请重新查看差异。');
        if (diskWorld !== null) {
            const workingWorld = await getContext().loadWorldInfo(job.expected.worldName);
            if (await worldDigest(workingWorld) !== actualWorld) throw new Error('世界书有未保存编辑或缓存与磁盘不一致；先保存或刷新酒馆，再重新查看差异。');
        }
        if (job.expected.targetWorld) {
            const target = job.expected.targetWorld;
            if (await worldDigest(await readWorld(target.name)) !== target.hash) throw new Error('待创建的世界书名称已被占用，已拒绝写入。');
        }
    }
    async function refreshWorld(name) {
        const st = getContext();
        await st.updateWorldInfoList();
        await st.reloadWorldInfoEditor(name);
    }
    async function writeWorld(name, world) {
        // The common save path owns the working-document cache and pending writes.
        await getContext().saveWorldInfo(name, world, true);
        const stored = await readWorld(name);
        if (await worldDigest(stored) !== await worldDigest(world)) throw new Error('世界书写入后的核验不一致；未报告成功。');
        return { name, after: Object.keys(stored?.entries ?? {}).length };
    }
    async function syncWorld(name, book) {
        const st = getContext();
        const old = await readWorld(name);
        const converted = st.convertCharacterBook(structuredClone(book));
        const entries = {};
        for (const [uid, entry] of Object.entries(converted.entries)) entries[uid] = { ...(old?.entries?.[uid] ?? {}), ...entry };
        const result = await writeWorld(name, { ...(old ?? {}), entries });
        return { ...result, created: !old, before: old?.entries ? Object.keys(old.entries).length : null };
    }
    async function runWorld(job) {
        await assertExpected(job, { worldOnly: true });
        const world = await syncWorld(job.worldName, job.book);
        const report = { id: job.id, world };
        try { await refreshWorld(job.worldName); } catch (error) { report.refreshWarning = String(error?.message ?? error); }
        return report;
    }
    async function runCard(job) {
        await assertExpected(job);
        await request('/api/characters/merge-attributes', { ...job.card, avatar: job.avatar });
        const report = { id: job.id, avatar: job.avatar, card: 'written' };
        const name = job.card.data?.extensions?.world;
        const book = job.card.data?.character_book;
        if (name && book?.entries) {
            // Card and world are separate upstream operations. If this fails after
            // the card write, the service reports the error and the card waits for reconnect.
            const actual = await worldDigest(await readWorld(job.expected.worldName));
            if (actual !== job.expected.world) throw new Error('角色卡已写入，但世界书发生并发变化；已停止后续写入。请重新连接。');
            report.world = await syncWorld(name, book);
            try { await refreshWorld(name); } catch (error) { report.refreshWarning = String(error?.message ?? error); }
        } else report.world = { skipped: name ? '节点没有内嵌条目，未改外置世界书' : '卡未绑定外置世界书' };
        try { report.refreshed = await refreshCards([job.avatar]); } catch (error) { report.refreshWarning = String(error?.message ?? error); }
        return report;
    }
    // 新建卡（作者决定 2026-10-27）：后台按本地工程合成好 PNG，卡名和世界书名都已避开重名。
    // 用酒馆自己的导入接口建卡（preserved_name 固定文件名），再新建世界书；不碰已有的卡和世界书
    async function create(job) {
        const st = getContext();
        await st.getCharacters();
        if (getContext().characters.some(card => card.avatar.toLowerCase() === job.avatar.toLowerCase())) throw new Error(`酒馆里已经有「${job.avatar}」，没有覆盖。`);
        if (job.worldName && await readWorld(job.worldName) !== null) throw new Error(`酒馆里已经有世界书「${job.worldName}」，没有覆盖。`);
        const bytes = Uint8Array.from(atob(job.pngBase64), c => c.charCodeAt(0));
        const form = new FormData();
        form.append('avatar', new Blob([bytes], { type: 'image/png' }), job.avatar);
        form.append('file_type', 'png');
        if (job.preserveFileName) form.append('preserved_name', job.avatar);
        const headers = new Headers(getContext().getRequestHeaders());
        headers.delete('Content-Type');
        const response = await fetchImpl('/api/characters/import', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`建卡失败：HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
        const imported = await response.json();
        const avatar = imported.character?.avatar ?? `${imported.file_name}.png`;
        const report = { id: job.id, avatar, created: true };
        if (job.worldName) {
            report.world = await syncWorld(job.worldName, job.book ?? { entries: [] });
            // TauriTavern 在 import 时如果采用内嵌世界书，可能按卡名把 extensions.world 改成卡名；这里显式对齐回目标世界书名
            await request('/api/characters/merge-attributes', { avatar, data: { extensions: { world: job.worldName } } });
        }
        try {
            if (job.worldName) await refreshWorld(job.worldName);
            report.refreshed = await refreshCards([avatar]);
        } catch (error) { report.refreshWarning = String(error?.message ?? error); }
        return report;
    }    return { assertExpected, runWorld, runCard, create };
}
