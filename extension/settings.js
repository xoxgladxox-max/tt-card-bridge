// Settings UI is a consumer of the same service as the CLI, never a second sync engine.
const text = value => value === undefined || value === null ? '' : String(value);
const errorText = error => error?.message ?? String(error);
const statusLabels = {
    clean: '两侧一致', unchecked: '尚未检查', differences: '存在差异', error: '处理失败',
    paused: '已暂停', unattached: '未接入', pending: '仍有未同步内容',
    operationPending: '写入结果待确认', reviewRequired: '需要人工复核',
    bindingConflict: '存在重复绑定', cardMissing: '连着的卡已不在酒馆里', needsReconnect: '已断开，等你选择',
};
function element(tag, content, className) {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = text(content);
    if (className) node.className = className;
    if (tag === 'textarea' || tag === 'select') node.classList.add('text_pole');
    if (tag === 'textarea') node.classList.add('textarea_compact');
    return node;
}
// Buttons with an icon keep their text in a <span>; dynamic labels must not wipe the icon.
function setLabel(node, label) {
    const span = node.querySelector('span');
    if (span) span.textContent = label; else node.textContent = label;
}
function button(label, run) {
    const node = element('button', label, 'menu_button ttcb-button');
    node.type = 'button';
    node.addEventListener('click', run);
    return node;
}
function formatLogLine(item) {
    if (typeof item === 'string') return item.length > 260 ? `${item.slice(0, 260)}…` : item;
    if (!item || typeof item !== 'object') return text(item);
    const time = typeof item.at === 'string' ? item.at.slice(11, 19) : '';
    const head = [time ? `[${time}]` : '', item.action ?? 'event', item.projectId ?? ''].filter(Boolean).join(' · ');
    const body = item.error?.message
        ? `失败(${item.error.code ?? 'ERROR'}): ${item.error.message}`
        : item.status
            ? `${statusLabels[item.status] ?? item.status}${item.changed ? '（已同步）' : ''}`
            : item.cardFile
                ? item.cardFile
                : '';
    const rep = item.repeat > 1 ? ` (×${item.repeat})` : '';
    const line = `${head}${body ? ` — ${body}` : ''}${rep}`;
    return line.length > 260 ? `${line.slice(0, 260)}…` : line;
}

