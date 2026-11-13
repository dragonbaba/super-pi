# 审核后 LSP 诊断等待与部分完成

日期：2026-11-14。原始基线 `3e8b2f5a150e91292c6bd8d7c883dd054c47d390`；本次等待/调度对照基线 `5bd20d75f30c2805c012a7422ee95cf337909cdb`，已包含原有16文件分批及 #301。#302 依赖尚未合入的 #301 `d6b691129d243d20a4004e9a82bea3b5bb7a4110`，叠在其分支上。

## 问题与生产复现

Windows x64、Node26.13.0、typescript-language-server5.3.0、TypeScript5.9.3，同一机器、未提高堆上限。相同88文件为72 TS + 13 MJS + 3 JS，路径JSON SHA256 `2660ead41d27c768939b5c335224ac602ae0d0a6cc97e2666ecef6bc5f2ff6f6`，显式limit:200。使用实际 LspClientPool/runDiagnostics/Windows进程传输，单个探针依次运行；旁路读取协议进度/诊断与open/close时刻，不改变服务器输出或待诊断范围。冷调用使用新pool，热调用复用同一服务器。个人配置未随探针改写；窗口通过内存适配器或最终waitMs设置。

原PR已复现一次全开88文档的真实V8 OOM：semantic tsserver约32.7秒退出134，stderr为 `Ineffective mark-compacts near heap limit` / `JavaScript heap out of memory`；堆上限4,395,630,592字节，采样heapUsed峰值4,051,017,752、RSS4,327,821,312。原始“22秒”不是固定门槛。本次保留16个同时打开的共享边界，没有提高内存限额或降低88文件覆盖。

**“项目就绪后空报告已最终完成”的前提不成立。** 按协议帧顺序处理项目progress begin/end，真实TypeScript在ready后发空报告，同一调用又变为非空：agent-session.ts冷/热间隔1428/3306ms，file-batch.ts为2799/2855ms。800ms空报告静默确认会丢诊断。项目加载完成与异步语义分析/按诊断类别合并发布不是同一个信号。没有实现该快速路径，也不声称冷启动只需付一次窗口。

替代信号建议：验证适配器的 `typescript.tsserverRequest` 固定 `geterr`、`isAsync:true` 请求对应的 `requestCompleted`，再处理language-server发布防抖/刷新屏障。安装版本具备该桥接入口；它是否覆盖最后一次publish尚未验证，因此未发布为最终性保证。无就绪信号且不发干净报告的服务器继续使用既有窗口。

## 同机时间与调度选择

单位ms；前后均提交同样88条路径，打开峰值均16；只有“全部确认且11条诊断”才用于等价性能比较。后测冻结5个运行源文件哈希，前后匹配。

| 条件 | 固定整批基线 | 滑动窗口候选 | 结果 |
|---|---:|---:|---|
| 冷，30000窗口 | 180117.201 | 163260.165 | 双方88确认/11诊断；减少16857.035ms，约9.36% |
| 热，30000窗口 | 180167.120 | 162210.559 | 候选85确认/11诊断，另3未确认，isError；不能当等价提速 |
| 热，8000窗口 | 48151.407 | 48040.040 | 基线88份报告/8诊断；候选86确认/11诊断，另2未确认，isError；不能作提速比较 |
| 冷，8000窗口 | 40076.235后失败 | 未作为最终对照重跑 | 基线第5批失败，只有前64文件确认，非完整通过 |

最终30000候选冷调用六组的 `(开始偏移,跨度)`：`(13.069,30012.596), (6566.564,53464.163), (31647.278,58395.494), (61662.226,58386.761), (90042.779,60016.200), (120048.989,43209.744)`。

热调用：`(13.750,30007.421), (6241.849,53794.646), (31742.077,58296.465), (61758.565,58294.531), (90038.544,60019.745), (120053.103,42157.282)`。

基线冷六批跨度：`30023.063,30009.426,30013.070,30012.163,30027.793,30013.924`；热六批：`30013.425,30026.638,30022.686,30026.636,30014.906,30010.268`。

8000候选六组 `(开始,跨度)`：`(14.239,8009.020), (6107.838,9916.476), (9568.510,14458.694), (17573.626,14466.766), (24740.172,15313.833), (32156.565,15883.386)`；基线热六批跨度：`8012.012,8018.026,8019.517,8026.822,8022.046,8016.611`；基线冷失败前五批：`8014.744,8012.218,8009.485,8015.980,8008.784`。

滑动窗口的六组按输入顺序每16条划分，组跨度可以重叠，不可相加当串行批次。首次手动同88文件的热滑动试验162047.464ms、88确认/11诊断、峰值16，相对固定热基线有可测收益，因此采用滑动调度；最终热调用的未确认状态仍独立如实报告。

最终热30000未确认为bounded-selector.ts、selector-loader.ts、selector-regex.ts，只收到就绪前空报告。显式单独提交这3条路径续查30147.045ms、3确认/0诊断、峰值3；连同原85条完成88条，总计192357.604ms，不能声称热性能改善。8000的2条未确认路径为memory/src/index.ts和markdown-mutation-lock.ts，显式续查30005.869ms、2确认/0诊断、峰值2；总计78045.909ms。工具没有内部重试。

