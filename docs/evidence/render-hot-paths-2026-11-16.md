# 渲染热路径核实（2026-11-16）

基线：`a93e959dd74f651e74b33f2bec97648d9493d55d`。同机 Windows、Node 26.13.0；离线夹具，不读取私人会话内容或重放工具。候选生产源码摘要（按本记录列出的五个文件顺序，以路径、NUL、文件字节串计算 SHA-256）：`5c9420acb435c87c5e7b8d998b1ee3c7ddaa807184aa3d8fdef8e90336c868dd`。

## 已确认的开销与修改

审计调用链：Agent 最新事件交付/快照 → AgentSession 同步桥 → InteractiveMode → AssistantMessage/ToolExecution → RetainedContainer/ScrollView → TuiAltScreen 布局、覆盖层及选区 → TerminalFrameQueue → ProcessTerminal 的 Writable 回调与 drain。当前唯一渲染器是 TuiAltScreen。

1. `utils.ts` 的 ASCII 选区和覆盖层逐列拼接输出，普通填充行也创建大量短字符串。保留原有列宽、Tab 和 ANSI 状态判断，用局部整数记录连续片段，循环结束后各组装一次；Unicode 路径保留原有字簇语义。
2. `components/markdown.ts` 的增量尾部已受既有检查点约束，但纯 ASCII 仍分配逐字簇的 Intl 记录。复用 `utils.ts` 的纯 ASCII 判断，以字符宽度 1 扫描；混合 Unicode、长词拆分及语法切换继续使用原有路径。
3. `terminal-frame-queue.ts` 和 `render-instrumentation.ts` 重复用 JavaScript 逐字符计算 UTF-8 长度。统一到 `utf8-byte-length.ts`：Node 直接计量现有字符串，保留无 Buffer 环境的原算法，现有 instrumentation 导出保持兼容。没有额外编码、完整帧复制或计量缓存。

上述五个生产文件之外仅修改回归、基准报告和文档。旧实现的四个分配/原生计量断言失败；ANSI/Tab/Unicode 的既有及新增逐列字节对照通过。候选通过这些断言：200 次短词 ASCII 追加的检查点扫描不调用 Intl.segment，混合 Unicode 仍调用；每次帧提交原生计量一次；便携回退与原生计量均覆盖孤立代理项。

## 同机等量测量

下表为三次独立进程的中位数。分配使用 HeapProfiler，采样包含已回收对象；数值是采样字节，不是精确总分配。帧夹具为 120×40、5,000 条历史、100 次预热、1,000 个完整渲染；Markdown 为 50 次预热、500 次真实组件更新。每版均保留完整输出与相同完成覆盖。

| 场景 | 基线采样字节/帧或更新 | 候选 | 变化 |
| --- | ---: | ---: | ---: |
| 稳定视口帧 | 11,467 | 11,420 | -0.4%，基本不变 |
| 选区、覆盖层、CJK/emoji 混合帧 | 71,501 | 24,325 | -66.0% |
| ASCII Markdown 追加 | 13,607 | 7,920 | -41.8% |

基线混合帧的主要采样点为 highlightTerminalColumns、extractSegmentsInto；候选中这两个点显著下降，剩余主要点为高亮、列切片和布局。Markdown 基线主要点为 scanIncrementalPlainTail；候选主要点转为迭代器、行数组和 updateContent。稳定帧的主要布局分配保持原状。

CPU 单独使用 `--timing-only`，关闭分配采样：每版 300 次预热、3,000 帧，三进程中位数。稳定帧 CPU user+system 为 93 → 94 ms，P95 renderNow 耗时为 0.0206 → 0.0213 ms；混合帧 CPU 为 172 → 172 ms，P95 为 0.0515 → 0.0497 ms。不据此声称总体渲染延迟有明显改善。该选项把未采集的分配数据报告为 null，仍核对全部帧。

64 KiB 队列隔离采样的单次提交 P95 为 0.0945 → 0.0012 ms。另用未采样的 queue-direct 夹具，固定 2,000 次提交、一次预热、三次量测：整批耗时中位数 183.786 → 10.926 ms。两版都写出首/末两帧、替换 1,998 个旧待写帧；最终哈希均为 `d95736f02b1cc386331c61303d79487f0d8aabf7d0f36812cf6241b50ccd7004`。这是大帧计量/队列夹具收益，实际终端绘制与输入延迟仍需实机量测。

## 边界与释放

- 5,000 条历史稳定/混合场景，旧/新每 1,000 帧分别生成 183,000 / 197,000 UTF-8 字节；50,000 条历史的两版每 100 帧均为 19,700 字节。每帧访问 32 个可见项，已完成历史重绘为 0，全历史回退为 0。
- 每帧 Promise、AbortController、包装对象及应用层完整帧复制仍为 0；完整帧物化至多一次。普通 ASCII 组装循环不创建逐列字符串。现有视口/行数组仍存在，没有宣称整个渲染链零分配。
- 即刻完成 sink 的队列上界为 1；慢 sink 隔离夹具为一个活动写入加一个最新待写帧。flush 后活动/待写字节、writer 引用和等待者均为 0，最终帧没有遗漏。
- 对称源码加载夹具、关闭采样、五次创建/释放循环：进程峰值 RSS 101,699,584 → 101,687,296 字节；渲染结束时 heap 21,250,552 → 16,997,816，受控 GC 后 16,250,208 → 16,264,264，dispose/GC 后 15,997,176 → 16,011,352。峰值含启动，GC 值含夹具；不推断常驻内存显著下降或长期 heap 斜率。
- 两版布局、行、来源、屏幕、覆盖层和选区引用在释放后均为 0；生命周期最大残留计数为 0。没有引入缓存、对象池或新的逐帧回调；新增状态仅是调用内整数。原有错误、取消、重启和 drain 边界保持不变。

## 复跑入口

本地类型检查、12/12 包离线构建通过；渲染/ANSI/视口/队列/慢 sink/生命周期与源码约束的相关选择 338 项通过。完整 runner 完成 462 个执行单元：6,313 项通过、116 项平台跳过、0 失败。最终提交的 CI 和复审状态在 PR 中独立绑定，量测数据不替代这些门禁。

```powershell
npm.cmd run check
npm.cmd run build:offline
node --expose-gc --experimental-strip-types --test tests/tui-alt-overlay-selection-allocation.test.ts tests/tui-markdown-incremental-wrap.test.ts tests/tui-utf8-byte-length.test.ts tests/tui-frame-hot-paths.test.ts tests/tui-frame-queue.test.ts tests/tui-alt-layout-allocation.test.ts tests/tui-layout-frame-scope.test.ts tests/tui-visible-width.test.ts
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-allocations.ts --items 5000 --frames 1000 --warmup 100 --alt-control mixed
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-allocations.ts --items 5000 --frames 3000 --warmup 300 --alt-control mixed --timing-only
node --expose-gc --experimental-strip-types scripts/bench/tui-real-leaf-allocations.ts --updates 500 --warmup 50 --structural-updates 1000 --assistant-fixture append-growing-markdown
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --frames 5000 --warmup 500 --frame-kib 64
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-direct.ts --requests 2000 --frame-kib 64 --runs 3 --warmup 1
```

测试子进程的 TMP、TEMP、TMPDIR 使用独立 `.task-tmp` 任务根，并设置隔离的 SP_CODING_AGENT_DIR 和 SP_OFFLINE=1。真实消息基准通过现有包导出使用 dist；切换版本后先构建，再运行基准和测试，构建与读取 dist 的测试不并行。
