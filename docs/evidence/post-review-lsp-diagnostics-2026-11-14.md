# LSP 大批量诊断、到期就绪与逐文件失败

日期：2026-11-14。原始main基线 `3e8b2f5a150e91292c6bd8d7c883dd054c47d390`；本次到期判定修正基线 `14034286e7e3638f1a2e219dca44358c68a17181`，另与 `b7a5f595222a978b7a284a9828d02872db7acaee` 并列对照。#302仍叠在尚未合入的#301 `d6b691129d243d20a4004e9a82bea3b5bb7a4110` 上。本次仅修改#302的到期判定、说明及对应回归。

## 问题与生产复现

使用生产LspClientPool/runDiagnostics与真实进程协议传输，不以独立重写的算法代替生产路径。

1. `1403428` 对所有空报告都要求到期连续ready满4000ms，滑动窗口重新加载会使已经在ready时到达的报告失去确认。生产client/runner受控复现：ready时发最后一份空报告，随后重新begin并保持加载；旧fallback和overall路径分别在约1605/609ms未确认，无observation对照仍按旧规则未确认，修正前3项为2失败/1通过。更早的`b7a5f59`只用到达快照，遗漏了“空报告在ready前到达、之后已连续ready满余量”的情况：5000ms窗口仍在5004.254ms未确认。
2. 枚举后、读取前删除其中一个文件，旧runner在约11ms抛ENOENT，整次调用没有结构化部分结果。修正读取后进一步用真实注册工具复现：唯一文件读取失败会被工具层覆盖成not_checked，应保留partial。
3. waitMs原说明未明确默认20秒全局timeout与干净push文件等待完整窗口的关系。

原PR的OOM依据保留：一次打开88个源文件约32.7秒后semantic tsserver退出134，stderr报告JavaScript heap out of memory；堆上限4,395,630,592字节，采样heapUsed峰值4,051,017,752、RSS4,327,821,312。改为共享最多16个打开文档，不提高堆限额。200仍是收集上限；调用之间共享FIFO诊断轮次。滑动窗口完成并关闭一项后补一项，取消排队者只移除自身，活动取消和服务器退出语义保留。

## 修正与边界

- client增加一个实例数字projectReadySince，仅在匹配的最后一个项目progress end时记录performance.now；新begin及清理将其归零。诊断通知路径不增加时钟读取、回调、Promise、定时器或包装对象。
- fallbackTimer与overallTimer共用到期判断：有observation时，最后一份空报告到达时ready，或到期时当前ready且连续ready至少共享 `DIAGNOSTIC_PROJECT_READY_MARGIN_MS=4000`，满足任一条件即接受。两者都不满足才未确认；无observation调用及未知就绪协议保留既有行为。本次只给共用helper传入现有observation并加布尔OR，没有修改通知路径、窗口长度或调度，没有按ready+800ms提前通过。
- 4000ms依据是此前同88文件观察到ready后空→非空1428–3306ms，余量比最长已见间隔多约694ms；`1403428`同项目、同代加载的晚更新为1164–1619ms。该余量只补足报告到达时未ready的情况，是有界观察策略，不保证未来永不再有诊断。
- 回归保留20ms就绪/5000ms窗口确认、就绪前空报告/1500ms窗口未确认、就绪前空报告/到期仍加载未确认、迟到非空诊断。另覆盖ready空报告后重新加载直到到期，fallback和overall均确认，以及无observation对照、下一次加载重置年龄。
- outcomes保留 `projectReady`（报告到达时），增加 `projectReadyAtCompletion` 与 `projectReadyForMs`（完成时；window_expired即到期时）。没有报告时receivedReport为false。未确认保留完整路径和原因，不内部重试。
- readBoundedDocument失败只记录该文件为unconfirmed/read_error并继续后续文件。移除重复的全列表stat预检；同一读取函数的常规文件、4MiB、读取期间增长及解码大小校验全部保留。未新增数量上限、命令预检或审批流程。读取失败后的已确认诊断与输入顺序保留；取消仍中止活动调用，服务器退出仍failed。
- schema与README明确：全局timeout默认20秒，waitMs超过20000前应先调高配置timeout；显式waitMs下，干净push诊断文件等满窗口。pull完整报告与非空push静默完成仍保持原行为。

## 同一88文件的热项目实测

