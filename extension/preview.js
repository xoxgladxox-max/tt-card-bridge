// extension/preview.js — 酒馆端 Dry-Run 提示词与世界书触发预览
// 调用酒馆原生 Generate('normal', { quiet_prompt }, true)，不向大模型发请求、不修改聊天记录，
// 直接采集本轮实际激活的世界书条目、预算溢出状态、最终组装的消息分段与 Token 计数。

const MAX_COUNTED_ENTRIES = 200;

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map(part => (part?.type === 'text' ? String(part.text ?? '') : `[${part?.type ?? 'part'}]`)).join('\n');
}

function entryView(entry) {
  return {
    world: String(entry.world ?? ''),
    uid: entry.uid,
    comment: String(entry.comment ?? ''),
    keys: Array.isArray(entry.key) ? entry.key.map(String) : [],
    constant: Boolean(entry.constant),
    position: Number(entry.position ?? 0),
    depth: entry.depth ?? null,
    order: entry.order ?? null,
    role: entry.role ?? null,
    ...(entry.outletName ? { outletName: String(entry.outletName) } : {}),
    content: String(entry.content ?? ''),
  };
}

let running = false;

export async function previewCurrentPrompt({ getContext, input = '' } = {}) {
  const c = typeof getContext === 'function' ? getContext() : window.SillyTavern?.getContext?.();
  if (!c) throw new Error('无法获取酒馆上下文 SillyTavern.getContext()');
  if (running || document.body?.dataset?.generating === 'true') {
    throw new Error(running ? '已有一个触发预览正在进行' : '酒馆正在生成回复，请等生成结束后再预览');
  }
  if (c.groupId) throw new Error('群聊暂不支持触发预览：请先打开单角色聊天');
  const character = c.characters?.[c.characterId];
  if (c.characterId === undefined || !character) {
    throw new Error('酒馆里没有打开角色：请先打开要测试的角色卡聊天');
  }

  running = true;
  const { eventSource, eventTypes } = c;
  let scan = null;
  let data = null;
  const onScan = args => { scan = args; };
  const onData = (generateData, dryRun) => { if (dryRun) data = generateData; };
  eventSource.on(eventTypes.WORLDINFO_SCAN_DONE, onScan);
  eventSource.on(eventTypes.GENERATE_AFTER_DATA, onData);
  const trimmed = String(input ?? '').trim();
  try {
    await c.generate('normal', trimmed ? { quiet_prompt: trimmed } : {}, true);
  } finally {
    eventSource.removeListener(eventTypes.WORLDINFO_SCAN_DONE, onScan);
    eventSource.removeListener(eventTypes.GENERATE_AFTER_DATA, onData);
    running = false;
  }

  const api = String(c.mainApi ?? '');
  const raw = data?.prompt;
  if (raw == null) {
    throw new Error('酒馆没有组装出提示词（可能缺少必需的 API/预设设置，详见浏览器控制台）');
  }

  const prompt = {};
  const tokens = {};
  const countToken = async text => (typeof c.getTokenCountAsync === 'function' ? await c.getTokenCountAsync(text) : 0);

  if (Array.isArray(raw)) {
    const messages = [];
    for (const m of raw) {
      const content = contentText(m?.content);
      const t = await countToken(content);
      messages.push({
        role: String(m?.role ?? ''),
        ...(m?.name ? { name: String(m.name) } : {}),
        content,
        tokens: t,
      });
    }
    prompt.messages = messages;
    tokens.total = messages.reduce((n, m) => n + (m.tokens || 0), 0);
    const settings = c.chatCompletionSettings ?? {};
    if (Number(settings.openai_max_context)) tokens.context = Number(settings.openai_max_context);
    if (Number(settings.openai_max_tokens)) tokens.response = Number(settings.openai_max_tokens);
  } else {
    prompt.text = String(raw);
    tokens.total = await countToken(prompt.text);
    if (Number(c.maxContext)) tokens.context = Number(c.maxContext);
  }

  const activated = scan?.activated?.entries instanceof Map ? [...scan.activated.entries.values()] : [];
  const entries = activated.map(entryView);
  for (const [i, entry] of entries.entries()) {
    if (i < MAX_COUNTED_ENTRIES) entry.tokens = entry.content ? await countToken(entry.content) : 0;
  }

  return {
    api,
    chat: {
      character: { name: String(character.name ?? ''), avatar: String(character.avatar ?? '') },
      chatId: String(c.getCurrentChatId?.() ?? ''),
      messages: Array.isArray(c.chat) ? c.chat.length : 0,
    },
    ...(trimmed ? { input: trimmed } : {}),
    prompt,
    tokens,
    worldInfo: {
      entries,
      overflowed: Boolean(scan?.budget?.overflowed),
    },
    at: new Date().toISOString(),
  };
}

export function formatPreviewSummary(res) {
  const lines = [];
  const ch = res.chat?.character?.name || '当前角色';
  const totalTok = res.tokens?.total ?? 0;
  const ctxTok = res.tokens?.context ? ` / 上下文上限 ${res.tokens.context}` : '';
  const entries = res.worldInfo?.entries ?? [];
  const wiTok = entries.reduce((s, e) => s + (e.tokens || 0), 0);
  lines.push(`=== 触发预览：${ch}（聊天楼层 ${res.chat?.messages ?? 0}）===`);
  if (res.input) lines.push(`测试输入：${res.input}`);
  lines.push(`总 Token：${totalTok}${ctxTok} ｜ 激活世界书：${entries.length} 条（共 ${wiTok} tokens）${res.worldInfo?.overflowed ? ' 【警告：已超出世界书 Token 预算！】' : ''}`);
  lines.push('');
  if (!entries.length) {
    lines.push('（本轮没有激活任何世界书条目）');
  } else {
    lines.push('--- 激活的世界书条目（按激活顺序） ---');
    const posLabel = (p, d) => p === 4 ? `@D${d ?? 4}` : p === 0 ? 'before_char' : p === 1 ? 'after_char' : `pos:${p}`;
    for (const e of entries) {
      const tag = e.constant ? '[常驻]' : `[绿灯: ${(e.keys ?? []).slice(0, 5).join(', ')}]`;
      lines.push(`• [uid:${e.uid}] ${e.comment || '(无标题)'} ｜ ${posLabel(e.position, e.depth)} ｜ order:${e.order ?? '-'} ｜ ${e.tokens ?? '?'} tok ｜ ${tag}`);
    }
  }
  if (Array.isArray(res.prompt?.messages)) {
    lines.push('');
    lines.push(`--- 最终组装消息列表（共 ${res.prompt.messages.length} 段） ---`);
    res.prompt.messages.forEach((m, i) => {
      const preview = m.content.replace(/\s+/g, ' ').slice(0, 80);
      lines.push(`[#${i + 1} ${m.role}${m.name ? `(${m.name})` : ''} · ${m.tokens ?? 0} tok] ${preview}${m.content.length > 80 ? '…' : ''}`);
    });
  }
  return lines.join('\n');
}
