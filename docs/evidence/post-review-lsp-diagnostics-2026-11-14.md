# LSP 大批量诊断、到期就绪与逐文件失败

日期：2026-11-14。原始main基线 `3e8b2f5a150e91292c6bd8d7c883dd054c47d390`；本次修正基线 `b7a5f595222a978b7a284a9828d02872db7acaee`。#302仍叠在尚未合入的#301 `d6b691129d243d20a4004e9a82bea3b5bb7a4110` 上。本次仅修改#302。

## 问题与生产复现

使用生产LspClientPool/runDiagnostics与真实进程协议传输，不以独立重写的算法代替生产路径。

1. 受控服务器didOpen后发项目begin和空报告，20ms后end，不再发诊断。旧候选waitMs1500在1505.893ms后未确认，尽管client当前ready；扩大为5000后仍在5004.254ms未确认。两个到期定时器错误地依赖报告到达时的projectReady快照。
2. 枚举后、读取前删除其中一个文件，旧runner在约11ms抛ENOENT，整次调用没有结构化部分结果。修正读取后进一步用真实注册工具复现：唯一文件读取失败会被工具层覆盖成not_checked，应保留partial。
3. waitMs原说明未明确默认20秒全局timeout与干净push文件等待完整窗口的关系。

原PR的OOM依据保留：一次打开88个源文件约32.7秒后semantic tsserver退出134，stderr报告JavaScript heap out of memory；堆上限4,395,630,592字节，采样heapUsed峰值4,051,017,752、RSS4,327,821,312。改为共享最多16个打开文档，不提高堆限额。200仍是收集上限；调用之间共享FIFO诊断轮次。滑动窗口完成并关闭一项后补一项，取消排队者只移除自身，活动取消和服务器退出语义保留。

## 修正与边界

- client增加一个实例数字projectReadySince，仅在匹配的最后一个项目progress end时记录performance.now；新begin及清理将其归零。诊断通知路径不增加时钟读取、回调、Promise、定时器或包装对象。
- fallbackTimer与overallTimer共用到期判断：存在已识别的项目加载信号时，当前必须ready且连续ready至少共享 `DIAGNOSTIC_PROJECT_READY_MARGIN_MS=4000`，才接受最后一份空报告；仍加载或余量不足均未确认。未知就绪协议保留原窗口行为。没有按ready+800ms提前通过。
- 4000ms依据是此前同88文件观察到ready后空→非空1428–3306ms，余量比最长已见间隔多约694ms。本次同项目、同代加载的晚更新为1164–1619ms，全部11条提示仍被收到。该余量是有界观察策略，不保证未来永不再有诊断。
- 验收按用户明确修订：20ms就绪、5000ms窗口应确认；1500ms窗口应未确认。覆盖下一次加载重置年龄、到期仍加载、迟到非空诊断以及fallback被取消后的overall到期路径。
- outcomes保留 `projectReady`（报告到达时），增加 `projectReadyAtCompletion` 与 `projectReadyForMs`（完成时；window_expired即到期时）。没有报告时receivedReport为false。未确认保留完整路径和原因，不内部重试。
- readBoundedDocument失败只记录该文件为unconfirmed/read_error并继续后续文件。移除重复的全列表stat预检；同一读取函数的常规文件、4MiB、读取期间增长及解码大小校验全部保留。未新增数量上限、命令预检或审批流程。读取失败后的已确认诊断与输入顺序保留；取消仍中止活动调用，服务器退出仍failed。
- schema与README明确：全局timeout默认20秒，waitMs超过20000前应先调高配置timeout；显式waitMs下，干净push诊断文件等满窗口。pull完整报告与非空push静默完成仍保持原行为。

## 同一88文件的热项目实测

Windows x64、Node26.13.0、typescript-language-server5.3.0、TypeScript5.9.3；相同机器，不提高堆上限。88路径为72 TS+13 MJS+3 JS，路径JSON SHA256 `2660ead41d27c768939b5c335224ac602ae0d0a6cc97e2666ecef6bc5f2ff6f6`，limit200。冻结5个运行源文件哈希，前后匹配。先以30000窗口提交全部88文件预热，再复用同一服务器依次测热30000和8000；探针全局请求timeout45000仅通过调用参数设置，不改个人配置。

| 窗口 | 原固定批基线耗时ms | 本次热项目耗时ms | 收到报告 | 按新规则确认 | 未确认原因 |
|---|---:|---:|---:|---:|---|
| 30000 | 180167.120 | 162528.123 | 88/88 | 81/88 | 4仍加载、3余量不足 |
| 8000 | 48151.407 | 48085.617 | 88/88 | 56/88 | 5仍加载、27余量不足 |

两次均收到11条severity4提示、0错误、0警告，打开峰值16，均partial/isError；没有把收到报告当作完整确认，也不据此宣称等价提速。旧固定批基线按旧规则记录88份报告，8000只有8条提示，因此尤其不能拿数量不同的反馈作性能结论。