Windows x64、Node26.13.0、typescript-language-server5.3.0、TypeScript5.9.3；相同机器，不提高堆上限。88路径为72 TS+13 MJS+3 JS，路径JSON SHA256 `2660ead41d27c768939b5c335224ac602ae0d0a6cc97e2666ecef6bc5f2ff6f6`，limit200。冻结5个运行源文件哈希，前后匹配。先以30000窗口提交全部88文件预热，再复用同一服务器依次测热30000和8000；探针全局请求timeout45000仅通过调用参数设置，不改个人配置。

| 版本 | 热30000耗时ms | 确认数 | 热8000耗时ms | 确认数 | 两次诊断数 |
|---|---:|---:|---:|---:|---|
| b7a5f59：仅报告到达状态 | 162210.559 | 85/88 | 48040.040 | 86/88 | 11 / 11 |
| 1403428：仅到期连续ready满4000ms | 162528.123 | 81/88 | 48085.617 | 56/88 | 11 / 11 |
| 本次：报告到达ready或到期满余量 | 163589.348 | 88/88 | 48059.555 | 86/88 | 11 / 11 |

三版均提交相同88路径，两窗口各收到88份报告。本次两次均11条severity4提示、0错误、0警告，打开峰值16；热30000没有未确认，热8000仍有2个未确认（memory/src/index.ts、memory/src/store/markdown-mutation-lock.ts），保留partial/isError，不把收到报告当完整确认。本次达到至少85/88和86/88的验收要求；没有把确认规则变化当速度改善。更早固定整批基线为180167.120/48151.407ms，8000只有8条提示，不作为等价诊断覆盖的速度对照。

140版本的确认数下降来自它会否决报告到达ready、到期重新加载或余量不足的报告。本次恢复报告到达ready即可在到期接受，同时保留到期余量补足就绪前报告的分支。预热本身163052.916ms、88报告/88确认/11提示；随后复用该服务器测两个热窗口，未减少文件范围或并发打开限制。

生产outcomes还直接覆盖新增情形：热30000/8000分别有3/4个文件的空报告到达时ready、到期时已重新加载，现按到达状态确认；热30000另有1个报告到达时未ready、到期满足余量后确认。

热30000六组 `(开始偏移ms,跨度ms)`：`(14.111,30012.601), (6156.160,53873.638), (31756.076,58289.120), (61766.987,58292.252), (90045.201,60017.358), (120059.244,43529.718)`。

热8000六组：`(13.578,8008.011), (6181.382,9847.854), (9603.874,14440.933), (17608.022,14450.623), (24758.823,15300.685), (32086.571,15972.734)`。组按输入顺序每16条划分，跨度重叠，不是串行屏障，不能求和当总耗时。仍有未确认路径需要调用方显式续查，工具不自动重放。

## 验证与分配

- 四个相关文件50/50通过；最终build后的诊断回归18/18。读取竞态用例保留其余199/200文件且峰值16/最终0；另一用例保留前后两个文件的2条非空诊断，仅缺失文件未确认，下一调用正常。唯一文件读取失败也经真实工具返回partial。原退出、排队取消、活动取消回归保留，读取及调度实现本次未改。
- 根check、LSP typecheck通过；offline build12/12、7272ms，与消费dist测试串行。真实LSP在88文件探针后另检查5个运行源文件，全部确认、0诊断，waitMs8000；其中包含本次修改的client与工具schema两个TS文件。
- 审计链：stdout稳定回调→帧解析→handleMessage/progress或publish缓存→onPublish→既有settle/到期回调→请求结果→finally释放。每通知新增回调/Promise/定时器/包装对象均0。仅progress end写数字；新结果字段仍由原请求report/outcome拥有。每请求原有定时器数量和至多16个slotPromise不变，没有新增对象池。
- 原源码不变量与分配门禁通过：3000 publish、300 progress，3稳定settle回调/3定时器、peakTimers2；24引用GC后0存活，清理后0timers，采样14,697,272字节，原16MiB阈值未改。服务生命周期14引用GC后0存活。
- 同机等价真实协议fixture（不做语言分析），200个约20KB文件×5：前后1000open/1000close/1000report，峰值16、最终active0，双方22个跟踪引用GC后0存活。140/本次采样79,815,512/79,440,720字节；heap峰值9,963,544/11,187,544，RSS峰值80,289,792/80,502,784，dispose后heap7,761,072/7,769,016；CPU user/system为110000/31000与62000/16000微秒，墙钟464.269/102.051ms。单次墙钟和CPU波动不作为改善结论，报告完整数字而不筛选结果。
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
