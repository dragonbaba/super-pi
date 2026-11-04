# H06 — split-turn 压缩接收用户指令

状态：最小修复与本地验收完成，待独立 PR reviewer/CI。H06 分支 `codex/h06-compaction-instructions` 基于 H05 merge `b900f2e82dc1904811ac868cbf8af74caa9d63d9`。任务根 `D:\RMProjects\Pi\.task-tmp\h06-ef451f0ce8ff`；Node v26.13.0，子进程三个临时环境变量和 os.tmpdir 已验证，资源/进程登记 resources.json。

## 根因与完整链

已阅读 hot-path allocation contract。本项从 /compact/SDK AgentSession.compact(customInstructions) → 执行边界 preparation generation → abort 当前 agent → auth/credential-generation guard → prepareCompaction → compact → history/turn-prefix 摘要 → completeSummarization → retryAssistantCall → 已有 streamFn/provider → 请求编码/fetch/SSE → terminal response → compact 合并 → AgentSession signal/generation gate → appendCompaction → buildSessionContext → 释放 compaction controller 审计。自动压缩沿同一 compact 边界但无显式用户指令，不新增权限或认证路径。

history 的 generateSummaryWithUsage 在用户请求提示末尾追加 Additional focus；turn-prefix 的调用和签名没有 customInstructions。最小修改是传递同一参数，在静态 TURN_PREFIX_SUMMARIZATION_PROMPT 上沿同样规则拼接，然后使用原来的完整请求模板。不再次序列化/扫描历史，不把用户指令放入 systemPrompt，不改 0.8/0.5 reserveTokens 输出预算、请求次数、路由、重试或摘要合并规则。

既有成本：prepareCompaction 的切点/历史抽取/文件操作和 retainedTail；convertToLlm 的 map/filter 两个回调和数组，assistant/toolResult 借用输入、user 包装拷贝；serializeConversation 一次遍历、parts 数组和完整 join，assistant 另外 thinking/toolCall 临时数组，工具正文已有 2,000 字符截断。两段摘要各走一次此链，completeSummarization 创建请求选项和一个 produce 回调；retry 无失败时一次请求。下游 provider 转换、SDK JSON 编码和 token 预算既有成本保留，不称整链零分配。

输入准备数据归调用方；摘要请求消息/文本归本次请求。compact 返回 retainedTail 按设计保留，不能当泄漏。纯 compact 对 aborted response 的既有处理依赖 AgentSession 的 signal gate，成功写入之前再次检查取消和 generation；本项以真实 AgentSession 失败/取消验收确认没有保存不完整 checkpoint，不顺手改变这条契约。

## 验收设计

真实 compact 入口配实际 Anthropic SDK fetch 的四种请求矩阵：只有 turn-prefix、history+turn-prefix、非 split、有 split 但无指令；检查指令只在 user 请求的 conversation 标签之后出现一次，system 不含该指令，预算/认证路由/usage/文件记录/retainedTail 不变。真实 AgentSession 加隔离网络返回错误、length 或在第二段取消，验证 compaction entry 数不增加、controller/listener 释放。

大历史同机串行冻结基线/候选：计数原生产 convert/serialize/消息访问、请求及临时对象；独立 profile 关闭计数 hook；生命周期保留输入、已消费 stream 和 signal，WeakRef 检查请求 context/消息释放，成功、失败、取消分别记录。常规 delta 链不修改，没有新闭包/正则/深拷贝/池。最终 reviewer 和六分片 CI 为合并门禁。

## 冻结基线与生命周期诊断

compaction.ts SHA-256 `c2a26c3f647d98edb6dea6dad581c322f45d247e42e06eda39e93bf42d696dbd`；四项 SDK contract 2 通过、2 失败，只有 prefix-only/both 的 prefix 请求遗漏指令。真实 AgentSession 对第二段 error/length/abort 均不新增 checkpoint，compaction controller 清空，三项通过；这些是必须保留的行为。

初版 fixture 把 HTTP 错误经 SDK Response.text() 消费后的 body.locked 仍为 true 当成未释放 reader，并在保留 Response 强引用时要求 signal listener 立即为零，导致两个验收失败。源码定位 SDK `.asResponse()` 的 request-signal FinalizationRegistry 以 body 为回收目标，普通 adapter SSE reader 在 finally.releaseLock() 释放；HTTP 错误走 SDK bodyUsed 语义。修正测量所有权：先验证 SSE reader unlocked/HTTP bodyUsed，清空 fixture 的 Response owner，保持真实 session/signals 存活，8 次受控 GC 后 Response WeakRef 全释放、abort listeners=0。未修改生产清理，不声明立即释放；相关原失败日志登记保留至正式证据固化。

