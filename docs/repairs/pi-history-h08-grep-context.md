# H08 — grep 默认上下文流式读取

状态：已合并 [PR #207](https://github.com/dragonbaba/super-pi/pull/207)，两端任务分支和本项临时根均已删除并验证。原分支 `codex/h08-grep-context` 基于 H07 merge `098cc11c3d681fda9852d3163e2e5deddc45b0ed`。本项任务根 `D:\RMProjects\Pi\.task-tmp\h08-ba69993a9cf9`，Node 26.13.0，child TMP/TEMP/TMPDIR 已验证。

## 先行范围与容量

入口为宿主 tools/index.ts → wrapper → consumeToolPath → ensureTool → rg JSON stdout/readline → match/context → 结果截断 → 工具交付、预算、renderResult。Sandbox 替换同名工具，使用独立 guest literal search，不走 rg。默认 context 当前经 fs.readFile、两次换行 replace、split 和 Map 缓存整文件；每个命中 formatBlock 又建立 Promise 和 block 数组。显式注入 GrepOperations 仍以调用方 readFile 为上下文来源；本轮保留该既有接口，在明确的 custom 分支执行，默认路径不能在协议错误时回退读文件。

先行容量：B=DEFAULT_MAX_BYTES=51,200，L=GREP_MAX_LINE_LENGTH=500。默认路径只保留按 rg 顺序出现的前 B 字节上下文行，加至多一行越界哨兵。每行文本最多 L 个字符加原截断标记，含路径/行号前缀的最大字节数记为 P；保留文本/格式化输出各 ≤B+P，行数各 ≤B+1（每行格式至少 1 字节），与文件大小、context 值无关。匹配元数据与文件摘要仍受请求 match limit 约束，与原接口一致，不把 V02 精确 limit 误报并入本项。一个正在解码的 rg JSON record 仍随最大单行增长，是协议输入的瞬时成本，不能称为全链常量内存。

rg 合并的 context 事件按文件/行序输入；输出仍按每个已接纳 match 展开其窗口，重叠行可重复且只有该窗口中心使用冒号，其他行使用短横线。重复展开只会更早消耗输出预算，因此前 B+P 唯一输入行足够重建输出前缀。保存独立原始字段数组，不逐 context 创建包装对象或 Promise；格式化达到字节上限即停止。达到 match limit 后继续消费最后一个窗口所需的尾上下文，然后关闭子进程；误报边界维持现状。

UTF-8/UTF-16 采用 rg 的实际转码结果；JSON text/bytes 只按 rg 协议解码，bytes 为 base64 后 UTF-8 replacement，与原 UTF-8 readFile 口径一致。行号以 rg 的 LF 记录为准；CRLF 去除行尾 CR，单 CR 不是 rg 的换行符，原 context 把它另算一行的错位需要明确记录。不能添加猜测编码链。

每次 execute 所有状态局部持有；成功、错误、取消均在 child close 后移除 listener 并清空行、匹配、cache 引用。外部 signal、tool、child 保持存活验证释放；不依靠退出进程证明。保留授权入口一次消费及真实 rg 错误；新增协议解码检查只在 stdout 边界，内部不重复解析。无对象池。

## 验收计划

实际 createGrepTool + 固定 rg：重叠/分离窗口、多文件、首尾、无末尾换行、LF/CRLF/单 CR、UTF-8/带 BOM UTF-16、text/bytes、长单行、取消/error、custom 兼容；默认 readFile=0、整文件 split=0。小/大文件同命中片段固定基线与候选哈希，结构计数与 HeapProfiler 采样分开，记录主栈、峰值及受控 GC；source/AST 和相关工具结果门禁必须通过。

## 基线、完整链与实现边界

首次真实 rg 基线 12 项中 2 通过（错误/取消）、10 失败：正常上下文仍调用 readFile；单 CR 被另算一行、UTF-16 被 UTF-8 重读而错位。候选 13 项全通过，增加精确 51,200 字节前缀之后仍有内容的边界，避免将计入首个不存在的换行造成的提前停止当作完整输出。H07 的 8 项 host/custom 配置隔离仍通过，custom context 明确保持自定义 readFile，每文件缓存一次；该兼容路径的整文件读取与每 match async block 旧成本没有消失，不属于默认路径的有界声明。

默认流使用三个 owner 数组（文本、文件身份、行号），相邻记录复用文件路径身份。JSON.parse 是每个协议记录一次，base64 只在 bytes 表达时解码；协议对象是现有必需输入分配，不能记为零。每个已接纳 match 的一份元数据对象、请求级 args/output/matches/summary/notices 数组及 Map/Set 仍存在。每 context 记录的应用包装对象、闭包、Promise、controller、临时数组为 0；每次请求创建一次 buffer，成功/失败/取消的 close/finally 清空数组/cache，移除本轮 line/data/error/abort 监听器。close/error 使用 once，避免长期持有 ChildProcess 的调用者继续持有文件 cache。默认路径每 match 不再 await formatBlock。关闭后的格式化异常明确 reject，并执行 finally。

正 context 值取整以传递 rg 的整数行数参数；不更改非正 limit 或精确 limit 误报。rg 的 LF 行号及 BOM UTF-16 转码替代原先错误的单 CR/UTF-8 重读；未加其他编码猜测。保留 --no-config、显式参数、授权消费及 Sandbox 独立路由。输出保留各 match 的独立窗口/重叠重复行，最后一个 limit match 的尾 context 收完再终止。截断结果的 totalBytes/totalLines 现在描述有界处理前缀，不代表被省略的上下文或整个文件。

下游核对：wrapToolDefinition 同步转发；工具结果的 content 只有一个有界 text block。ToolOutputShadowObserver/estimateToolOutputTokens 对该内容单遍估算，不复制全文，原始长度字段仅作观察性遥测；ToolResultPresentation 的 source/model-view owner 按既有预算和释放规则持有该结果，未接收文件全文。renderResult → getTextOutput 的 sanitize/stripAnsi/CR replace，以及 formatGrepResult 的 split/slice/map/join、文件树 Map/数组是保留的既有成本，输入已是 ≤50KB 正文加 notice，不能称为渲染零分配。ToolExecutionComponent 按 result/rendererState 生命周期保留结果与摘要，Text/布局/终端帧沿已有缓存和 release hook 处理；不会持有新增 buffer。相关生产交付/source/TUI 门禁复跑，不将它们写成真实终端性能测量。

边界：一个 JSON 输入记录的 readline/JSON.parse 解码成本仍随最大单行线性增长，2MiB 单行实际覆盖，保存的截断前缀额外拷贝最多 500 code units，避免 sliced-string 保留大 backing store。stderr 的原有错误文本累积、显式 custom 整文件读取、用户指定 match limit 的元数据容量均未声称固定 50KB；没有对象池，也没有默认 whole-file fallback。

## 数值、采样与释放

生产基线 SHA-256 `766908ad44e2879ed842085ea1b96b4059a2f49ae6c93135ef126a7d91dbb2a7`，候选 `efd64db95093120bac67a27313fba3986cb2a3b1440f3c0ba677c0cface3d1b5`。基准 `scripts/bench/grep-context.ts` SHA-256 `5f0e160cacb7d7684257a40a15812793fc6c2efcdba9dab932ecee6b3fb2a46e`。完整数值见 [allocation evidence](../evidence/pi-history-h08-grep-allocation.json)。固定 @vscode/ripgrep 1.18.0 的实际 rg 15.0.0，真实 spawn/管道/公开工具入口，无网络或真实用户配置。

| 同命中片段输入 | 基线 | 候选 |
| --- | --- | --- |
| 524,312 bytes 文件 / context=1 | readFile 1、split 1 / 4,100 行 | readFile 0、split 0；保留 3 行 / 74 bytes |
| 8,388,632 bytes 文件 / context=1 | readFile 1、split 1 / 65,540 行 | readFile 0、split 0；保留 3 行 / 77 bytes |
| 每次搜索采样分配（小文件） | 1,358,253.33 bytes | 135,268 bytes |
| 每次搜索采样分配（大文件） | 19,529,197.33 bytes | 136,830.67 bytes |
| 六次搜索观察到的峰值堆增量（小/大） | 8,225,744 / 90,067,848 bytes | 881,808 / 881,880 bytes |

同机串行，2 次 warmup、6 次采样，HeapProfiler samplingInterval=4096，包含已回收样本；计数 hook 只在 counts/lifecycle 启用，profile 不插桩生产源码，也不额外为大文件计算 byteLength。基线主要栈为 string_decoder.write、replace、split；候选主要为 Node spawn/env、inspector、事件处理。峰值是在 stdout/read/settlement 边界观察，并非连续 OS 峰值；不测 rg 原生内存或宣称 CPU 提速。

大 context=65,537 在同一 8MB 文件解析 65,542 个 JSON 记录 / 21,411,851 个 JSON 字符，仍只保留 **357 行 / 51,299 bytes**；default readFile/split 均 0。小/大固定 context JSON parse 次数从 4→6（额外两行 context），总协议字符分别 939→1,346、945→1,356，扫描按收到的 JSON 线性，不重解析累计输出。格式化 cursor 单调前移，重复窗口仅扫描实际输出至预算。

完整 grep.ts AST：closures 27→28（唯一新增为 close 格式化异常的低频 reject 回调）、function declarations 8→9、regex 0→0、new Promise 1→1、async 6→6、数组字面量 19→22（buffer 三个 owner 数组）、对象字面量 26→26、静态字符串 118→136。onLine、decodeRipgrepText、append/format/clear 的 AST 门禁要求无闭包/await/Promise/new wrapper/数组/spread/regex；只容许既有每 accepted match 的元数据对象。执行入口的共享 Promise、启动 async IIFE、stable lifecycle listeners 和最终完成回调是点名的低频边界。

生命周期保持 tool、4 个 ChildProcess 和 4 个 signal 存活，成功/真实 regex error/收到 match 后 abort/收到 match 后注入 transport error，后两种共 2 次明确 post-match 故障。8 次事件循环/受控 GC 后，候选 buffer/cache 的 **8 个 WeakRef 全释放**、所有管道 destroyed、abort listeners=[0,0,0,0]。同夹具基线观察到 5 个 cache/line-array 引用均仍存活；不把退出 fixture 当作释放证据。各 fixture root 在 child/管道结束后按 owned identity 清理。

## 验收命令与状态

`node --experimental-strip-types --test tests/grep-context-stream.test.ts tests/grep-context-allocation.test.ts tests/grep-config-isolation.test.ts tests/source-invariants.test.ts tests/stream-hot-paths.test.ts tests/tool-renderer-source-invariants.test.ts tests/tool-output-shadow-production.test.ts tests/tool-result-presentation-source-invariants.test.ts tests/tui-hot-paths.test.ts`：**60 通过**。`npm run check`、离线构建通过。

基准：`node --expose-gc --experimental-strip-types scripts/bench/grep-context.ts counts|profile|lifecycle 4096|65536`；宽窗口加第四参数 65537。基线源码取固定 base commit 的 grep.ts 放入本任务 owned root，设置仅 child 的 GREP_BASELINE_PATH，loader 保持原模块 URL/依赖；候选不设该变量。均先设置 TMP/TEMP/TMPDIR 并验证。

## 合并与资源回执

最终 head `0dd41d71eab0ba1739460b5140439c1e51a429f8`，[首次审查](https://github.com/dragonbaba/super-pi/pull/207#issuecomment-6624773610) completed/no findings，未解决线程为 0；[CI](https://github.com/dragonbaba/super-pi/actions/runs/41789347235) 六分片全部 success。2026-11-04 07:08:26 UTC squash merge `3064ce9211b09458bc2d99a4751f87a9dda4f0e6`，main 快进同步，远端/本地 `codex/h08-grep-context` 按精确 head 删除。

登记子进程全部退出，正式证据保存后核对根/父目录/全部资源的 resolved path 与 reparse 边界，按登记路径删除日志、缓存、基线副本、runner/PR 文本，最后清单与空任务根。任务根已验证不存在；共享父目录和其他任务根未动。[准备回执](https://github.com/dragonbaba/super-pi/pull/207#issuecomment-6624872904)、[完成回执](https://github.com/dragonbaba/super-pi/pull/207#issuecomment-6624878927)。
