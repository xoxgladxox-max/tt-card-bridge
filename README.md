# tt-card-bridge · 卡工程同步与技能部署

连接角色卡/世界书工程（`cards/<卡名>/`）与 TauriTavern（兼容 SillyTavern）的**扩展插件与本机同步服务**。支持一卡一文件夹双向同步、免重启热刷新与制卡技能部署（制卡拆包/装配工具链与技能原件由 `card-forge-lab` 提供）。

## 快速开始

1. 在本目录运行安装命令（先自动备份旧扩展，再部署扩展并注册 `tt-card-bridge://start` 本机启动协议）：
   ```bash
   node bin/tt-card.mjs install
   ```
2. 打开酒馆，进入 **扩展 → 卡工程同步**（左栏折叠抽屉）。
3. 点击 **「启动同步」** 即可拉起本机后台并开启自动同步；关闭酒馆后后台自动随之退出，不注册开机自启。

## 面板功能指南

### 1. 总开关、工作区目录与备份设置
- **启动同步 / 暂停同步 / 关闭后台**：控制后台自动轮询或退出后台进程。暂停只停止自动扫描，不中断正在执行的写入。
- **刷新**：重新读取后台与工程状态。
- **工作区目录**：作者自选的一个目录，拆卡、同步、合成和酒馆 Agent 读写都在这里，也是 VS Code 里打开的同一个目录。一卡一文件夹：`<工作区目录>\<卡名>\`。填入路径后点 **「切换工作区目录」**，立即生效并保存到 `config.json`（误填单张卡内部目录时后台会拒绝）。Agent 没有改目录的工具。
- **只跟当前打开的卡**：自动同步只处理酒馆里当前打开的那张卡（和世界书编辑器里当前打开的那本），不建卡、不改其他卡。只认有 `card.md` 或 `.card-forge` 的文件夹。
- **格式检查**：只有参与同步的文件（根目录字段 `.md`、`message\<数字>.md`、`world_book\**\*.md`、`regex\`、`scripts\`）会触发同步；卡文件夹里放笔记、调研不影响。这些文件格式不对时，这张卡本轮整卡不同步并列出坏文件（只跳过一个文件会把酒馆里对应条目删掉），改好后下一轮恢复。
- **排队**：同一张卡的同步、拆卡、Agent 写入按顺序做，不同卡互不等待。
- **备份位置与自动备份**：
  - 默认备份到 `cards\backups\<卡名>\<时间>\`；填写自定义备份位置并点击 **「保存备份位置」** 后，备份写入 `<备份目录>\<卡名>\<时间>\`。
  - 默认勾选 **「覆盖前自动备份」**；若取消勾选，必须显式勾选确认「已知晓：不备份直接覆盖一旦出错无法找回，数据丢失责任由本人自行承担」后才允许覆盖写入。

### 2. ① 拆解当前卡（含变量框架识别、方案 A 拆分勾选、拆解独立世界书）
- **变量框架自动识别**：选中酒馆角色卡后自动扫描并显示变量框架（如 `MVU (beta)`、`MVU (master)`、`小白X` 或 `未检出`）。
- **正则 / 脚本 / 变量 / 小白X任务拆分勾选（方案 A）**：
  - 自动列出当前卡内的局部正则、酒馆助手脚本、角色变量结构与小白X任务；默认全勾选拆出（已停用的正则默认不勾选，留在 `card.md`）。
  - 勾选的项拆到 `regex\<序号>-<名>.json + .html`、`scripts\<序号>-<名>.json + .js`、`scripts\variables.json`、`scripts\xiaobaix-tasks.json`；未勾选的项保留在 `card.md`，合成时按原顺序合并。
- **拆解当前卡**：将酒馆当前打开的卡及绑定的世界书拆到 `cards\<卡名>\`（生成 `card.md`、`description.md`、`message\0.md`、`world_book\**\<条目>.md`、`regex\`、`scripts\`、`character.png`）。若同名文件夹已存在，会提示确认覆盖并按备份设置先自动备份。
- **拆解独立世界书**：下拉框只显示世界书编辑器里当前打开的那一本，点击 **「拆解独立世界书」** 拆到 `<工作区目录>\<世界书名>\`。

### 3. ② 合成并导入酒馆（切卡自动跟随、冲突选边、备份与恢复）
- **切卡自动跟随**：在酒馆切换角色卡时，面板自动切到同名工程，只同步这一张；其他卡的绑定不改。工作区里尚未进酒馆的新卡可在下拉框中选择。
- **合成并导入酒馆**：将工作区目录里所选的工程（`card.md`、顶层字段 `.md`、`message\`、`world_book\`、`regex\`、`scripts\`）合成后写回酒馆；`调研.md`、`记录\`、`候选\`、`待归位\`、`note\` 不进卡。若酒馆尚无同名卡则自动新建；写回当前打开的卡后，自动热刷新酒馆助手脚本树、角色变量、小白X楼层渲染与未修改的第 0 楼开场白。
- **双侧冲突自动弹出选边**：当同一槽位（含正文、世界书条目、正则、脚本、变量、小白X任务）在本地和酒馆同时被修改时，面板自动展开冲突对比，可逐项选择「使用工程内容」「使用酒馆内容」或「手动填写内容」，点击 **「备份并应用所选内容」**。
- **备份与恢复**：点击 **「备份」** 查看该卡历史快照列表，预览范围并勾选确认后可执行覆盖恢复（恢复后该卡保持暂停）。

### 4. 技能与 Agent 同步
- **检查技能与Agent**：一键对照原件 `skills/cf-*`、版本存档 `skills-versions`、LimCode TEST、Claude Code（`~/.claude/skills`）、通用目录 `~/.agents/skills`（Codex 等读取）、酒馆全局技能与 Agent 全局系统提示词原件状态。
- **同步技能与Agent**：一键存档当前版本，将全部 `cf-*` 技能同步部署到 LimCode TEST、Claude Code、`~/.agents/skills` 与酒馆全局技能（宿主目录 `~/.claude`、`~/.agents` 不存在时跳过；只动 `cf-*` 和改名前的旧名目录，不碰第三方技能），并自动更新酒馆中制卡 Agent 配置的技能列表。

### 5. 本地新建世界书条目（自动补稳定 `id` 与 `uid`）
- 在已接入工程的 `world_book/**/<条目>.md` 中编写 frontmatter 与 `<!-- card-forge:body -->` 正文，**可省略 `id` 字段**。
- 同步时后台会自动分配不与远端或历史基线冲突的 `wb-<递增序号>`（及酒馆 `uid`），写回该 `.md` 文件并推送至酒馆世界书。

### 6. 酒馆 Agent 读写工作区（MCP）
后台在 `http://127.0.0.1:18789/tt-bridge/mcp` 提供 MCP 接口（须带连接令牌），让 TauriTavern 的 Agent 和 VS Code 读写同一个工作区目录。
- `install` 会在 `_tauritavern\mcp\registrations\` 写一条 bridge 自己的登记，在 `_tauritavern\agent-profiles\profiles\` 写「卡工程」档案 `card-bridge.json`；同名旧文件先备份到 `data\backups\tt-card-bridge\agent-setup-<时间>\`。其他登记和档案不动。`install --remove` 只删这两个文件（同样先备份）。酒馆里看不到时按 install 打印的步骤手动登记。
- 工具：`status`、`list_files`、`read_file`、`search_files`、`file_info`、`write_file`、`apply_patch`、`create_dir`、`move`、`delete`、`disassemble_card`、`sync_now`、`validate_card`、`validate_worldbook`、`list_backups`、`restore_backup`。没有执行命令和改目录的工具，也没有合卡工具：合卡由 LimCode 在 VS Code 里用写卡技能完成，再导入酒馆。
- 写入规则：路径限定在工作区目录内；不能写 `.card-forge` 等点开头的目录和 `backups\`；不能删除或移动卡工程文件夹本身。改已有文件必须带 `read_file` 返回的 hash，对不上就拒绝（`HASH_MISMATCH`）。覆盖、删除、移动前一律备份到 `<工作区目录>\backups\files\`，不看「覆盖前自动备份」开关；删除实际是移入备份。`disassemble_card` 只拆酒馆当前打开的卡；整卡恢复须先预览再 `confirm`。

## 命令行入口（与面板共用同一套引擎与队列）

```bash
node bin/tt-card.mjs mirror ["<工作区目录>"]
node bin/tt-card.mjs push "<卡工程>" "<卡.png>" [--watch] [--force]
node bin/tt-card.mjs pull "<卡工程>" "<卡.png>" [--dry-run]
node bin/tt-card.mjs push "<卡工程>" --book ["<世界书名>"] [--watch] [--force]
node bin/tt-card.mjs pull "<卡工程>" --book ["<世界书名>"] [--dry-run]
node bin/tt-card.mjs skills status
node bin/tt-card.mjs skills deploy
node bin/tt-card.mjs skills versions "<技能名>"
node bin/tt-card.mjs skills rollback "<技能名>" "<版本号>"
node bin/tt-card.mjs install [--remove]
```

## 上传至 GitHub 说明

- `.runtime/`（含本机随机鉴权令牌 `connection.json`、运行状态 `service.json`、静默启动器）已在 `.gitignore` 中排除，绝不入库。
- `config.json` 默认使用相对路径（`"skillsRoot": "../card-forge-lab"`, `"cardsRoot": "../cards"`），不含任何本机盘符或个人路径；仓库同时提供 `config.example.json`。
- 酒馆数据目录通过 `%APPDATA%\com.tauritavern.client\tauritavern-runtime.json`（或环境变量 `TAVERN_USER_DIR`）自动发现。

## 测试

```bash
npm test
```