完整 AgentSession 另有 SDK streamRequest 的 prefix manifest/有效 dispatch 观察器和请求选项/回调；真实 session 用例覆盖这条链，性能基准测量 compact → 实际 provider 的请求链，不把 session 元数据分配算成零。基准 1,024 条 user 消息，每条主体 2,048 字符，history/prefix 各 512 条。原转换/序列化各 2 次，map/filter/serialize 各访问 1,024 条；对象 1,043、数组 13、既有闭包 6、模板 1,032、join 5。2 个 SDK 请求总计 2,125,404 code units，仅一个含 focus。基线 HeapProfiler 4,096-byte sampling、3 warmup/16 compactions，6,838,978 sampled bytes/compaction，主要为 SDK编码、原 serialize join 与 provider sanitize replace。24 个请求 context/message/content WeakRef 全释放，六个完成 stream、三个 signal、1,024 条原消息与一个 retainedTail 保持存活，abort listeners=0。

## 最小实现与候选验收

只在 compact 的原 turn-prefix 调用与私有函数签名传递 customInstructions；先给短静态提示拼接 Additional focus，再生成原有完整 conversation 请求。原认证、权限、模型预算、重试、文件跟踪、usage 合并、retainedTail 和写入前取消/generation 校验不变。没有新校验、共享状态、fallback、闭包、正则、池或历史 pass。

候选 compaction.ts SHA-256 `ef50ea4398fd571090903470692a2d6faad7da4a448bfd2b08647265caab8e94`；完整 AST arrow/function-expression 5、function declaration 27、regex/new Promise 0、strings 74、async 6，全部与基线相同。冻结 benchmark SHA-256 `61840d0ad78136f6eb62598eaffa98b40002032611a7c92d024560b7ae32f3d1`。

| 每次双段压缩 | 基线 | 候选 |
| --- | ---: | ---: |
| 实际 SDK 请求 / 含 focus 请求 | 2 / 1 | 2 / 2 |
| convert / serialize 调用 | 2 / 2 | 2 / 2 |
| map / filter / serialize 消息访问 | 各 1,024 | 各 1,024 |
| 源码对象 / 数组 / 既有闭包 | 1,043 / 13 / 6 | 1,043 / 13 / 6 |
| 模板执行 / join | 1,032 / 5 | 1,033 / 5 |
| 出站总 code units | 2,125,404 | 2,125,456 |
| sampled bytes/compaction | 6,838,978 | 6,807,747.5 |
| 请求 WeakRef / 存活数 / abort listeners | 24 / 0 / 0 | 24 / 0 / 0 |

新增模板仅组合短指令，不包含历史文本。每段仍一次 serializeConversation join；原 history prompt 的 previous-summary/静态提示组合、下游 sanitize replace 和 SDK JSON 编码是既有完整字符串成本，未宣称全部链路只物化一次。计数 hook 与 profile 分开；两版采样差约 0.5%，不作提速/省内存结论。GC 后堆 25,312,416/25,312,896 bytes，仅作为释放背景。profile 包含离线 Response、SDK 与 profiler 噪声；不是完整 AgentSession/TUI 性能测试。

四种真实 SDK 请求 matrix 全通过，指令只在 user 请求 conversation 标签之后一次出现；systemPrompt、819/512 输出预算、cacheRetention=none/toolChoice=none、路由参数和文件列表保持。真实 Session 第二段 error/length/abort 三项通过，无新增 checkpoint；输入 session/控制器/网络 reader 与 GC 后监听器验收通过。连同真实关闭期间 compaction/tree/bash 及 source/stream 回归 **36 通过**，指定 allocation source gate **2 通过**，新确定性 allocation gate **1 通过**。类型检查与离线构建通过。

所有子进程启动前设置三个临时变量；新 Session/counter 用例用仓库内 owned fixture 验证 os.tmpdir，登记 PID/退出结果并在子进程关闭后清理。正式采样/计数/AST/哈希和可重现命令见 [证据 JSON](../evidence/pi-history-h06-compaction-allocation.json)。最终 head reviewer 和六分片 CI 待完成。
