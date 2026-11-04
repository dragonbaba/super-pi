# PF02-B 默认扩展启动验证

日期：2026-11-05。测量基线 `0a4191e9bde5e97714674d8b048a7e91327bb1f8`，独立分支 `codex/perf-pf02-bundled`。验证前置 [PF02-V / PR #218](https://github.com/dragonbaba/super-pi/pull/218) 已合并，PR base 更新到 `039134566b4ec78efcea8692d0267aee793608a4`；前置仅修改测试/文档，生产测量基线不变。状态：本地主目标、兼容性、负对照、分配及最终完整检查通过，待独立 PR 的当前 head reviewer 和六分片 CI。原始样本、源码/构建哈希、计数、进程与复现脚本见[PF02-B 证据](../evidence/performance-pf02-bundled-2026-11-05.json)。

## 成本来源与先行门禁

生产链为 source launcher → CLI/main → resource loader → `loadExtensions` → `loadExtensionModule` → `loadCreateJiti` → 扩展 factory → session_start → 首条输入 ACK。当前 Jiti 2.7.0 的 `jiti/static` 无条件导入 Babel；包内注释明确此入口供 Bun 编译打包 Babel 使用。Node 的 `jiti` 入口在真正转译时才加载 Babel。候选仅切换 Node 入口，Bun 仍保留 static；不改变模块缓存关闭、别名、虚拟模块、扩展顺序、信任或失效规则。

先行基线诊断为隔离 HOME、生产 source launcher、管道 TTY、任务内 Jiti 缓存，2 正式样本/格、1 预热，不能作为正式性能结论。默认 bundled ACK p95：冷缓存 2694.23 ms、暖缓存 1316.24 ms；暖缓存 createAgentSessionRuntime 约 729 ms，最早 memory 扩展 module import 约 70 ms。两种缓存均加载 Babel。冷缓存指独立空 Jiti 转译缓存，不声称清空操作系统文件缓存。

在候选比较前固定验收：

- 暖缓存默认 bundled 的 Jiti 工厂入口加载阶段 p95 至少降低 50%，Babel 加载次数由 1 降至 0；默认输入 ACK p95 至少降低 3%，且超过基线独立批次 p95 波动带。阈值针对约 70 ms 的早期模块导入成本，不使用 PF02-A 的版本收益替代。
- 端到端比较至少 5 个独立驱动批次、每批 6 个正式进程/侧；同批反转执行顺序，使用相同预加载和任务缓存策略。冷缓存、minimal、fullscreen 作为负对照；重复退化超过 `max(5%, 基线波动带)` 阻止合并。基线波动带超过 10% 时先定位，不靠追加相同采样稀释。
- 分别报告首个实际默认命令、首个默认工具、首个未缓存 TypeScript 转译/重载；同时报告输入后成本与启动到完成的总成本，不能隐去延迟加载带来的首次使用成本。没有在线模型调用时明确保留该外部边界。
- 源码 TS、built Node、Bun 分支的入口选择、别名和虚拟模块身份、并发加载、依赖编辑后重载、失败重试，以及启动失败/取消清理通过。Bun 实际编译缺少环境时保留 V，不将分支测试冒充编译验收。
- 修改仅属低频启动/重载生命周期，审计完整调用链；不得增加每个扩展/事件闭包、正则、Promise 链或全局无界缓存。记录加载/工厂/转译次数、分配及进程释放。

## 测量隔离

任务根为 `.task-tmp/pf02-bundled-Tfkp8k`。`TMP/TEMP/TMPDIR`、HOME、agent 配置均隔离；真实子进程校验临时目录并记录 PID、退出、终端恢复。Jiti 的 `JITI_FS_CACHE` 环境变量是布尔开关，不能用作目录配置。仓库已有 `node_modules/.cache/jiti` 不属本任务，不清理它。

测量专用 `registerHooks` 适配器向两种 Jiti 工厂同样注入 `opts.fsCache`，指向任务内缓存；不修改安装依赖。已通过真实 TS 导入确认 `jiti.options.fsCache` 与任务目录一致、`moduleCache:false` 不变。后续原始数据、适配器和复现脚本归档后按资源清单清理。

## 实施与调用链审计

生产改动只有 `loadCreateJiti()` 的入口选择及说明：Node 使用 `jiti`，Bun 编译产物仍使用 `jiti/static`。原有同进程 `createJitiPromise` 继续只初始化一次；`.then` 回调仍为原有的启动生命周期分配，没有增加每扩展闭包、正则、缓存或池。Babel 内部的 lazy transform 属 Jiti 自带实现，第一次实际转译后随模块保留至进程退出。

已核对 resource loader 的 trust bootstrap、资源合并与 reload → `loadExtensionsInternal` → cache token → `loadExtensionModule` → Jiti → `initializeExtension` → API commit/discard → 返回 runtime。别名/virtualModules、`moduleCache:false`、按 cwd/generation 缓存 factory、clear/reload、失败回滚和 runtime invalidate/dispose 均未修改。原有启动路径的数组、Map、扩展 API 回调及运行时释放 Promise 仍存在，不能将本次一行变化描述为整条启动链零分配；TUI/事件/进度热路径没有变化。

## 主目标结果

五个独立驱动批次，每侧每批 2 预热、6 正式进程；共每侧 30 正式样本。先行原始 loader 快照与候选只有入口表达式差异，两侧通过相同 loader hook 选择实现、设置缓存目录和记录首次 Jiti 等待；其余正式 source launcher、构建产物与资源一致。不是无预加载的原生终端计时，原生体验仍由 PF08 验收。

| 指标 | 基线 | 候选 |
| --- | --- | --- |
| 默认 bundled / regular / 暖缓存 ACK p50 | 1313.78 ms | 1283.15 ms |
| 30 样本合并 p95（主指标） | 1346.96 ms | 1302.13 ms |
| 五批次 p95 中位数 | 1335.08 ms | 1297.28 ms |
| 批次 p95 波动带 | 1.32% | 0.58% |
| 首次 Jiti 入口等待 p95 | 50.27 ms | 5.47 ms |
| 每进程 Babel 加载次数 | 1 | 0 |
| 每进程 Jiti 工厂调用次数 | 25 | 25 |

主指标改善 3.33%，超过 3% 门槛及基线波动；阶段改善约 89.1%。五批次 p95 中位数改善 2.83%，不声称每一批都超过 3%，不承诺秒级收益。所有慢样本保留。冷缓存仍须转译，收益另看负对照，不能把暖缓存结果泛化为首次安装。

## 非目标与首次使用

两组独立对照，各格每侧 1 预热、6 正式进程，涵盖 minimal/bundled × regular/fullscreen × 冷/暖 Jiti 缓存。八种路径均未出现超过 `max(5%, 基线批次带)` 的重复启动退化；基线 ACK 批次带最大为 4.18%。默认 cold/fullscreen 的候选 p95 分别增加 0.08%、1.30%；其他路径均下降。完整样本含关闭耗时一起保留；关闭仍有离群值，不能由这组启动控制宣称绝对退出计时稳定或改善，继续 PF07。

首次使用走真实输入的 `/aux-vision status` 命令，随后测试命令调用生产 `read` 工具读取本任务文件，再经真实 extension loader 加载新的、未缓存的 TypeScript enum 扩展。读取是生产工具直接调用，不是完整模型派发；未发起在线 provider 请求。两侧相同夹具都检查通知、读取内容、扩展 factory 结果、runtime dispose、终端恢复及进程退出。

| 两个独立窗口，各侧各 6 样本 | 基线 p95 | 候选 p95 |
| --- | --- | --- |
| 默认命令通知，第 1 / 2 组 | 31.20 / 27.22 ms | 32.69 / 31.34 ms |
| 本地 read，第 1 / 2 组 | 1.84 / 1.98 ms | 1.88 / 1.94 ms |
| 首次未缓存 TS 转译，第 1 / 2 组 | 19.03 / 18.92 ms | 58.44 / 62.04 ms |
| 启动到以上操作全部完成，第 1 / 2 组 | 1375.46 / 1388.94 ms | 1376.60 / 1397.76 ms |

默认命令与 read 前后，候选 Babel 加载计数仍为 0；首次未缓存 TS 转译后才变为 1。冷转译约 40 ms 的成本被推迟，**没有消失**；两个完整首用窗口总时延分别增加 0.08%、0.64%。默认命令的通知计时包含终端帧交付，基线两窗口 p95 带约 14.6%，不足以给该短阶段做稳定性或提速结论；没有重复超过其波动带的退化。这里只报告完整首用总成本与编译器加载位置，原生终端首次输入和真实模型/工具派发仍保留 PF08 外部边界。

## 分配、释放与兼容性

三个独立驱动批次，每侧每批 1 预热、2 正式进程，单独执行 HeapProfiler 4096-byte 采样（含已 GC 对象）。该数据覆盖启动、ACK 和退出，不用其受探针影响的时间作为主计时。

| 每侧 6 个正式样本的中位数 | 基线 | 候选 |
| --- | --- | --- |
| 采样分配 | 572,705,408 bytes | 558,423,072 bytes |
| 初始堆到退出前受控 GC 后的堆差 | 128,343,792 bytes | 123,938,424 bytes |
| 进程峰值 RSS | 392,888 KiB | 378,204 KiB |
| loader 记录 / 唯一 URL | 2145 / 1997 | 2129 / 1996 |

采样分配约下降 2.5%；loader 记录不等于唯一业务模块。两侧退出前均有三个 stdio PipeWrap 和一个 FSEventWrap，随后真实进程全部关闭。FSEventWrap 的存在本身不能区分待完成的异步 close 与未释放 owner，继续 PF07 核验；不宣称退出前零句柄或长期交互无泄漏。测试夹具的独立 Git watcher 泄漏已由 PF02-V 定位并修复，不把该修复计入本项性能收益。

新增源码 TS / built Node 的行为测试覆盖普通原生扩展不加载 Babel、冷 TS 转译、跨进程暖缓存、并发 factory 加载、依赖编辑后重载；原有 alias/virtualModules 身份与失败重试继续通过。真实 Bun 1.4.0 的编译可执行文件和 `bun run` 均成功转译无缓存 enum 夹具，分别走 static / 普通入口；夹具直接抽取生产选择函数及 config 检测表达式。这证明分支的编译器可用性，不冒充完整 Super Pi Bun 二进制打包验收。

最终 `npm run check` 通过，离线构建 12/12 包、7061 ms、并发峰值 2；`npm test -- --keep-going` 全部 441 个执行单元 exit 0。扫描 AST 确认 `loadCreateJiti` 仍只有原有一次初始化的 arrow 回调，function expression/new expression/正则/数组与对象字面量均为 0。构建函数与计时候选去除注释/空白后严格相同；其余生产调用链没有 diff。完整检查包含现有 source/AST 热路径门禁，本项没有引入新的热路径或池。

曾误直接调用受 npm 环境约束的 `scripts/build.mjs`，被入口正确拒绝，随后使用正式 npm 入口成功；该失败原样归档。初次完整检查发现的旧夹具问题已由 PF02-V 独立完成审查/合并，最终检查未跳过这些文件。等待审查期间无采样/测试进程在后台运行；正式证据已保存，任务根保留至 PR 完成精确清理。原生终端、真实 provider 首请求及 PF07 关闭边界仍明确未完成，不将本项写成整轮验收完成。
