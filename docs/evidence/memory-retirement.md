# 记忆功能收敛验收

## 历史搜索

- 问题：会话索引器已退役，默认 `session_search` 和显式 `sessionSearch.variant: "legacy"` 仍查询旧 SQLite 会话索引，无法检索只有 JSONL 的历史。
- 复现：隔离目录仅写入一条合成会话，注册真实扩展并搜索；新增回归在修改前失败（1/1），不使用真实历史或用户配置。
- 修复：统一调用现有的有界 JSONL 搜索，返回可读取的文件和行号；移除旧查询实现、配置开关和片段参数。旧配置被忽略，不改写配置文件、不删除数据库。`memory_search` 继续使用派生索引。
- 验证：记忆包测试 17/17，通过默认、显式 `legacy` 和显式 `anchors` 三种配置验证命中与无匹配；禁止搜索期间打开 SQLite。仓库类型检查、真实 RPC 启动检查通过；离线构建 12/12 包，约 11.5 秒。
- 性能：只修改注册和配置选择并移除旧实现；现有 JSONL 扫描、结果格式化、扫描上限和流式事件链没有改动，不涉及热路径，跳过分配基准。
- 重跑：`npm --prefix packages/memory test`、`npm run check`、`npm run build:offline`、`node packages/memory/tests/rpc-smoke.mjs`。测试子进程的 `TMP`、`TEMP`、`TMPDIR` 应指向本次任务在 `.task-tmp/` 下的目录。
