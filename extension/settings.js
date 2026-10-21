// Settings UI is a consumer of the same service as the CLI, never a second sync engine.
const text = value => value === undefined || value === null ? '' : String(value);
const errorText = error => error?.message ?? String(error);
const statusLabels = {
    clean: '两侧一致', unchecked: '尚未检查', differences: '存在差异', error: '处理失败',
    paused: '已暂停', unattached: '未接入', pending: '仍有未同步内容',
    operationPending: '写入结果待确认', reviewRequired: '需要人工复核',
    restoreRequired: '恢复未完成', bindingConflict: '存在重复绑定', waitingForStableFiles: '等待文件稳定',
};
const differenceLabels = { project: '工程有修改', tavern: '酒馆有修改', conflict: '双方修改冲突', added: '酒馆新增或工程缺少', removed: '工程新增或酒馆缺少' };
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
function labeled(label, control) {
    const node = element('label', undefined, 'ttcb-field');
    node.append(element('small', label), control);
    return node;
}
function readOnlyText(value) {
    const area = element('textarea');
    area.readOnly = true;
    area.rows = 5;
    area.value = value === null ? '（不存在）' : text(value);
    return area;
}
function formatLogLine(item) {
    if (typeof item === 'string') return item.length > 260 ? `${item.slice(0, 260)}…` : item;
    if (!item || typeof item !== 'object') return text(item);
    const time = typeof item.at === 'string' ? item.at.slice(11, 19) : '';
    const head = [time ? `[${time}]` : '', item.action ?? 'event', item.projectId ?? ''].filter(Boolean).join(' · ');
    const body = item.error?.message
        ? `失败(${item.error.code ?? 'ERROR'}): ${item.error.message}`
        : item.status
            ? `${statusLabels[item.status] ?? item.status}${item.changed ? '（已同步）' : ''}${item.backupId ? ` [备份 ${item.backupId}]` : ''}`
            : item.cardFile
                ? item.cardFile
                : '';
    const rep = item.repeat > 1 ? ` (×${item.repeat})` : '';
    const line = `${head}${body ? ` — ${body}` : ''}${rep}`;
    return line.length > 260 ? `${line.slice(0, 260)}…` : line;
}

