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

面板从上到下：状态行、当前卡、消息区，下面是三个默认收起的折叠区（工作区、设置、工具，展开状态会记住）。

### 1. 状态行
- 一行显示连接和同步状态，右边是 **「启动同步 / 暂停同步」** 和 **「刷新」**。暂停只停止自动处理，不打断正在进行的写入。刷新会重新读取状态，并把当前打开的卡告诉后台。
- **「导入酒馆」**：和酒馆「从文件导入角色」一样。点了选一个有 `card.md` 的卡工程文件夹，合成后用酒馆自己的导入接口新建一张卡：重名由酒馆加编号，卡里带的世界书第一次打开这张卡时酒馆会问是否导入。每次都是独立操作，不看同步记录、不连接工程、不同步、不写工作区。`调研.md`、`记录\`、`候选\`、`待归位\`、`note\`、`backups\`、`dist\` 不进卡；没有 `character.png` 时用酒馆默认头像。想让工程和这张新卡同步，打开它后点「改连到当前卡」。
- 下面一行小字显示后台地址和工作区目录。关闭覆盖前备份时多一行警告。

### 2. 当前卡
- 一行写当前卡名、对应的工程和状态（一致 / 有改动待确认 / 卡已不在 / 出错原因）；后台跟的卡和当前卡不一致时提示点「刷新」。
- 只显示当前用得上的按钮：
  - 还没拆到工作区：显示 **「拆解当前卡」** 和拆前清单。清单里先显示识别到的变量框架（如 `MVU`、`小白X`），再列出卡内的正则、脚本、角色变量、小白X任务；勾上的拆成 `regex\`、`scripts\` 下的文件，不勾的留在 `card.md`，两种都会完整合回卡里。同名文件夹已存在时先列出会替换和会保留的文件，再问是否覆盖。
  - 有工程原来连的卡已不在酒馆里（删卡重导）：显示 **「改连到当前卡」**，下拉框自动选中那个工程。要改条目编号时先列清单确认。
  - 已经连着：不显示按钮，自动同步。
- **持续连着与断开重连**：自动同步每 2 秒把工程、酒馆和上次同步记录（`.card-forge/tavern-sync.json`）三方对比。一直连着时，只改了一边的自动同步过去，两边都改了同一项才停下让你选。断开后重连（后台重启、暂停后恢复、切走又切回、上轮出错）的第一轮有差异时，状态显示「有改动待确认」，消息区列出清单，确认前两边都不写。只改了一边的项预选建议，两边都改的必须选；每项附工程文件和酒馆文件的修改时间，只作参考。逐项选好后点「确认写入所选」，或点「整卡以文件为准」「整卡以酒馆为准」；都先弹出清单确认，按备份设置备份后写入并复核。
- **只跟当前打开的卡**：自动同步只处理酒馆里当前打开的那张卡（和世界书编辑器里当前打开的那本），不建卡、不改其他卡。只认有 `card.md` 或 `.card-forge` 的文件夹。
- **格式检查**：只有参与同步的文件（根目录字段 `.md`、`message\<数字>.md`、`world_book\**\*.md`、`regex\`、`scripts\`）会触发同步；卡文件夹里放笔记、调研不影响。这些文件格式不对时，这张卡本轮整卡不同步并列出坏文件（只跳过一个文件会把酒馆里对应条目删掉），改好后下一轮恢复。
- **排队**：同一张卡的同步、拆卡、Agent 写入按顺序做，不同卡互不等待。

### 3. 消息区
错误、改动清单、操作结果、备份列表和恢复预览都显示在当前卡下面这一处，没有内容时不占位置。

### 4. 折叠区「工作区」
- **工程下拉框**：选工程给「改连到当前卡」和「备份」用。
- **「备份」**：查看所选工程的快照，预览后确认覆盖恢复（恢复后该卡保持暂停）。
- **世界书下拉框 + 「拆解世界书」**：只列世界书编辑器里当前打开的那一本，拆到 `<工作区目录>\<世界书名>\`。

### 5. 折叠区「设置」
- **工作区目录**：拆卡、同步、合成和酒馆 Agent 读写都在这里，一卡一文件夹：`<工作区目录>\<卡名>\`。填好后点 **「切换」**，立即生效并保存到 `config.json`（误填单张卡内部目录时后台会拒绝）。Agent 没有改目录的工具。
- **覆盖前备份，每张卡保留 N 份**：默认开启、保留 5 份（0 = 全留），份数改完自动保存，只清理同步前的自动快照。关闭时确认一次，之后所有覆盖直接执行。
- **备份位置**：留空时备份到 `<工作区目录>\backups\<卡名>\<时间>\`；填好后点 **「保存」**，改为 `<备份目录>\<卡名>\<时间>\`。

### 6. 折叠区「工具」
技能与 Agent 的检查和同步（见下一节）、**「日志」**、**「复制诊断」**（含本机路径和卡名，不含令牌）。
### 7. 技能与 Agent 同步
- **检查技能**：一键对照原件 `skills/cf-*`、版本存档 `skills-versions`、LimCode TEST、Claude Code（`~/.claude/skills`）、通用目录 `~/.agents/skills`（Codex 等读取）、酒馆全局技能与 Agent 全局系统提示词原件状态。
- **同步技能**：一键存档当前版本，将全部 `cf-*` 技能同步部署到 LimCode TEST、Claude Code、`~/.agents/skills` 与酒馆全局技能（宿主目录 `~/.claude`、`~/.agents` 不存在时跳过；只动 `cf-*` 和改名前的旧名目录，不碰第三方技能），并自动更新酒馆中制卡 Agent 配置的技能列表。

### 8. 本地新建世界书条目（自动补稳定 `id` 与 `uid`）
- 在已接入工程的 `world_book/**/<条目>.md` 中编写 frontmatter 与 `<!-- body -->` 正文，**可省略 `id` 字段**。
- 同步时后台会自动分配不与远端或历史基线冲突的 `world-<哈希>`（及酒馆 `uid`），写回该 `.md` 文件并推送至酒馆世界书。
- 只写了 `tavern.id`、没写 `id` 的文件（拆卡时记下了酒馆编号）：补 `id` 时保留这个编号，当作酒馆里的同一条按三方对比处理，不再报「被占用」。只有本地两个文件写了同一个 `tavern.id` 才停下报错。

### 9. 酒馆 Agent 读写工作区（MCP）
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
