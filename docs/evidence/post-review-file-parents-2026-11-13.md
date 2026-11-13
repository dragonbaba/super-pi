# 审核后 copy/move 缺失父目录修复

日期：2026-11-13；基线：`3e8b2f5a150e91292c6bd8d7c883dd054c47d390`。

## 问题、复现和修复

Native 和 MXC worker manifest 预检原先直接捕获目标父目录身份：目录不存在便抛原始 ENOENT。16 个文件/目录源、copy/move、一层/三层父目录场景在基线上全部失败，现均通过，预检和 dryRun 不产生目录。

从 write 既有 `executeFileCreation` 提取其独占 mkdir、祖先/新建/共享目录身份核验及失败事实为 `executeFileCreationDirectories`，write 与 copy/move 共用同一实现。`prepareFileCreation` 产生只读完整清单，进入审批预览和 ready 记录；Native 与 worker 绑定目标工作区和祖先，授权后执行，再捕获实际目标父目录身份。没有第二次审批、脚本解析、命令白名单或新的目标数量限制。

本次调用持有公共父目录身份，后续数组项及 file_batch 项复用前项已创建的目录。回归还复现了“建完父目录后源文件变化”：Native 报 partial、worker 曾误报 unknown 并中断；现区分尚未开始目标 I/O 的已知父目录效果，两条路径均记录 partial 并验证身份后继续独立项。真正的未知效果、日志/传输丢失、取消和代次切换继续停止。

mkdir 不返回能证明持续所有权的句柄，因此失败时保留无法安全删除的目录，回执和完整父目录 artifact 如实列出，不擅自回滚或重放。已有目标、目录覆盖/合并、BATCH_CONFLICT、受保护路径、源 junction 拒绝和大小写折叠检查继续保留。缺失父目录不能越出工作区；worker 的跨授权工作区清单绑定目标工作区索引。

不确定的 mkdir 错误另保留尝试路径：真实创建后注入 EIO 时，Native 和 worker 都记录无身份的 retained 条目并报告 state_unknown；EACCES 等已知无效果错误不计入该清单。复用父目录在每次后续 mkdir 前重新核对身份；回归在首次检查返回旧身份前把公共父目录换为 workspace 外的 junction，修复前外部目录产生了子目录，修复后在该副作用前拒绝。复用身份引用只在本次 helper 中惰性持有，finally 清空；不改变命令或审批预检。

## 验证

- 10 个相关回归文件：110 项，109 通过，1 个未配置真实跨卷目录的场景跳过。覆盖 Native/worker 标量、文件/目录、一层/多层父目录，真实会话数组、file_batch、dryRun、workspace/protected/folded 冲突、junction、取消/保留事实、源变化后的下一项、两个 worker 工作区、EIO/EACCES 及公共父目录替换。后五项在修复前为 3 失败、2 通过，修复后 5 通过。
- 根 `npm run check` 通过；`npm run build:offline -- --jobs 1` 为 12/12，10,552 ms；三个 worker/core `.mjs` 的 `node --check` 通过。实际生产 LSP runner 对七个变更 TS 文件均收到诊断：0 错误、0 警告、0 提示。
- 改动属于显式文件调用的预备和文件系统提交，不改变 provider delta、终端帧或工具进度热路径。仍检查完整 session → authorization → FileMutation → Native/worker → commit/回执 → release 链，并运行提交源码不变量与现有文件分配基准；没有对象池、每叶回调或全局 scratch。
- 同机 Node 26.13.0，原有手动基准设 32 个目标；基线/候选都完整执行 copy、move、delete、file_batch 各 32 项，逐项验证效果、分页和 changes，并检查后续编辑与外部变化失效。两者均有 225 个 plan 引用、GC 后 0 保留 plan、532 条历史记录。采样字节 120,795,368 / 121,167,888；观察峰值 heap 47,218,784 / 45,482,008，RSS 154,484,736 / 152,256,512。主要采样来自 V8、fs 身份/错误对象、路径解析及协议解析。四阶段 CPU user/system 总和分别为 610,000/359,000 与 641,000/406,000 微秒。该对照使用双方原已支持的等价正确负载；新增缺失父目录由功能回归覆盖，不用基线失败来宣称加速，也不从小样本宣称性能改善。
- 完整根 npm test 使用未修改的原有六个 CI 分片；最终 head 审查和 CI 状态以本 PR 为准。worker 回归替换进程启动，仍经过实际编码/计量/manifest/会话/权限/回执链；不冒充真实 MXC SDK 会话或 5 万文件性能验证。

## 重跑

```powershell
npm run check
npm run build:offline -- --jobs 1
node --experimental-strip-types --test --test-concurrency=1 tests/native-file-tree-v3.test.ts tests/mxc-file-mutation-worker-v3.test.mjs tests/file-mutation-v3.test.ts tests/file-sandbox-service-v3.test.ts tests/file-path-conflicts-v3.test.ts tests/file-manifest-proof-v3.test.ts tests/file-operation-input-v3.test.ts tests/file-rpc-chunks-v3.test.ts tests/file-result-v3.test.ts tests/committed-file-revision-hot-paths.test.ts
$env:SP_FILE_BENCH_TARGETS = '32'
node --expose-gc --experimental-strip-types --test scripts/bench/file-mutations-v3.ts
```

在独立子进程设置任务 TMP/TEMP/TMPDIR；构建不与消费 dist 的测试并发。对七个变更 TS 文件使用当前 TypeScript LSP 路由，JS 语法及执行验证单独报告。
