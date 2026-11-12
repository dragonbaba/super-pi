# CodeGraph 集成退役验证（2026-11-12）

源码基线：`104355803`。本记录对应[清理计划](../file-ops-codegraph-memory-cleanup-plan.md)的 B；A、C 未实施。以下数字为本机离线夹具验证，不代表远端 CI 或真实 provider 会话验证。

## 问题与复现

project-context 仍注册 `codegraph` 和四个维护命令，状态及生成 profile 会探测或推荐该集成；工具搜索和循环护栏还包含专属分类。退役需要保留轻量项目上下文及已有用户数据。

`tests/project-context-retirement.test.ts` 的同一组 7 个回归，通过临时 loader 读取基线 Git blob 时为 6 失败、1 通过；当前候选为 7/7 通过。夹具使用任务目录内独立 Git 根，实际调用扩展默认注册函数及保留的项目命令，不向上使用父仓库身份。

## 修改

- 删除外部客户端、模型工具、四个命令、安装探测、profile 推荐、专属搜索别名和错误分支；只移除不再有消费者的四个正则，保留通知清理共用的正则。
- `/project-status`、`/project-init`、`/project-refresh`、规则文件和轻量索引继续工作。旧 profile 只被判为 stale，显式 refresh 后恢复 fresh，再次 refresh 不变。
- `.codegraph/` 的忽略及扫描排除保留；夹具证明索引内容、既有 AGENTS 和记忆字节不变。不清理用户索引、全局安装或技能。
- 当前中英文说明、包 README 和文档导航同步更新；CodeGraph 字面引用仅保留在退役说明、历史方案、回归及排除规则中。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm run build:offline` | 12/12 包，7,234 ms |
| 下列 9 个相关测试文件 | 94/94，通过；8,383 ms（取整） |
| `git diff --check`、文档链接、生产引用核对 | 通过 |

相关测试包含新增退役回归、bundled extension 加载与源码导入、工具搜索及其源码/引用释放不变量、失败分类、重试护栏和 CodeMode 护栏。生产改动不触及 provider、进度、事件分发、渲染或大结果路径，不新增热路径分配，按 B 的约定跳过单独的分配基准；相关源码不变量随测试运行。

先依 AGENTS.md 将子进程的 `TMP`、`TEMP`、`TMPDIR` 指向本任务专属 `.task-tmp/<task-id>/`，在仓库根目录依次重跑，构建不得与消费 dist 的测试并发：

```powershell
npm run check
npm run build:offline
$tests = @(
  'tests/project-context-retirement.test.ts'
  'tests/bundled-extensions.test.ts'
  'tests/tool-search-ranking.test.ts'
  'tests/tool-search-hot-paths.test.ts'
  'tests/tool-failure-classification.test.ts'
  'tests/tool-loop-repeat.test.ts'
  'tests/tool-loop-repeat-hot-paths.test.ts'
  'tests/codemode-hot-paths.test.ts'
  'tests/codemode-guardrails.test.ts'
)
node --experimental-strip-types --test --test-concurrency=1 @tests
```

未运行全仓 `npm test`；所需远端 Linux/Windows CI 与最终 head 审查仍是交付门禁。未验证用户全局 CodeGraph 安装或数据内容，也未对其作任何变更。
