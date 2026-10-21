# 面板启动、连接与恢复契约

本文说明酒馆扩展面板如何拉起本机后台、如何与后台通信，以及写入和备份恢复的约定。

```text
启动按钮 → tt-card-bridge://start 协议 / Tauri 官方 Shell 插件 Command.spawn → src/mirror.mjs
扩展面板 / 任务消费 → extension/client.js → 127.0.0.1 后台
CLI / mirror → 同一个 SyncService / SyncEngine / FileSyncAdapter
```

`extension/protocol.js` 是浏览器与 Node 共用的 JSON 规范化和摘要实现，面板不另写比较规则。酒馆自带的设备同步（LAN/TT-Sync）不用于卡工程。

面板使用酒馆原生扩展的 `inline-drawer` 折叠抽屉，挂在左栏 `#extensions_settings`；按钮和输入框沿用酒馆的 `menu_button`、`text_pole` 样式。

## 启动与生命周期

`client.startSync()` 的行为：

1. 先读取后台状态。后台已在线时直接复用；已启用时不重复发送启用命令。
2. 连接失败时，先打开本机注册的 `tt-card-bridge://start` 协议（静默启动 `src/mirror.mjs`）；宿主提供 Shell 插件时，也可以调用 `window.__TAURI__.shell.Command.create('tt-card-bridge', [launch.script, launch.cardsRoot], options).spawn()`。权限或协议错误不会被当成后台未启动。
3. 等到 HTTP 状态可读，再发送 `resume` 控制命令。同一页面的重复点击共用同一次启动请求。
4. 缺少启动方式或启动配置、启动失败、进程提前退出、连接超时，都会明确报错，不显示已启用。启动失败的原因不会被随后的状态刷新覆盖。

「暂停同步」调用 `pause`：停止之后的自动调度，不中断正在进行的写入。点「关闭后台」或关闭酒馆后，`src/mirror.mjs` 检测到酒馆进程退出，会在 3 秒内自行关闭。后台不注册开机自启。

## 安装与连接配置

安装命令是 `node bin/tt-card.mjs install`。安装器复用 `<bridge>/.runtime/connection.json` 里的令牌，在**已安装的扩展目录**生成连接配置。下面是结构示例，实际路径由安装器填写：

```json
{
  "base": "http://127.0.0.1:18789",
  "token": "由安装器生成，勿分享",
  "launch": {
    "script": "<bridge>/src/mirror.mjs",
    "cardsRoot": "<工作区目录>",
    "cwd": "<bridge>"
  }
}
```

连接配置不写进卡片、扩展设置或源码里的扩展目录。`TT_BRIDGE_PORT` 指定端口，`TT_BRIDGE_TOKEN` 可以注入令牌；启动时令牌通过子进程环境变量传入，不放进命令行参数。

默认工作区目录取 `config.cardsRoot`；安装时可以用 `TT_BRIDGE_CARDS_ROOT` 另行指定。

| 操作 | 请求 | 返回 |
|---|---|---|
| version | GET `/tt-bridge/version` | `{version,files,cardJob,skillJob,queueDepth,jobClaim}` |
| claim | POST `/tt-bridge/jobs/claim` `{id,consumerId}` | `{claimed,consumerId}` |
| result | POST `/tt-bridge/skills/result` `{id,consumerId,...report}` | `{ok:true}` |
| status | GET `/tt-bridge/status` | `{ok:true,data}` |
| control | POST `/tt-bridge/control` | `{ok:true,data}` |

所有请求都带 Bearer 令牌，服务只监听 loopback。失败时保留 `error.code/message/details`。诊断信息只含连接地址，不含令牌。显式同步和自动调度共用一套引擎；新启动的服务默认暂停，点「启动同步」后才启用。

## 写入与备份恢复

普通写入走酒馆现有的角色卡接口和 `saveWorldInfo`，写入前先备份。原 PNG 的指纹取自 `GET /characters/<编码后的文件名>`；导出接口会重写元数据，不能代替原文件指纹。世界书是否存在以最新的 `world_names` 列表为准，不存在和空世界书要分开处理。

恢复按以下顺序执行：

1. 面板请求恢复预览，列出恢复范围和导入的副作用，由作者确认。
2. 后台复核预览，先备份当前状态，再暂停这张卡。
3. 扩展以 multipart 调用 `/api/characters/import`，字段为 `avatar`、`file_type=png`、`preserved_name`；世界书走现有的保存/删除路径。
4. 回执为 `{id,avatar,restored:true,mode:'import'}`。后台核对正文、条目设置、世界书和非运行时的卡设置，以实际读回的值作为新基线；这张卡保持暂停。

能力字段为 `capabilities.restoreMode='import'`，预览含 `mode`、`canRestore`、`blockedReason`、`notice`。**这不是逐字节恢复**：导入可能重新编码 PNG，并改动 `create_date`、`chat`、`fav`、`extensions.fav`。这些运行时字段按导入后的实际结果对齐，其余设置照常核对。

依据：TauriTavern 的 `src/tauri/main/routes/character-import-route.js` 用 `preserved_name` 转入 `replace_character`；`character_service.rs` 导出 PNG 时会转换元数据。

## 宿主侧接入点

以下是 TauriTavern 源码中与本扩展相关的位置（`<tauritavern-src>` 为源码根目录）。没有 Shell 插件的发行版只用 `tt-card-bridge://start` 协议启动后台。

- `src-tauri/crates/tauritavern/Cargo.toml`：在桌面依赖区接入 `tauri-plugin-shell`，锁文件由 Cargo 生成。
- `src-tauri/crates/tauritavern/src/app/host/plugins.rs`：按现有插件注册方式接入官方插件，不另建进程服务。
- `src-tauri/crates/tauritavern/capabilities/`：只允许桌面主窗口执行命名命令 `tt-card-bridge`（Node + 已安装配置里的 `src/mirror.mjs` 与工作区目录），不开放任意 Shell 命令。
- `src-tauri/crates/tauritavern/tauri.conf.json` 已有 `withGlobalTauri: true`，不需要额外的 JS 插件桥。

安装器在覆盖旧扩展前会备份到 `<data>/backups/tt-card-bridge/<时间>`。

## 边界

- 已领取的任务不会因为刷新页面而重发；未完成的写入记录随工程保存，写入未确认期间不要移动或删除工程目录。
- 同名工程已存在时不直接覆盖，需要在面板确认覆盖，并按备份设置先备份。跨卡名或跨世界书绑定的备份可以查看，但不能自动恢复。
- 只认一卡一文件夹的标准结构（`card.md`、`<字段>.md`、`message/`、`world_book/`、`regex/`、`scripts/`）。旧版 `index.md` 节点树和散乱草稿先用 `card-forge-lab` 转成标准结构（`node src/cli.mjs migrate <旧卡目录> --out <新标准卡目录>`）；本工具不会往这类目录写入空的 `card.md`。
- 开发版和便携版共用 data 目录，不能同时打开。
