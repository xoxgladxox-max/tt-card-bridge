// cdp-eval.mjs — 自测用：在已用调试端口打开的 Chromium 里，对 SillyTavern 页面执行一段 JS 并打印结果
// 用法：node scripts/cdp-eval.mjs "<表达式>" [调试端口=9333] [页面地址包含=:8001]
// 原生 SillyTavern 没有 tauri-pilot，用它代替 tauri-pilot eval。只走本机回环地址。
const [expr, port = '9333', match = ':8001'] = process.argv.slice(2);
if (!expr) { console.log('用法：node scripts/cdp-eval.mjs "<表达式>" [调试端口] [页面地址包含]'); process.exit(2); }
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find(p => p.type === 'page' && p.url.includes(match));
if (!page) { console.error(`没有找到地址包含「${match}」的页面`); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', bad, { once: true }); });
const res = await new Promise(resolve => {
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id === 1) resolve(m); });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000 } }));
});
ws.close();
const r = res.result;
if (res.error) { console.error('调试协议报错：' + res.error.message); process.exit(1); }
if (r?.exceptionDetails) { console.error('页面报错：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)); process.exit(1); }
const v = r?.result?.value;
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
