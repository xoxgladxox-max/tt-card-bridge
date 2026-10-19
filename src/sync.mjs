// Retired flat-field writer. Do not keep a second PNG-writing path behind old launchers.
console.error('LEGACY_SYNC_DISABLED: 旧扁平字段同步已停用：其冲突后续轮次可能覆盖未合并内容。没有修改旧素材或酒馆数据。');
console.error('迁移：先保留旧文件夹，在面板选择当前酒馆卡并「接入工程」（使用 forge unpack，输出新的空目录），人工核对旧素材后再启用同步。');
console.error('已有节点工程：tt-card mirror [cards目录]；单次同步：tt-card push <节点工程> <卡.png> / tt-card pull <节点工程> <卡.png> --dry-run。');
process.exitCode = 2;
