// 把 Tauri 官方 Shell 插件接入 TauriTavern 宿主源码（只改 3 处，可重复运行）。
// 用法：node tools/apply-host-shell.mjs [宿主源码根]
// 撤销：git -C <宿主源码根> checkout -- src-tauri && 删除 capabilities/card-bridge-shell.json
import fs from 'node:fs';
import path from 'node:path';

const srcArg = process.argv[2] || process.env.TAURITAVERN_SRC;
if (!srcArg) {
  console.error('用法：node tools/apply-host-shell.mjs <TauriTavern-src 目录>');
  process.exit(1);
}
const root = path.resolve(srcArg);
const crate = path.join(root, 'src-tauri', 'crates', 'tauritavern');

function patch(file, anchor, insert, marker) {
  const full = path.join(crate, file);
  const text = fs.readFileSync(full, 'utf8');
  if (text.includes(marker)) return console.log(`已存在，跳过：${file}`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const a = anchor.replaceAll('\n', eol);
  if (!text.includes(a)) throw new Error(`找不到锚点，未修改：${file}`);
  fs.writeFileSync(full, text.replace(a, a + insert.replaceAll('\n', eol)));
  console.log(`已修改：${file}`);
}

patch('Cargo.toml',
  'tauri-plugin-pilot = { version = "0.8.1", optional = true }\n',
  'tauri-plugin-shell = "2"\n',
  'tauri-plugin-shell');

patch(path.join('src', 'app', 'host', 'plugins.rs'),
  '        }\n    }));\n',
  '\n    // 卡工程同步面板用官方 Shell 插件启动本机后台；命令范围见 capabilities/card-bridge-shell.json。\n    #[cfg(desktop)]\n    let builder = builder.plugin(tauri_plugin_shell::init());\n',
  'tauri_plugin_shell');

const cap = path.join(crate, 'capabilities', 'card-bridge-shell.json');
if (fs.existsSync(cap)) {
  console.log('已存在，跳过：capabilities/card-bridge-shell.json');
} else {
  fs.writeFileSync(cap, JSON.stringify({
    $schema: '../gen/schemas/desktop-schema.json',
    identifier: 'card-bridge-shell',
    description: '卡工程同步面板：只允许用 node 启动 tt-card-bridge 的 mirror.mjs',
    windows: ['main'],
    platforms: ['windows', 'macOS', 'linux'],
    permissions: [{
      identifier: 'shell:allow-spawn',
      allow: [{
        name: 'tt-card-bridge',
        cmd: 'node',
        args: [{ validator: '.+[\\\\/]src[\\\\/]mirror\\.mjs' }, { validator: '.+' }],
        sidecar: false,
      }],
    }],
  }, null, 2) + '\n');
  console.log('已新建：capabilities/card-bridge-shell.json');
}
console.log('完成。下一步：重新启动酒馆开发版（会自动编译并更新 Cargo.lock）。');