当前修正前的b7候选热30000为162210.559ms、85确认/11诊断，热8000为48040.040ms、86确认/11诊断。新余量会正确拒绝“报告到达时ready，但到期已重新加载或年龄不足”的空报告，因此确认数可能更低。热30000有3个仅收到就绪前空报告的文件在到期时已连续ready约24412ms，现已正确确认：file-mutation-queue.ts、interactive/components/bounded-selector.ts、selector-loader.ts。预热本身163108.444ms、88报告/81确认/11提示，1仍加载、6余量不足，未当完整通过。

热30000六组 `(开始偏移ms,跨度ms)`：`(13.725,30018.780), (6200.520,53849.682), (31739.712,58315.630), (61750.140,58318.440), (90055.348,60023.008), (120068.590,42459.231)`。

热8000六组：`(14.610,8011.091), (3186.041,12854.232), (9685.722,14366.721), (17691.837,14372.149), (24052.450,16016.817), (32063.994,16021.481)`。组按输入顺序每16条划分，跨度重叠，不是串行屏障，不能求和当总耗时。仍有未确认路径需要调用方显式续查，工具不自动重放。

## 验证与分配

- 四个相关文件48/48通过；最终build后的诊断回归16/16。读取竞态用例保留其余199/200文件且峰值16/最终0；另一用例保留前后两个文件的2条非空诊断，仅缺失文件未确认，下一调用正常。唯一文件读取失败也经真实工具返回partial。原退出、排队取消、活动取消回归保留。
- 根check、LSP typecheck通过；offline build12/12、7447ms，与消费dist测试串行。冻结后的5个变更TS源文件真实LSP全部确认、0诊断，waitMs8000。
- 审计链：stdout稳定回调→帧解析→handleMessage/progress或publish缓存→onPublish→既有settle/到期回调→请求结果→finally释放。每通知新增回调/Promise/定时器/包装对象均0。仅progress end写数字；新结果字段仍由原请求report/outcome拥有。每请求原有定时器数量和至多16个slotPromise不变，没有新增对象池。
- 原源码不变量与分配门禁通过：3000 publish、300 progress，3稳定settle回调/3定时器、peakTimers2；24引用GC后0存活，清理后0timers，采样14,764,480字节，原16MiB阈值未改。服务生命周期14引用GC后0存活。
- 同机等价真实协议fixture（不做语言分析），200个约20KB文件×5：前后1000open/1000close/1000report，峰值16、最终active0，双方22个跟踪引用GC后0存活。旧/新采样80,422,520/79,630,360字节；heap峰值14,447,664/11,301,576，RSS峰值82,141,184/80,076,800，dispose后heap7,765,456/7,769,792；CPU user/system为94000/31000与78000/63000微秒，墙钟275.799/1332.486ms。单次墙钟和CPU波动不作为改善结论，报告完整数字而不筛选结果。
- 全量npm test仍由原有六个CI分片执行；未改workflow、测试runner或旧超时。最终head审查与CI状态见PR。

## 重跑

先把子进程TMP/TEMP/TMPDIR指向当前任务的专属.task-tmp目录；build与测试串行。

```powershell
node --experimental-strip-types --test tests/lsp-diagnostic-results.test.ts tests/lsp-diagnostic-batches.test.ts
npm run check
npm run typecheck --workspace @super-pi/lsp
npm run build:offline
node --experimental-strip-types --test tests/lsp-diagnostic-results.test.ts tests/lsp-diagnostic-batches.test.ts tests/lsp-validation-scope.test.ts tests/lsp-collection-hot-paths.test.mjs
npm test
$paths = @(git diff --name-only --diff-filter=ACMR 19f536e8cde67a9dac76d19b4755b21a61b1a8e1..3e8b2f5a1 -- packages | Where-Object { $_ -match '\.(ts|mjs|js)$' -and $_ -notmatch '\.d\.ts$|(^|/)(test|tests|fixtures|scripts)/' -and (Test-Path -LiteralPath $_) })
$paths.Count # 88
```

生产时间重跑：由本工作树导入adapters.ts/loadRuntime、client-pool.ts/LspClientPool和runner.ts/runDiagnostics，选择已安装typescript适配器，对同一pool先后传 `{root,paths,limit:200,waitMs:30000}` 两次（首个为预热），再传8000；timeout45000。记录外部performance.now差值及返回batches/outcomes/summary/peakOpenDocuments/isError；按协议顺序观察progress begin/end与publish，并区分加载代次，最后shutdownAll。不得把未确认结果改成通过或减少88文件范围。

分配门禁可直接按上述validation-scope和collection-hot-paths命令重跑。额外真实协议对照使用现有lsp-batch-server.mjs的profile-unbounded模式、实际LspClientPool/runDiagnostics，200×5同文件及请求，Inspector采样间隔4096字节，完成shutdownAll后3次受控GC检查WeakRef；前后都记录1000份报告与资源释放，不只计墙钟。