## 修复与所有权

- waitMs是本次每文件首份报告上限，共享limits常量范围1–120000ms；不传沿用服务器配置，pull默认全局timeout。实际值不超过当前全局timeout及复用client原timeout；pull后的grace与非空静默等待也受剩余全局请求时间封顶。就绪前空报告继续临时；ready本身不使空报告提前通过。
- 每个调用最多16个请求级slot，完成、关闭一个再补一个。client FIFO turn使共享服务器上的诊断调用串行进入完整open/wait/close生命周期；MAX_COLLECTED_FILES=200仍只管收集范围。每文件正文在等待前释放，slot和文件列表在finally释放；错误/取消先排空在途slot再交还turn。
- 输出elapsedMs、batchCount、重叠组的startedMs/跨度、effectiveWaitMs、峰值及每文件outcomes：receivedReport、completion、readiness、耗时。未等到确认返回partial/isError，保留已确认files/diagnostics和完整unconfirmedFiles；服务器退出为failed，未开始后缀也列入待查，不把部分结果当完整通过。
- 生产基线取消排队调用会经pool.discard关闭活动调用的共享server，复现running=false。现在排队项拥有自己的abort监听和可移除队列记录，取消只移除自己并release lease；回归证明活动调用成功、server仍运行、下一调用复用正常。活动调用取消保留原discard语义。

通知热路径已审计完整链：进程stdout→帧解析/消息分派→publish缓存→诊断等待者onPublish→稳定settle回调→runner结果。每条常规通知新增回调/Promise/定时器/包装对象均为0；只原地更新请求拥有的report字段并refresh定时器。settleTimer从首次通知移到请求设置，配置窗口每请求3定时器、未配置2；取消监听、队列Promise和最多16个slotPromise均属显式请求生命周期。无对象池、脚本预检、额外审批或新文件数量上限。

## 验证数字

- 四个相关测试文件44/44：就绪前空报告未确认、ready后迟到非空不提前结束、waitMs/schema/全局封顶、部分结果与定向续查、进程退出、排队取消、逐slot补位、8调用共200文件峰值16/结束0、读取错误/取消后的下一调用。
- 原源码不变量和分配门禁保留：3000 publish/300 progress，3稳定settle回调/3settle定时器，peakTimers2；24引用GC后0存活，清理后0timers，采样14,764,272字节，原16MiB阈值未改；服务生命周期14引用GC后0存活。
- 等价真实协议进程fixture（不做语言分析）：200个约20KB文件×5，前后1000open/1000close/1000report，峰值16、结束0。固定批/最终滑动采样80,599,272/80,826,416字节；heap峰值14,515,384/10,380,824，RSS峰值79,740,928/79,818,752，dispose后heap7,687,560/7,771,824；CPU user/system 94000/62000与62000/46000微秒，墙钟210.022/197.710ms。12/22个被跟踪引用（后者含outcomes/组元数据）GC后均0存活。采样约增加0.28%，不据小样本宣称整体分配或CPU改善。
- 根check、LSP typecheck通过；最终offline build12/12、7126ms，构建与消费dist测试串行。最终5个变更源文件真实LSP收到全部报告、0诊断（waitMs8000）。全量npm test使用原有六个CI分片，不修改workflow、runner或既有超时。

## 重跑

先使用当前任务自己的临时目录设置子进程TMP/TEMP/TMPDIR；build与测试串行。

```powershell
npm run check
npm run typecheck --workspace @super-pi/lsp
npm run build:offline
node --experimental-strip-types --test tests/lsp-diagnostic-batches.test.ts tests/lsp-diagnostic-results.test.ts tests/lsp-validation-scope.test.ts tests/lsp-collection-hot-paths.test.mjs
npm test
$paths = @(git diff --name-only --diff-filter=ACMR 19f536e8cde67a9dac76d19b4755b21a61b1a8e1..3e8b2f5a1 -- packages | Where-Object { $_ -match '\.(ts|mjs|js)$' -and $_ -notmatch '\.d\.ts$|(^|/)(test|tests|fixtures|scripts)/' -and (Test-Path -LiteralPath $_) })
$paths.Count # 88
```

生产时间重跑：把上述路径写入任务临时JSON，由本工作树导入adapters.ts的loadRuntime、client-pool.ts的LspClientPool和runner.ts的runDiagnostics，选择已安装typescript适配器；对新pool及复用pool各传 `{root,paths,limit:200,waitMs:30000}`（timeout45000），另跑8000；记录返回batches/outcomes/peakOpenDocuments/summary/isError和外部performance.now差值。基线无新参数时在内存适配器设置pushDiagnosticsGraceMs，旁路didOpen/didClose计每批时长与峰值。协议旁路按顺序记录progress和publish即可复查ready→empty→nonempty间隔。只对结果unconfirmedFiles显式发后续调用，最后shutdownAll。真实服务器工作量不纳入日常CI；更短窗口及项目加载信号都不是诊断最终性的保证。
