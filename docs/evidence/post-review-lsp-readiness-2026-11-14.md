# 审核后 LSP 冷启动导航修复

日期：2026-11-14；基线：`3e8b2f5a150e91292c6bd8d7c883dd054c47d390`。

## 复现和修复

原生产调用对 `commitPreparedFile` 冷查引用仅有 1 条，项目加载后相同查询为 62 条/9 文件；跳定义还会先返回 import 自身。客户端原先既未声明 workDoneProgress 能力，也未处理服务器的项目初始化 progress。可控服务器的“未就绪→就绪”、永不就绪、无就绪信号三个回归在基线上失败。

现在声明并确认标准 progress 创建请求，跟踪已核实的 typescript-language-server `ServerInitializingIndicator` 项目初始化任务。等待完成事件后刷新只读查询；等待期限取调用超时与 10 秒较小值，没有固定 sleep。输出分别标明 `projectReady`、`projectReadiness`、`potentiallyIncomplete` 和截断。超时、未知信号或元数据容量溢出不能成为“完整结果”。普通格式化任务的 progress 完成也曾在初稿中误判就绪，已通过失败回归核实并限定为已知的项目初始化信号；其他语言服务器没有受支持信号时保守标注，不拒绝查询。

`packages/lsp/tsconfig.json` 为内部 file 模块和 Windows job 类型使用真实 `.ts` 源码路径。解析探测确认 NodeNext ESM 不能采用原先无后缀的源码映射；补全 `.ts` 后实际 LSP 定义定位到 `src/core/files/file-commit.ts:165`。公共 coding-agent 声明边界和运行时 package exports 不变。

## 验证

- 三个行为回归：基线 3 失败，修复后 3 通过；增加真实 NodeNext ESM 源码解析回归、无关 progress、取消和容量不确定性验证。
- 两个 LSP 回归/AST 文件：32/32。根 `npm run check`、LSP 包 `npm run typecheck` 通过；离线构建 12/12，11,315 ms，peak=1。
- 真实仓库，无 sleep：冷查第一次 62 条且 `projectReady=true`，3,761.2 ms；立即预热查询仍为 62 条，105.3 ms。定义定位到源码而非 dist 声明，1,540.2 ms。生产 LSP runner 对五个变更 TS 文件均收到诊断：0 错误、0 警告、0 提示。
- 热路径完整链：stdout → 现有有界帧解析 → handleMessage → 项目 progress → 请求期限/导航刷新 → shutdown。普通 report 新增回调、Promise、AbortController、状态包装均为 0；原有 JSON 解析、Buffer 视图和诊断发布分配仍存在。项目 begin/end 的 token 元数据及显式导航的一个 waiter/期限属于请求/项目生命周期，非每 report；Set 最多 64 项、字符串最多 1,024 UTF-16 code units，溢出仅令就绪未知。完成/失败/取消/关闭清空 token、waiter 和计时器，没有对象池。
- 现有受控生命周期采样：3,000 次诊断发布、300 次 progress report，3 个稳定 settle callback/定时器，峰值 2 个计时器，24 个 WeakRef 在 GC 后均释放，关闭后计时器为 0；采样 15,184,600 字节，含 VM 夹具。常规回归仅使用小规模 progress；原诊断发布负载及 16 MiB gate 未放宽。
- 同机相同 10,000 个 138 字节 progress 帧，复用同一已编码 Buffer，剥离启动后采样：基线/候选为 10,583,592 / 10,773,552 字节；前/后 heap 为 20,831,720/21,948,160 与 20,946,432/22,059,320，关闭 GC 后为 21,503,136 / 21,620,648；RSS 高水位 104,488,960 / 106,524,672。CPU user/system 为 16,000/16,000 和 31,000/0 微秒，耗时 34.53 / 33.77 ms。两者传输覆盖一致，report backing store 和 child 均 0 保留；候选 token/waiter 均 0。该比较只测普通消息交付，新增就绪语义由上面的协议和真实查询验证；不据此宣称性能改善。
- 完整根 npm test 由未修改的六个 CI 分片执行。审查和 CI 必须对应最终 head；没有修改命令预检、授权或 sandbox 边界。

## 重跑

```powershell
npm run check
npm run typecheck --workspace packages/lsp
npm run build:offline -- --jobs 1
node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/lsp-validation-scope.test.ts tests/lsp-collection-hot-paths.test.mjs
```

真实导航用现有 TypeScript 路由，冷 client 查询 file-commit.ts:165 的 commitPreparedFile 引用，紧接着复查，再查 runner.ts:11 同名导入的定义。诊断仅报告收到实际发布的文件；临时日志和夹具置于任务 TMP，不与构建并发消费 dist。