export function mountSettings({ client, getContext, refreshCards }) {
    const container = document.getElementById('extensions_settings');
    if (!container) throw new Error('未找到酒馆扩展设置容器 #extensions_settings');
    if (document.getElementById('tt-card-bridge-settings')) return null;
    // Same drawer markup as the built-in extensions; the host owns open/close behaviour.
    const root = element('div', undefined, 'ttcb-settings');
    root.id = 'tt-card-bridge-settings';
    const icon = (name, cls, label, title) => `<button type="button" class="menu_button menu_button_icon" data-action="${name}" title="${title}"><i class="fa-solid ${cls}"></i><span>${label}</span></button>`;
    root.innerHTML = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>卡工程同步</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content"><div class="ttcb-body">
          <div class="flex-container alignitemscenter">
            <small data-role="status" role="status" class="flex1">正在读取后台状态…</small>
            ${icon('toggle', 'fa-power-off', '启动同步', '启动本机后台并开启自动同步；暂停不打断正在进行的写入')}
            ${icon('refresh', 'fa-arrows-rotate', '刷新', '重新读取状态，并把当前打开的卡告诉后台')}
          </div>
          <small class="ttcb-dim">后台 <code data-role="connection">—</code> · 工作区 <code data-role="cards-root">—</code></small>
          <hr>
          <small data-role="current-card"></small>
          <div data-role="card-extras">
            <div data-role="frameworks"></div>
            <div data-role="extras"></div>
          </div>
          <div class="flex-container">
            ${icon('attach', 'fa-boxes-packing', '拆解当前卡', '第一次把酒馆里的这张卡变成本地工程：拆到 工作区\\\\<卡名>\\\\，拆完自动连上')}
            ${icon('connect', 'fa-link', '连接', '把「工作区」里选中的卡工程连到酒馆：没进过酒馆的新建一张卡；连过的两边一致就直接连上，不一致让你选「以本地为准覆盖」或「新建卡」')}
          </div>
          <div data-role="msg" class="ttcb-msg">
            <div data-role="error" role="alert" class="ttcb-warning" hidden></div>
            <div data-role="diff"></div>
          </div>
          <details class="ttcb-fold" data-fold="workspace">
            <summary>工作区</summary>
            <div class="flex-container alignitemscenter">
              <select data-role="projects" class="flex1" aria-label="工作区里的卡工程"></select>
            </div>
            <small data-role="project-status" class="ttcb-dim"></small>
            <div class="flex-container alignitemscenter">
              <select data-role="worlds" class="flex1" aria-label="世界书编辑器里当前打开的世界书" title="只列世界书编辑器里当前打开的那一本"></select>
              ${icon('attach-world', 'fa-book', '拆解世界书', '把世界书编辑器里打开的这本独立世界书拆到工作区')}
            </div>
          </details>
          <details class="ttcb-fold" data-fold="settings">
            <summary>设置</summary>
            <div class="flex-container alignitemscenter">
              <input data-role="cards-root-input" type="text" class="flex1" placeholder="工作区目录，例如 D:\\cards" aria-label="工作区目录" autocomplete="off">
              ${icon('set-cards-root', 'fa-folder-open', '切换', '拆卡、连接、同步和 Agent 读写都在这个目录里')}
            </div>
          </details>
          <details class="ttcb-fold" data-fold="tools">
            <summary>工具</summary>
            <div class="flex-container">
              ${icon('skills-status', 'fa-magnifying-glass', '检查技能', '对照原件与 LimCode TEST、Claude Code、~/.agents/skills、酒馆里的技能和 Agent')}
              ${icon('skills-deploy', 'fa-wand-magic-sparkles', '同步技能', '把技能和 Agent 同步到各处')}
              ${icon('logs-toggle', 'fa-list', '日志', '显示或隐藏后台日志')}
              ${icon('diagnostics', 'fa-copy', '复制诊断', '复制诊断信息（含本机路径和卡名，不含令牌）')}
            </div>
            <pre data-role="skills-output" class="ttcb-logs" hidden></pre>
            <pre data-role="logs" class="ttcb-logs" hidden></pre>
          </details>
        </div></div>
      </div>`;
    for (const node of root.querySelectorAll('button')) node.classList.add('menu_button');
    for (const node of root.querySelectorAll('input[type="text"], select, textarea')) node.classList.add('text_pole');
    container.append(root);
    // 折叠区默认收起，展开状态记在浏览器里
    for (const fold of root.querySelectorAll('details[data-fold]')) {
        const key = `ttcb-fold-${fold.dataset.fold}`;
        try { fold.open = localStorage.getItem(key) === '1'; } catch { /* 无本地存储时保持收起 */ }
        fold.addEventListener('toggle', () => { try { localStorage.setItem(key, fold.open ? '1' : '0'); } catch { /* 同上 */ } });
    }
    const find = role => root.querySelector(`[data-role="${role}"]`);
    const action = name => root.querySelector(`[data-action="${name}"]`);
    let connection = null, state = null, busy = false, refreshing = false, projectSignature = '', worldSignature = '';
    let lastError = '', lastPolled = 0, actionFailed = false, lastFollowedCard = undefined, lastFollowedWorld = undefined, scannedCard = null, conflictShownFor = '', setupDismissed = false;
    const selectedProject = () => state?.assembleProjects?.find(project => project.id === find('projects').value) ?? state?.projects?.find(project => project.id === find('projects').value);
    // ② 用：下拉没选中时，工作区目录里只有一张卡就用那张
    const assembleTarget = () => selectedProject() || (state?.assembleProjects?.length === 1 ? state.assembleProjects[0] : null);
    const currentCard = () => {
        const ctx = getContext();
        return ctx.groupId ? null : ctx.characters?.[ctx.characterId];
    };
    // 世界书编辑器下拉框里当前选中的那一本；没有打开任何世界书时为 null
    const currentWorldName = () => {
        const select = document.querySelector('#world_editor_select');
        const option = select?.selectedOptions?.[0];
        if (!option || option.value === '' || option.value === '-1') return null;
        return option.textContent?.trim() || null;
    };
    const confirmAction = message => typeof window.confirm === 'function' ? window.confirm(message) : true;
    function showSetupConfirmPrompt(error) {
        const isPerm = error?.code === 'FOLDER_PERMISSION_REQUIRED';
        const sig = `setup|${error?.code}|${error?.details?.folderName ?? ''}`;
        if (conflictShownFor === sig) return;
        conflictShownFor = sig;
        find('error').hidden = true;
        const box = find('diff');
        box.replaceChildren();
        box.append(element('p', isPerm
            ? `检测到上次的工作区文件夹「${error?.details?.folderName ?? ''}」。是否允许读写并开启实时同步？`
            : '首次安装提示：检测到尚未配置本地卡工程工作区。是否现在启用？（将使用内置拆装卡模块，并在您选择的本地文件夹下读写 .md 卡工程文件，无需运行外部脚本）', 'ttcb-warning'));
        const row = element('div', undefined, 'flex-container');
        if (isPerm) {
            row.append(button('确认允许读写', () => run(async () => {
                setupDismissed = false;
                state = await client.authorizeWorkspace({ pickNew: false });
                await checkCardFollow({ force: true });
                done(`已恢复工作区连接（${state.cardsRoot}），实时同步已开启。`);
            })));
            row.append(button('更换工作区文件夹', () => run(async () => {
                setupDismissed = false;
                state = await client.authorizeWorkspace({ pickNew: true });
                await checkCardFollow({ force: true });
                done(`已切换工作区至「${state.cardsRoot}」，实时同步已开启。`);
            })));
        } else {
            row.append(button('确认启用（选择本地工作区文件夹）', () => run(async () => {
                setupDismissed = false;
                state = await client.authorizeWorkspace({ pickNew: true });
                await checkCardFollow({ force: true });
                done(`已启用本地卡工程同步（${state.cardsRoot}），现在可以点「拆解当前卡」或「连接」。`);
            })));
            row.append(button('暂不启用', () => {
                setupDismissed = true;
                conflictShownFor = '';
                box.replaceChildren(element('small', '已暂缓启用。需要时可随时点击上方「启动同步」选择本地工作区文件夹。', 'ttcb-dim'));
                find('status').textContent = '尚未启用（点「启动同步」选择工作区文件夹）';
            }));
        }
        box.append(row);
    }
    function showError(error) {
        if (error?.code === 'SETUP_CONFIRM_REQUIRED' || error?.code === 'FOLDER_PERMISSION_REQUIRED') {
            if (!setupDismissed) showSetupConfirmPrompt(error);
            return;
        }
        if (actionFailed && error?.code === 'CONNECTION_FAILED') return;
        lastError = errorText(error);
        find('error').textContent = lastError;
        find('error').hidden = !lastError;
    }
    function clearPreviews() {
        find('diff').replaceChildren();
        conflictShownFor = '';
    }
    // 拆前扫描：变量框架提示 + 正则/脚本/变量清单（勾上＝拆成文件，不勾＝留在 card.md）
    async function scanCurrentCard() {
        const card = currentCard();
        const fw = find('frameworks'), box = find('extras');
        if (!card?.avatar || !state) { fw.replaceChildren(); box.replaceChildren(); scannedCard = null; return; }
        if (scannedCard === card.avatar) return;
        scannedCard = card.avatar;
        let res;
        try { res = await client.control('scanCard', { cardFile: card.avatar }); }
        catch (error) { fw.replaceChildren(element('small', `扫描失败：${errorText(error)}`, 'ttcb-warning')); box.replaceChildren(); return; }
        if (scannedCard !== card.avatar) return;
        fw.replaceChildren();
        for (const f of res.frameworks ?? []) fw.append(element('small', `变量框架：${f.label}${f.hint ? ` — ${f.hint}` : ''}`), element('br'));
        box.replaceChildren();
        if (!res.items?.length) { box.append(element('small', '这张卡没有正则、脚本或角色变量。')); return; }
        box.append(element('small', '勾上的拆成文件（regex\\、scripts\\），不勾的留在 card.md 里；两种都会完整合回卡里。'));
        const kinds = { regex: '正则', script: '脚本', vars: '变量', xbtasks: '小白X' };
        for (const item of res.items) {
            const label = element('label', undefined, 'checkbox_label');
            const cb = element('input'); cb.type = 'checkbox'; cb.checked = item.split; cb.dataset.extraKey = item.key;
            label.append(cb, element('small', `${kinds[item.kind] ?? item.kind}：${item.label}${item.disabled ? '（已停用）' : ''}`));
            box.append(label);
        }
    }
    const keptExtras = () => [...find('extras').querySelectorAll('input[data-extra-key]')].filter(cb => !cb.checked).map(cb => cb.dataset.extraKey);
    // 断开后重连两边不一致、连着时两边都改了、原来的卡已不在：同步停下，只给两个选择（作者决定 2026-10-27）
    function showReconnectIfAny() {
        const p = selectedProject();
        const waiting = p && (p.status === 'needsReconnect' || p.status === 'cardMissing');
        if (!waiting) { if (conflictShownFor) { find('diff').replaceChildren(); conflictShownFor = ''; } return; }
        const r = p.lastResult ?? {};
        const onlyNew = p.status === 'cardMissing' || r.onlyNew === true;
        const sig = `${p.id}|${onlyNew}|${r.diff?.revision ?? ''}`;
        if (conflictShownFor === sig || busy) return;
        conflictShownFor = sig;
        const box = find('diff');
        box.replaceChildren();
        const items = [...(r.diff?.changedSlots ?? []).map(s => s.label ?? s.key), ...(r.diff?.issues ?? []).map(i => i.message)];
        box.append(element('p', onlyNew
            ? `「${p.id}」原来连的「${p.missingCardFile ?? p.cardFile}」已不在酒馆里，同步已停下。只能新建卡：`
            : `「${p.id}」和酒馆里的「${p.cardFile}」不一致${items.length ? `（${items.length} 项）` : ''}，同步已停下。选一个：`, 'ttcb-warning'));
        if (items.length) {
            const fold = element('details');
            fold.append(element('summary', '看是哪些'), element('small', [...new Set(items)].slice(0, 40).join('、')));
            box.append(fold);
        }
        const row = element('div', undefined, 'flex-container');
        if (!onlyNew) row.append(serviceButton('以本地为准覆盖', async () => {
            if (!confirmAction(`把本地工程「${p.id}」整个写进酒馆里的「${p.cardFile}」和它的世界书。\n断开期间在酒馆里做的改动不保留；聊天记录不动。继续？`)) return;
            const res = await client.control('reconnectOverwrite', { projectId: p.id });
            done(`已以本地为准覆盖「${res.project?.cardFile ?? p.cardFile}」，已连上，之后实时同步。`);
        }));
        row.append(serviceButton('新建卡', async () => {
            if (!confirmAction(`按本地工程「${p.id}」新建一张卡和一本世界书（重名会起新名字，不连旧的同名世界书），之后连到新卡。\n${onlyNew ? '' : `旧卡「${p.cardFile}」留在酒馆里不动。`}继续？`)) return;
            const res = await client.control('reconnectNew', { projectId: p.id });
            await openCard(res.cardFile);
            done(`已新建「${res.cardFile}」${res.worldName ? `和世界书「${res.worldName}」` : ''}，已连上，之后实时同步。`);
        }));
        box.append(row);
    }
    const done = message => { find('diff').replaceChildren(element('p', message)); conflictShownFor = ''; };
    // 连接或新建后让酒馆打开那张卡：后台只同步酒馆里打开的卡
    async function openCard(cardFile) {
        if (!cardFile) return;
        if (typeof refreshCards === 'function') await refreshCards([cardFile]);
        else await getContext().getCharacters?.();
        const now = getContext();
        if (now.groupId) throw new Error(`已连上「${cardFile}」。酒馆里开着群聊，退出群聊后打开这张卡，同步才会开始。`);
        const idx = now.characters.findIndex(c => c.avatar?.toLowerCase() === cardFile.toLowerCase());
        if (idx >= 0 && now.characters[now.characterId]?.avatar?.toLowerCase() !== cardFile.toLowerCase()) await now.selectCharacterById(idx);
        await checkCardFollow({ force: true });
    }
    function renderControls() {
        for (const control of root.querySelectorAll('button')) control.disabled = busy && control.dataset.action !== 'logs-toggle';
        action('toggle').disabled = busy;
        setLabel(action('toggle'), state?.paused === false ? '暂停同步' : '启动同步');
        action('set-cards-root').disabled = busy || (!state && connection?.mode !== 'browser');
        action('skills-status').disabled = busy || !state;
        action('skills-deploy').disabled = busy || !state;
        action('attach').disabled = busy || !state || !currentCard();
        action('attach-world').disabled = busy || !state || !find('worlds').value;
        const project = assembleTarget() || (state?.projects?.length === 1 ? state.projects[0] : null);
        const card = currentCard();
        // 已经连着、酒馆也正打开它时不用再连
        const liveHere = project && card?.avatar && project.cardFile?.toLowerCase() === card.avatar.toLowerCase() && ['clean', 'pending'].includes(project.status);
        action('connect').disabled = busy || !state || !project || project.targetKind === 'world' || !!liveHere;
        setLabel(action('connect'), project && project.targetKind !== 'world' ? `连接「${project.id}」` : '连接');
        const errOf = p => p?.status === 'error' && p.lastResult?.error?.message ? `：${p.lastResult.error.message}` : '';
        find('project-status').textContent = project
            ? `${project.name ?? project.cardFile ?? project.id} · ${project.attached ? (statusLabels[project.status] ?? project.status ?? '状态未知') : '还没进酒馆'}${errOf(project)}${project.pendingOperation ? ` · 未决任务 ${project.pendingOperation.jobId ?? project.pendingOperation.id ?? ''}` : ''}`
            : '';
        // 后台正在跟的卡和酒馆当前打开的卡对不上时直接说出来
        const followGap = card?.avatar && state && (state.activeCardFile ?? '').toLowerCase() !== card.avatar.toLowerCase()
            ? ` · 后台还在跟「${state.activeCardFile ?? '没有卡'}」，点「刷新」`
            : '';
        const cardMatched = card && (state?.projects ?? []).find(p => p.cardFile && p.cardFile.toLowerCase() === card.avatar?.toLowerCase());
        const detail = cardMatched
            ? `工程「${cardMatched.id}」 · ${statusLabels[cardMatched.status] ?? cardMatched.status ?? '状态未知'}${errOf(cardMatched)}`
            : '还没有本地工程（第一次用点「拆解当前卡」）';
        find('current-card').textContent = card
            ? `当前卡：${card.name} · ${detail}${followGap}`
            : '先在酒馆打开一张角色卡（群聊不支持）。';
        // 当前卡这一行只有两个按钮：没拆过才显示拆解和拆前清单；「连接」作用于「工作区」里选中的工程
        const unmatched = !!card && !cardMatched;
        action('attach').hidden = !unmatched;
        find('card-extras').hidden = !unmatched;
        action('connect').hidden = action('connect').disabled && !busy;
        // Preview-specific controls also need a live service, not just a loaded extension.
        for (const node of root.querySelectorAll('[data-service-action]')) node.disabled = busy || !state;
    }
    function syncSelectionToCurrentCard() {
        const select = find('projects');
        const card = currentCard();
        const avatar = card?.avatar ?? null;
        if (!avatar) return;
        // ② 的下拉只跟工作区目录走：当前卡刚好在里面就选中它，不在就保持原来的选择，不清空
        const pool = state?.assembleProjects ?? state?.projects ?? [];
        const matched = pool.find(p => p.cardFile && p.cardFile.toLowerCase() === avatar.toLowerCase())
            // 当前卡没有工程、只有一个工程原来的卡已不在：预选它，好直接「新建卡」
            ?? (() => { const o = pool.filter(p => p.status === 'cardMissing'); return o.length === 1 ? o[0] : null; })();
        if (matched && select.value !== matched.id) {
            select.value = matched.id;
            clearPreviews();
        }
        if (!select.value && pool.length === 1) select.value = pool[0].id;
    }
    function renderState() {
        find('cards-root').textContent = state?.cardsRoot ?? '尚未连接';
        if (state?.cardsRoot && !find('cards-root-input').value) find('cards-root-input').value = state.cardsRoot;
        const pool = state?.assembleProjects ?? state?.projects ?? [];
        const signature = JSON.stringify(pool.map(p => [p.id, p.name, p.cardFile, p.attached]));
        if (signature !== projectSignature) {
            projectSignature = signature;
            const select = find('projects'), previous = select.value;
            const current = currentCard()?.avatar;
            select.replaceChildren();
            if (!pool.length) {
                const opt = element('option', '（所选装配文件夹内暂无卡工程）');
                opt.value = '';
                select.append(opt);
            } else {
                for (const project of pool) {
                    const option = element('option', `${project.name ?? project.cardFile ?? project.id}${project.attached ? '' : '（还没连到酒馆）'}`);
                    option.value = project.id;
                    select.append(option);
                }
            }
            const chosen = pool.find(p => p.cardFile && current && p.cardFile.toLowerCase() === current.toLowerCase())
                ?? pool.find(p => p.id === previous)
                ?? (pool.length === 1 ? pool[0] : null);
            if (chosen) select.value = chosen.id;
            if (select.value !== previous) clearPreviews();
        }
        // 独立世界书：只放世界书编辑器里当前打开的那一本
        const activeWorld = state?.activeWorld ?? null;
        const nextWorldSig = JSON.stringify(activeWorld);
        if (nextWorldSig !== worldSignature) {
            worldSignature = nextWorldSig;
            const wSelect = find('worlds');
            wSelect.replaceChildren();
            if (!activeWorld) {
                const opt = element('option', '（世界书编辑器里没有打开世界书）'); opt.value = ''; wSelect.append(opt);
            } else if (!activeWorld.exists) {
                const opt = element('option', `（找不到世界书文件：${activeWorld.worldName}）`); opt.value = ''; wSelect.append(opt);
            } else {
                const opt = element('option', `${activeWorld.worldName}${activeWorld.attached ? `（已拆到工作区「${activeWorld.projectId ?? activeWorld.worldName}」）` : ''}`);
                opt.value = activeWorld.worldName; wSelect.append(opt);
                wSelect.value = activeWorld.worldName;
            }
        }
        if (lastFollowedCard !== undefined) syncSelectionToCurrentCard();
        if (!find('logs').hidden) {
            find('logs').textContent = (state?.logs ?? []).slice(-50).map(formatLogLine).join('\n') || '（暂无日志）';
        }
        renderControls();
        if (state) { scanCurrentCard(); showReconnectIfAny(); }
    }
    // 告诉后台酒馆当前打开的是哪张卡、哪本世界书。
    // 后台确认收到后才记下；失败时清掉记录，下一秒的定时检查会重试。force：手动刷新等场合不管是否变化都重新告诉一次
    let following = false;
    async function checkCardFollow({ force = false } = {}) {
        if (!state || following || (!force && (busy || refreshing))) return;
        const avatar = currentCard()?.avatar ?? null;
        const worldName = currentWorldName();
        if (!force && avatar === lastFollowedCard && worldName === lastFollowedWorld) return;
        following = true;
        try {
            state = await client.control('followCard', { cardFile: avatar, worldName });
            lastFollowedCard = avatar;
            lastFollowedWorld = worldName;
            showError('');
            syncSelectionToCurrentCard();
            renderState();
        } catch (error) {
            lastFollowedCard = undefined;
            lastFollowedWorld = undefined;
            showError(error);
        } finally {
            following = false;
        }
    }
    async function refresh({ force = true } = {}) {
        if (refreshing || (!force && (busy || Date.now() - lastPolled < 4000))) return;
        refreshing = true;
        lastPolled = Date.now();
        try {
            connection = await client.connectionInfo();
            find('connection').textContent = connection.base;
            state = await client.status();
            if (conflictShownFor.startsWith('setup|')) { find('diff').replaceChildren(); conflictShownFor = ''; }
            find('status').textContent = `已连接 · ${state.paused ? '自动同步已暂停' : '实时同步中'}${state.currentTask ? ' · 正在处理' : ''}`;
            if (!actionFailed && (lastError.startsWith('本机后台未连接') || lastError.startsWith('缺少有效的本机连接配置') || lastError.startsWith('首次通过酒馆'))) showError('');
        } catch (error) {
            state = null;
            if (error?.code === 'SETUP_CONFIRM_REQUIRED' || error?.code === 'FOLDER_PERMISSION_REQUIRED') {
                find('status').textContent = setupDismissed
                    ? '尚未启用（点「启动同步」选择工作区文件夹）'
                    : (error.code === 'FOLDER_PERMISSION_REQUIRED' ? '等待确认恢复工作区文件夹读写权限…' : '首次使用：请在下方确认是否启用本地工作区同步');
            } else {
                find('status').textContent = '后台未连接，点「启动同步」';
            }
            if (!actionFailed) showError(error);
        } finally { refreshing = false; renderState(); }
    }
    async function run(fn) {
        if (busy) return;
        busy = true;
        actionFailed = false;
        showError('');
        renderControls();
        try { await fn(); }
        catch (error) { actionFailed = true; showError(error); }
        finally { busy = false; await refresh(); renderControls(); }
    }
    const serviceButton = (label, fn) => {
        const node = button(label, () => run(fn));
        node.dataset.serviceAction = '';
        return node;
    };
    async function attachWithConflictPrompt(actionName, payload, label) {
        try {
            await client.control(actionName, payload);
        } catch (error) {
            if (error?.code !== 'ATTACH_CONFLICT' || !String(error.message).includes('同名工程目录')) throw error;
            const d = error.details ?? {};
            const kept = (d.keepGroups ?? []).map(g => g.path.endsWith('/') ? `${g.path}（${g.files} 个文件）` : g.path).join('、');
            const plan = `\n\n会按酒馆当前内容重新生成：卡内容文件 ${d.replaceCount ?? '?'} 个（card.md、字段、message\\、world_book\\、regex\\、scripts\\）。\n原样保留：${kept || '没有其他文件'}。\n条目文件名按酒馆里的条目标题重新生成，可能和你原来的文件名不同。`;
            if (!confirmAction(`本地已存在同名工程目录（${label}）。${plan}\n\n被重新生成的卡内容文件不会备份。是否覆盖？`)) throw error;
            await client.control(actionName, { ...payload, overwrite: true });
        }
    }
    const actions = {
        // 手动刷新：读状态，并把酒馆当前打开的卡重新告诉后台，漏掉的切卡在这里补上
        refresh: async () => { await refresh(); await checkCardFollow({ force: true }); },
        toggle: async () => {
            setupDismissed = false;
            if (state?.paused === false) return client.control('pause');
            find('status').textContent = connection?.mode === 'browser' ? '正在打开文件夹选择并开启同步…' : '正在启动并连接同步后台…';
            const res = await client.startSync();
            await checkCardFollow({ force: true });
            return res;
        },
        connect: async () => {
            const p = assembleTarget() || (state?.projects?.length === 1 ? state.projects[0] : null);
            if (!p) throw new Error('先在「工作区」里选中要连接的卡工程。');
            const ask = p.cardFile
                ? `把卡工程「${p.id}」连到酒馆里的「${p.cardFile}」？\n两边一致就直接连上；不一致会让你选「以本地为准覆盖」或「新建卡」。`
                : `卡工程「${p.id}」还没进过酒馆。按本地工程新建一张卡和一本世界书（重名会起新名字），之后实时同步。继续？`;
            if (!confirmAction(ask)) return;
            if (state?.paused !== false) state = await client.control('resume');
            const res = await client.control('connect', { projectId: p.id });
            if (res.status === 'needsReconnect') { conflictShownFor = ''; return; }
            const cardFile = res.cardFile ?? res.project?.cardFile;
            await openCard(cardFile);
            done(`已把「${p.id}」连到「${cardFile}」，之后实时同步。`);
        },
        attach: async () => {
            const card = currentCard();
            if (!card) throw new Error('先在酒馆选择一张角色卡。');
            const keep = keptExtras();
            await attachWithConflictPrompt('attach', { cardFile: card.avatar, keep }, card.name);
            if (state?.paused !== false) state = await client.control('resume');
            await checkCardFollow({ force: true });
            find('diff').replaceChildren(element('p', `已把「${card.name}」拆到工作区「${card.avatar.replace(/\.png$/i, '')}」${keep.length ? `（${keep.length} 项留在 card.md）` : ''}，已开启实时双向同步。`));
        },
        'attach-world': async () => {
            const worldName = find('worlds').value;
            if (!worldName) throw new Error('先在酒馆的世界书编辑器里打开要拆的那本世界书。');
            if (worldName !== currentWorldName()) throw new Error('世界书编辑器里打开的世界书已经换了，请稍等面板刷新后再点。');
            await attachWithConflictPrompt('attachWorld', { worldName }, worldName);
            if (state?.paused !== false) state = await client.control('resume');
            find('diff').replaceChildren(element('p', `已把世界书「${worldName}」拆到工作区「${worldName}」，已开启实时双向同步。`));
        },
        'set-cards-root': async () => {
            if (connection?.mode === 'browser') {
                setupDismissed = false;
                const res = await client.authorizeWorkspace({ pickNew: true });
                find('cards-root-input').value = res.cardsRoot;
                clearPreviews();
                await checkCardFollow({ force: true });
                find('diff').replaceChildren(element('p', `已切换本地工作区文件夹至：${res.cardsRoot}`));
                return;
            }
            const cardsRoot = find('cards-root-input').value.trim();
            if (!cardsRoot) throw new Error('请填写要切换的工作区目录路径。');
            const res = await client.control('setCardsRoot', { cardsRoot });
            find('cards-root-input').value = res.cardsRoot;
            clearPreviews();
            find('diff').replaceChildren(element('p', `已切换工作区目录至：${res.cardsRoot}`));
        },
        'skills-status': async () => {
            const res = await client.control('skillsStatus');
            const out = find('skills-output');
            out.textContent = res.summary ?? JSON.stringify(res, null, 2);
            out.hidden = false;
        },
        'skills-deploy': async () => {
            // 先只读识别技能库与缺失项，再询问用户是否安装，不擅自执行
            const status = await client.control('skillsStatus');
            const out = find('skills-output');
            out.textContent = status.summary ?? JSON.stringify(status, null, 2);
            out.hidden = false;
            if (status.available === false) return;
            const pending = status.missingNames ?? [];
            const prompt = pending.length
                ? `检测到 ${pending.length} 项技能缺失或有更新：\n${pending.join('、')}\n\n是否确认安装/同步到 TauriTavern 与本地环境？`
                : '当前所有技能均已安装且为最新。是否仍要重新同步一次？';
            if (!confirmAction(prompt)) return;
            const res = await client.control('skillsDeploy');
            out.textContent = res.summary ?? JSON.stringify(res, null, 2);
            out.hidden = false;
        },
    };
    for (const [name, fn] of Object.entries(actions)) action(name)?.addEventListener('click', () => run(fn));
    // Local view actions do not call the service or immediately overwrite the status line via refresh().
    action('logs-toggle').addEventListener('click', () => {
        const logsEl = find('logs');
        logsEl.hidden = !logsEl.hidden;
        if (!logsEl.hidden) {
            logsEl.textContent = (state?.logs ?? []).slice(-50).map(formatLogLine).join('\n') || '（暂无日志）';
        }
    });
    action('diagnostics').addEventListener('click', async () => {
        const compactService = state ? {
            ...state,
            logs: (state.logs ?? []).slice(-30).map(formatLogLine),
        } : null;
        const textValue = JSON.stringify({ extension: 'tt-card-bridge', connection, service: compactService, lastError }, null, 2);
        root.dataset.lastDiagnostic = textValue;
        const area = element('textarea');
        area.value = textValue;
        root.append(area);
        area.select();
        const copiedSync = Boolean(document.execCommand?.('copy'));
        area.remove();
        let copiedAsync = false;
        try { await navigator.clipboard.writeText(textValue); copiedAsync = true; } catch {}
        showError('');
        find('status').textContent = (copiedSync || copiedAsync) ? '诊断信息已复制。' : '已生成诊断信息。';
    });
    find('projects').addEventListener('change', () => { clearPreviews(); renderControls(); });
    find('worlds').addEventListener('change', renderControls);
    renderControls();
    return { refresh, checkCardFollow, showError, root, dispose: () => root.remove() };
}