export function mountSettings({ client, getContext }) {
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
          <small data-role="status" role="status">扩展已加载，正在读取后台状态。</small>
          <div data-role="error" role="alert" class="ttcb-warning" hidden></div>
          <div class="flex-container">
            ${icon('toggle', 'fa-power-off', '启动同步', '启动本机后台并启用自动同步；暂停只停止自动处理，不中断正在执行的写入')}
            ${icon('refresh', 'fa-arrows-rotate', '刷新', '重新读取后台状态')}
          </div>
          <small>连接：<code data-role="connection">读取中</code> · 工作区目录：<code data-role="cards-root">尚未连接</code></small>
          <div class="flex-container">
            <input data-role="cards-root-input" type="text" class="flex1" placeholder="工作区目录，例如：D:\cards" aria-label="工作区目录" autocomplete="off">
            ${icon('set-cards-root', 'fa-folder-open', '切换工作区目录', '拆卡、同步、合成和 Agent 读写都在这个目录里')}
          </div>
          <div class="ttcb-backup-policy">
            <label class="checkbox_label"><input data-role="backup-before-overwrite" type="checkbox" checked><small>每次覆盖写入前自动备份（常驻开关；关闭后直接覆盖需自担数据丢失责任）</small></label>
            <div class="flex-container">
              <input data-role="backup-dir" type="text" class="flex1" placeholder="自定义备份位置（留空默认保存在 cards\backups\&lt;卡名&gt;\ 下）" aria-label="自定义备份位置" autocomplete="off">
              ${icon('set-backup-dir', 'fa-floppy-disk', '保存备份位置', '保存默认自定义备份文件夹路径')}
            </div>
          </div>
          <hr>
          <b>① 拆解当前卡</b>
          <small data-role="current-card"></small>
          <small>把酒馆当前打开的角色卡拆到工作区目录（<code>cards\&lt;卡名&gt;\</code>），卡绑定的世界书一起放进卡文件夹。只处理当前打开的这一张。</small>
          <div data-role="frameworks"></div>
          <div data-role="extras"></div>
          <div class="flex-container">
            ${icon('attach', 'fa-boxes-packing', '拆解当前卡', '把当前卡拆到工作区目录（同名文件夹已存在时会先问是否覆盖）')}
          </div>
          <small>独立世界书（只认世界书编辑器里当前打开的那一本）：</small>
          <div class="flex-container">
            <select data-role="worlds" class="flex1" aria-label="世界书编辑器里当前打开的世界书"></select>
            ${icon('attach-world', 'fa-book', '拆解独立世界书', '把所选世界书拆到工作区目录下')}
          </div>
          <hr>
          <b>② 合成并导入酒馆</b>
          <small>把工作区目录里的卡工程合成后写进酒馆。</small>
          <select data-role="projects" aria-label="工作区目录里的卡工程"></select>
          <small data-role="project-status"></small>
          <div class="flex-container">
            ${icon('import-workspace', 'fa-file-import', '合成并导入酒馆', '把工作区里的卡合成后写进酒馆（新卡会新建）')}
            ${icon('backups', 'fa-clock-rotate-left', '备份', '查看这张卡的备份')}
          </div>
          <div data-role="diff"></div>
          <div data-role="backups"></div>
          <div data-role="restore"></div>
          <hr>
          <b>技能与 Agent 同步</b>
          <small>将原件 skills/cf-* 与 Agent 配置同步到 LimCode TEST、Claude Code、~/.agents/skills 和酒馆（覆盖前按上方备份设置执行）。</small>
          <div class="flex-container">
            ${icon('skills-status', 'fa-magnifying-glass', '检查技能与Agent', '对照原件、版本存档、LimCode TEST、Claude Code、~/.agents/skills 与酒馆技能/Agent 状态')}
            ${icon('skills-deploy', 'fa-wand-magic-sparkles', '同步技能与Agent', '存档当前版本并手动同步技能与 Agent 配置到 LimCode TEST、Claude Code、~/.agents/skills 和酒馆')}
          </div>
          <pre data-role="skills-output" class="ttcb-logs" hidden></pre>
          <hr>
          <div class="flex-container alignitemscenter">
            <small class="flex1">诊断含本机路径和卡名，不含令牌。</small>
            ${icon('logs-toggle', 'fa-list', '日志', '显示或隐藏后台日志')}
            ${icon('diagnostics', 'fa-copy', '复制诊断', '复制诊断信息')}
          </div>
          <pre data-role="logs" class="ttcb-logs" hidden></pre>
        </div></div>
      </div>`;
    for (const node of root.querySelectorAll('button')) node.classList.add('menu_button');
    for (const node of root.querySelectorAll('input[type="text"], select, textarea')) node.classList.add('text_pole');
    container.append(root);
    const find = role => root.querySelector(`[data-role="${role}"]`);
    const action = name => root.querySelector(`[data-action="${name}"]`);
    let connection = null, state = null, busy = false, refreshing = false, projectSignature = '', worldSignature = '';
    let lastError = '', lastPolled = 0, actionFailed = false, lastFollowedCard = undefined, lastFollowedWorld = undefined, scannedCard = null, conflictShownFor = '';
    const selectedProject = () => state?.assembleProjects?.find(project => project.id === find('projects').value) ?? state?.projects?.find(project => project.id === find('projects').value);
    // ② 用：下拉没选中时，工作区目录里只有一张卡就用那张
    const assembleTarget = () => selectedProject() || (state?.assembleProjects?.length === 1 ? state.assembleProjects[0] : null);
    // 优先用酒馆自己的弹窗；没有时退回 window.confirm
    async function askConfirm(message, okText = '确定', cancelText = '取消') {
        const ctx = getContext();
        if (typeof ctx?.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
            const pre = document.createElement('div');
            pre.style.whiteSpace = 'pre-wrap';
            pre.style.textAlign = 'left';
            pre.textContent = message;
            const result = await ctx.callGenericPopup(pre, ctx.POPUP_TYPE.CONFIRM, '', { okButton: okText, cancelButton: cancelText });
            return result === true || result === 1 || result === ctx.POPUP_RESULT?.AFFIRMATIVE;
        }
        return typeof window.confirm === 'function' ? window.confirm(message) : false;
    }
    // ② 的进度与报错就写在 ② 下面，不只写在面板顶部
    const importNote = (text, warn = false) => find('diff').replaceChildren(element('p', text, warn ? 'ttcb-warning' : undefined));
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
    function showError(error) {
        if (actionFailed && error?.code === 'CONNECTION_FAILED') return;
        lastError = errorText(error);
        find('error').textContent = lastError;
        find('error').hidden = !lastError;
    }
    function clearPreviews() {
        for (const role of ['diff', 'backups', 'restore']) find(role).replaceChildren();
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
    // 自动同步遇到两边都改过的内容时，列出正文冲突让作者选；结构/槽位差异只列简短摘要，不塞满屏文本框
    async function showConflictIfAny() {
        const p = selectedProject();
        const err = p?.lastResult?.error;
        const code = err?.code;
        if (!p || !['CONFLICT', 'TAVERN_CHANGED', 'UNSUPPORTED_DIFFERENCE'].includes(code)) return;
        const sig = `${p.id}|${code}|${err.message}`;
        if (conflictShownFor === sig || busy) return;
        conflictShownFor = sig;
        if (code === 'UNSUPPORTED_DIFFERENCE') {
            const box = find('diff');
            box.replaceChildren();
            const issues = err?.details?.issues ?? [];
            const shown = issues.slice(0, 8);
            for (const issue of shown) box.append(element('p', issue.message, 'ttcb-warning'));
            if (issues.length > shown.length) {
                box.append(element('small', `另有 ${issues.length - shown.length} 项结构或槽位差异未展开（如需用酒馆当前卡覆盖工程，可点上方「拆解当前卡」；如需用工程覆盖酒馆，可点「合成并导入酒馆」）。`));
            }
            return;
        }
        try { showDiff(await client.control('diff', { projectId: p.id }), p.id); } catch (error) { showError(error); }
    }
    function renderControls() {
        for (const control of root.querySelectorAll('button')) control.disabled = busy && control.dataset.action !== 'logs-toggle';
        action('toggle').disabled = busy;
        setLabel(action('toggle'), state?.paused === false ? '暂停同步' : '启动同步');
        action('set-cards-root').disabled = busy || !state;
        action('set-backup-dir').disabled = busy || !state;
        action('skills-status').disabled = busy || !state;
        action('skills-deploy').disabled = busy || !state;
        action('attach').disabled = busy || !state || !currentCard();
        action('attach-world').disabled = busy || !state || !find('worlds').value;
        const project = assembleTarget() || (state?.projects?.length === 1 ? state.projects[0] : null);
        action('import-workspace').disabled = busy || !state || !project;
        action('backups').disabled = busy || !project?.attached;
        const card = currentCard();
        if (project) {
            const errMsg = project.status === 'error' && project.lastResult?.error?.message ? `（${project.lastResult.error.message}）` : '';
            find('project-status').textContent = `${project.name ?? project.cardFile ?? project.id} · ${project.attached ? '已连接酒馆' : '还没进酒馆（点「合成并导入酒馆」）'} · ${statusLabels[project.status] ?? project.status ?? '状态未知'}${errMsg}${project.pendingOperation ? `；未决任务：${project.pendingOperation.jobId ?? project.pendingOperation.id ?? ''}` : ''}`;
        } else if (card) {
            find('project-status').textContent = `当前卡「${card.name}」还没拆到工作区（点上方「拆解当前卡」）`;
        } else {
            find('project-status').textContent = '未选择卡';
        }
        const cardMatched = card && (state?.projects ?? []).find(p => p.cardFile && p.cardFile.toLowerCase() === card.avatar?.toLowerCase());
        find('current-card').textContent = card
            ? `酒馆当前卡：${card.name}（${card.avatar}） · ${cardMatched ? `已拆到 cards\\${cardMatched.id}` : '还没拆到工作区'}`
            : '先在酒馆选择一张角色卡；群聊中不能拆解当前卡。';
        // Preview-specific controls also need a live service, not just a loaded extension.
        for (const node of root.querySelectorAll('[data-service-action]')) node.disabled = busy || !state;
    }
    function overwriteBackupOptions(operationLabel = '本次覆盖操作') {
        const skipBackup = !find('backup-before-overwrite').checked;
        const backupDir = find('backup-dir').value.trim();
        if (skipBackup) {
            const ok = confirmAction(`当前已关闭「覆盖写入前自动备份」。\n\n执行「${operationLabel}」将直接覆盖目标数据，一旦出错无法找回，数据丢失责任由本人自行承担。\n\n是否确认不备份直接覆盖？`);
            if (!ok) throw new Error('已取消直接覆盖操作（可重新勾选「每次覆盖写入前自动备份」后再执行）。');
        }
        return { skipBackup, acceptDataLossRisk: skipBackup, ...(backupDir ? { backupDir } : {}) };
    }
    function syncSelectionToCurrentCard() {
        const select = find('projects');
        const card = currentCard();
        const avatar = card?.avatar ?? null;
        if (!avatar) return;
        // ② 的下拉只跟工作区目录走：当前卡刚好在里面就选中它，不在就保持原来的选择，不清空
        const pool = state?.assembleProjects ?? state?.projects ?? [];
        const matched = pool.find(p => p.cardFile && p.cardFile.toLowerCase() === avatar.toLowerCase());
        if (matched && select.value !== matched.id) {
            select.value = matched.id;
            clearPreviews();
        }
        if (!select.value && pool.length === 1) select.value = pool[0].id;
    }
    function renderState() {
        find('cards-root').textContent = state?.cardsRoot ?? '尚未连接';
        if (state?.cardsRoot && !find('cards-root-input').value) find('cards-root-input').value = state.cardsRoot;
        if (state?.backupDir && !find('backup-dir').value) find('backup-dir').value = state.backupDir;
        if (state && typeof state.autoBackupBeforeOverwrite === 'boolean') {
            find('backup-before-overwrite').checked = state.autoBackupBeforeOverwrite;
        }
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
                    const option = element('option', `${project.name ?? project.cardFile ?? project.id}${project.attached ? '' : '（未接入）'}`);
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
                const opt = element('option', `${activeWorld.worldName}${activeWorld.attached ? `（已拆到 cards\\${activeWorld.projectId ?? activeWorld.worldName}）` : ''}`);
                opt.value = activeWorld.worldName; wSelect.append(opt);
                wSelect.value = activeWorld.worldName;
            }
        }
        if (lastFollowedCard !== undefined) syncSelectionToCurrentCard();
        if (!find('logs').hidden) {
            find('logs').textContent = (state?.logs ?? []).slice(-50).map(formatLogLine).join('\n') || '（暂无日志）';
        }
        renderControls();
        if (state) { scanCurrentCard(); showConflictIfAny(); }
    }
    async function checkCardFollow() {
        if (!state || busy || refreshing) return;
        const avatar = currentCard()?.avatar ?? null;
        const worldName = currentWorldName();
        if (avatar === lastFollowedCard && worldName === lastFollowedWorld) return;
        lastFollowedCard = avatar;
        lastFollowedWorld = worldName;
        try {
            state = await client.control('followCard', { cardFile: avatar, worldName });
            showError('');
            syncSelectionToCurrentCard();
            renderState();
        } catch (error) {
            showError(error);
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
            find('status').textContent = `本机后台已连接；${state.paused ? '自动同步已暂停' : '自动同步已启用'}${state.currentTask ? '；正在处理任务' : ''}。`;
            if (!actionFailed && (lastError.startsWith('本机后台未连接') || lastError.startsWith('缺少有效的本机连接配置'))) showError('');
        } catch (error) {
            state = null;
            find('status').textContent = '扩展已加载；后台尚未连接。点击「启动同步」即可启动并连接。';
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
    function requireProject() {
        const project = selectedProject();
        if (!project) throw new Error('请先选择已接入的工程。');
        return project;
    }
    function showDiff(diff, projectId) {
        const box = find('diff');
        box.replaceChildren();
        box.append(element('p', diff.clean ? '工程与酒馆一致。' : '预览已生成；提交前后台会再次检查两侧是否变化。'));
        for (const issue of diff.issues ?? []) box.append(element('p', issue.message, 'ttcb-warning'));
        const choices = [];
        for (const slot of diff.slots ?? []) {
            if (slot.kind === 'equal') continue;
            const row = element('div', undefined, 'ttcb-slot');
            row.append(element('b', `${slot.label ?? slot.key} · ${differenceLabels[slot.kind] ?? slot.kind}`));
            const sides = element('div', undefined, 'ttcb-sides');
            sides.append(labeled('工程', readOnlyText(slot.node)), labeled('酒馆', readOnlyText(slot.tavern)));
            row.append(sides);
            if (slot.canResolve) {
                const select = element('select');
                for (const [value, label] of [['', '请选择保留内容'], ['project', '使用工程正文'], ['tavern', '使用酒馆正文'], ['manual', '手动填写正文']]) {
                    const option = element('option', label); option.value = value; select.append(option);
                }
                const manual = element('textarea'); manual.rows = 6; manual.hidden = true;
                select.addEventListener('change', () => { manual.hidden = select.value !== 'manual'; });
                row.append(labeled('处理方式', select), manual);
                choices.push({ key: slot.key, select, manual });
            } else row.append(element('p', '此项涉及设置或结构，不能在正文选边中处理。', 'ttcb-warning'));
            box.append(row);
        }
        if (choices.length) box.append(serviceButton('应用所选正文', async () => {
            if (choices.some(c => !c.select.value)) throw new Error('请为每个可处理项目选择保留内容。');
            const backupOpts = overwriteBackupOptions('冲突选边覆盖');
            await client.control('resolve', {
                projectId, previewId: diff.previewId,
                choices: choices.map(c => ({ key: c.key, source: c.select.value, ...(c.select.value === 'manual' ? { text: c.manual.value } : {}) })),
                ...backupOpts,
            });
            box.replaceChildren(element('p', '已应用所选正文。再次查看差异可检查当前结果。'));
        }));
    }
    async function showBackups(projectId) {
        const result = await client.control('backups', { projectId });
        const box = find('backups'); box.replaceChildren(); find('restore').replaceChildren();
        if (!result.backups?.length) { box.append(element('p', '没有备份。')); return; }
        for (const backup of result.backups) {
            const row = element('div', undefined, 'ttcb-backup');
            row.append(element('span', `${backup.createdAt ?? backup.id} ${backup.reason ?? ''}`));
            if (backup.supported) row.append(serviceButton('预览恢复', async () => {
                const preview = await client.control('restorePreview', { projectId, backupId: backup.id });
                const target = find('restore'); target.replaceChildren();
                target.append(element('p', '这是导入覆盖恢复的预览。执行前按上方备份设置执行，恢复后此卡保持暂停。'));
                target.append(element('p', preview.notice ?? '导入会重编码PNG，并可能改写创建日期、聊天关联和收藏；不是原字节精确恢复。', 'ttcb-warning'));
                target.append(element('pre', JSON.stringify(preview, null, 2)));
                if (!preview.canRestore) {
                    target.append(element('p', preview.blockedReason ?? '此备份不能自动导入恢复；请查看原因。', 'ttcb-warning'));
                    return;
                }
                target.append(serviceButton('确认覆盖恢复', async () => {
                    if (!confirmAction(`确定要用备份「${backup.id}」覆盖恢复当前角色卡与工程吗？`)) return;
                    const backupOpts = overwriteBackupOptions('恢复历史备份');
                    await client.control('restore', { projectId, previewId: preview.previewId, confirm: true, ...backupOpts });
                    clearPreviews();
                    find('restore').append(element('p', '恢复已完成；此卡仍暂停。先检查差异，再决定是否恢复自动同步。'));
                }));
            }));
            else row.append(element('span', '旧备份或不完整备份：不支持自动恢复。', 'ttcb-warning'));
            box.append(row);
        }
    }
    async function runManualSync(direction) {
        const label = direction === 'push' ? '手动推送到酒馆' : direction === 'pull' ? '手动从酒馆拉取' : '立即双向同步';
        const backupOpts = overwriteBackupOptions(label);
        const result = await client.control('sync', { projectId: requireProject().id, direction, ...backupOpts });
        const failures = result.results?.filter(r => r.error || r.status === 'conflict' || r.status === 'blocked') ?? [];
        if (failures.length) throw new Error(failures.map(r => typeof r.error === 'object' ? r.error.message : r.error ?? r.status).join('\n'));
        clearPreviews();
    }
    async function attachWithConflictPrompt(actionName, payload, label) {
        try {
            await client.control(actionName, payload);
        } catch (error) {
            if (error?.code !== 'ATTACH_CONFLICT' || !String(error.message).includes('同名工程目录')) throw error;
            const autoBackup = find('backup-before-overwrite').checked;
            const ok = confirmAction(
                autoBackup
                    ? `本地已存在同名工程目录（${label}）。\n\n是否先将旧目录自动备份，再用酒馆当前内容覆盖接入？`
                    : `本地已存在同名工程目录（${label}），且当前已关闭自动备份。\n\n继续操作将直接删除并覆盖本地同名工程目录，一旦出错无法找回，数据丢失责任由本人自行承担。\n\n是否确认直接覆盖接入？`,
            );
            if (!ok) throw error;
            const backupDir = find('backup-dir').value.trim();
            await client.control(actionName, {
                ...payload,
                overwrite: true,
                skipBackup: !autoBackup,
                acceptDataLossRisk: !autoBackup,
                ...(backupDir ? { backupDir } : {}),
            });
        }
    }
    const actions = {
        refresh: () => refresh(),
        toggle: async () => {
            if (state?.paused === false) return client.control('pause');
            find('status').textContent = '正在启动并连接同步后台…';
            return client.startSync();
        },
        diff: async () => { const p = requireProject(); showDiff(await client.control('diff', { projectId: p.id }), p.id); },
        attach: async () => {
            const card = currentCard();
            if (!card) throw new Error('先在酒馆选择一张角色卡。');
            const keep = keptExtras();
            await attachWithConflictPrompt('attach', { cardFile: card.avatar, keep }, card.name);
            lastFollowedCard = undefined;
            await checkCardFollow();
            find('diff').replaceChildren(element('p', `已把「${card.name}」拆到 cards\\${card.avatar.replace(/\.png$/i, '')}${keep.length ? `（${keep.length} 项留在 card.md）` : ''}。`));
        },
        'attach-world': async () => {
            const worldName = find('worlds').value;
            if (!worldName) throw new Error('先在酒馆的世界书编辑器里打开要拆的那本世界书。');
            if (worldName !== currentWorldName()) throw new Error('世界书编辑器里打开的世界书已经换了，请稍等面板刷新后再点。');
            await attachWithConflictPrompt('attachWorld', { worldName }, worldName);
            find('diff').replaceChildren(element('p', `已把世界书「${worldName}」拆到 cards\\${worldName}`));
        },
        'import-workspace': async () => {
            const p = assembleTarget();
            if (!p) { importNote('工作区目录里没有可导入的卡工程，或下拉框没有选中。', true); return; }
            importNote(`正在合成「${p.id}」并导入酒馆…`);
            const send = extra => client.control('importFromWorkspace', { projectId: p.id, ...extra });
            let res;
            try {
                try {
                    res = await send({});
                } catch (error) {
                    if (error?.code !== 'ATTACH_CONFLICT') throw error;
                    const copy = await askConfirm(
                        `${error.message}\n\n「新建一张」：像酒馆导入重名卡一样自动加编号，原有的卡和世界书都不动。\n「不新建」：接着问是否覆盖。`,
                        '新建一张', '不新建',
                    );
                    if (copy) {
                        importNote('正在新建卡并写入内容…');
                        res = await send({ createNewCopy: true });
                    } else {
                        const over = await askConfirm(`是否用「${p.id}」的内容覆盖酒馆里的同名卡和世界书？\n（会按上方备份设置先备份）`, '覆盖', '取消');
                        if (!over) { importNote('已取消，没有导入。'); return; }
                        const backupOpts = overwriteBackupOptions(`用「${p.id}」覆盖酒馆同名卡`);
                        importNote('正在覆盖导入…');
                        res = await send({ overwrite: true, ...backupOpts });
                    }
                }
            } catch (error) {
                importNote(`导入失败：${errorText(error)}`, true);
                throw error;
            }
            const made = res?.project?.cardFile ? `（酒馆里的卡文件：${res.project.cardFile}）` : '';
            importNote(`已把「${p.id}」合成并导入酒馆${made}。`);
        },
        'set-cards-root': async () => {
            const cardsRoot = find('cards-root-input').value.trim();
            if (!cardsRoot) throw new Error('请填写要切换的工作区目录路径。');
            const res = await client.control('setCardsRoot', { cardsRoot });
            find('cards-root-input').value = res.cardsRoot;
            clearPreviews();
            find('diff').replaceChildren(element('p', `已切换工作区目录至：${res.cardsRoot}`));
        },
        'set-backup-dir': async () => {
            const backupDir = find('backup-dir').value.trim();
            const res = await client.control('setBackupDir', { backupDir });
            find('backup-dir').value = res.backupDir;
            find('diff').replaceChildren(element('p', res.backupDir ? `已保存自定义备份位置：${res.backupDir}` : '已恢复默认备份位置（cards\\backups\\<卡名>\\）。'));
        },
        'skills-status': async () => {
            const res = await client.control('skillsStatus');
            const out = find('skills-output');
            out.textContent = res.summary ?? JSON.stringify(res, null, 2);
            out.hidden = false;
        },
        'skills-deploy': async () => {
            const backupOpts = overwriteBackupOptions('同步技能与 Agent');
            const res = await client.control('skillsDeploy', backupOpts);
            const out = find('skills-output');
            out.textContent = res.summary ?? JSON.stringify(res, null, 2);
            out.hidden = false;
        },
        backups: () => showBackups(requireProject().id),
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
    find('backup-before-overwrite').addEventListener('change', async () => {
        const enabled = find('backup-before-overwrite').checked;
        if (!enabled) {
            const ok = confirmAction('关闭「每次覆盖写入前自动备份」后，后续覆盖操作将直接覆盖目标数据，一旦出错无法找回，数据丢失责任由本人自行承担。\n\n确定要关闭常驻自动备份吗？');
            if (!ok) {
                find('backup-before-overwrite').checked = true;
                return;
            }
        }
        if (state) {
            try {
                const res = await client.control('setAutoBackup', { enabled, acceptDataLossRisk: !enabled });
                state.autoBackupBeforeOverwrite = res.autoBackupBeforeOverwrite;
            } catch (error) {
                find('backup-before-overwrite').checked = !enabled;
                showError(error);
            }
        }
        renderControls();
    });
    renderControls();
    return { refresh, checkCardFollow, showError, root, dispose: () => root.remove() };
}
