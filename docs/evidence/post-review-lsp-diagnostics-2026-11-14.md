# 审核后 LSP 大批量诊断修复

日期：2026-11-14；基线：`3e8b2f5a150e91292c6bd8d7c883dd054c47d390`。独立于导航就绪修复，不使用它的新接口。

## 生产复现与根因

Windows x64、Node 26.13.0、typescript-language-server 5.3.0、其配置的 TypeScript 5.9.3。未改变堆上限。以 #296–#298 共同变更的现存源文件为同一集合：72 TS + 13 MJS + 3 JS = 88，路径 JSON 的 SHA256 为 `2660ead41d27c768939b5c335224ac602ae0d0a6cc97e2666ecef6bc5f2ff6f6`。请求显式 limit:200，避免默认 50 的截断。

用原生产 LspClientPool/runDiagnostics，临时 NODE_OPTIONS preload 仅记录进程 pid/ppid/入口 basename/堆上限，给实际 fork 的 tsserver stderr 加文件旁路，并每 500ms 记录其 memoryUsage 与系统空闲内存。不记录任意 argv、环境值或个人配置。每次只运行一个探针；低于 2GiB 系统空闲内存时通过该探针持有的 AbortController/pool shutdown 取消，不猜测或批量杀进程。该外部保护未触发。探针完成/失败后额外观察 30 秒，然后关闭自己的服务族。

- 基线一次打开全部 88 文件：诊断先报 unconfirmed；约启动后 32.7 秒 semantic tsserver 退出 134，language server 退出 1。V8 heap limit 4,395,630,592 字节，采样峰值 heapUsed 4,051,017,752、RSS 4,327,821,312。stderr 的最后 GC 约 4,066.5 MB，明确报告 `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`。这次已复现真实 V8 堆耗尽，原始“22秒”时间没有当作固定门槛。
- 基线手动 16 个一批、同一服务：8000ms 与临时 15000ms grace 均完成前 64/88，再因后续文件未发布诊断失败；服务器仍活着，峰值 heapUsed 分别 2,787,938,600 / 2,494,974,512。两次不是完整通过，不能据此声称全部成功。
- 最终候选单次提交同样 88 文件，内部每批至多 16 个；仅本次临时适配器设置 30000ms grace，180,097ms 收到全部 88 份报告、共 11 条诊断，观察后服务器仍存活，未崩溃。采样峰值 heapUsed 2,944,107,192、RSS 3,206,615,040。此次摘要只保存诊断总数，未保存 severity 明细，因此不把它记作“零错误/警告”。个人配置保持任务指定的 8000，未暗改成 30000。

根因证据支持修复打开/等待方式：原来先打开全部文档，再并行等所有诊断，使服务器在处理关闭通知前承受 88 个打开文档的项目加载/分析压力。分批对照避免同样的 OOM。未声称这是 TypeScript 的全部内存根因，也未通过提高堆上限掩盖问题。

## 修复与所有权

`limits.ts` 的共享 `DIAGNOSTIC_BATCH_SIZE=16` 只控制一次显式诊断请求内的打开/等待/关闭批次；MAX_COLLECTED_FILES=200 仍是原收集上限，不是并发量。每批收到所有报告且服务器仍运行后才累积结果，关闭该批再开下一批。保留输入顺序、原诊断格式与总覆盖；取消、无报告或进程退出会使整个调用失败，已完成批次不会作为完整通过返回。

openedFiles/pending 是调用拥有的 scratch，最多16项，在正常结束、读取错误、诊断错误、取消时由 finally 清空。完整 entries 仍由最终工具结果拥有，最多原收集范围；不持有源文件正文。collectDiagnosticEntry 属于显式调用设置，保留原来每文件诊断 Promise，移除 map 中每项新建的 async 回调。正常协议通知、settle callback、JSON计量与 didClose 诊断缓存失效链未改变。未引入对象池、模型脚本解析、新审批或新的文件数量限制。

## 验证

- 两项初始受控协议回归在基线上为1失败/1通过；分批后通过。最终4项覆盖完整200文件、峰值打开16/最终0、完整批次后部分报告再退出、跨批读取错误/取消，以及失败后的下一次请求。
- 三个相关测试文件32/32通过，包括原协议通知AST不变量与分配/生命周期门禁。原3000次publish仍为3个稳定settle callbacks/3timers、peakTimers2、24个引用GC后0存活、清理后0timers；采样14,130,776字节，原16MiB门槛未变。服务生命周期14个引用GC后0存活。
- 同机等价的手动请求设置分配对照：200个约20KB文件×5次、使用相同立即返回完整空报告的受控client；双方1000opens/1000closes/1000reports/1000outcomes、最终active0。峰值open从200变16；采样28,083,448 / 28,154,096字节，观察heap峰值8,639,968 / 8,337,616，dispose后heap6,775,232 / 6,785,872；RSS峰值66,543,616 / 66,633,728。CPU user/system为15,000/16,000与31,000/16,000微秒，墙钟46.38/2380.25ms；双方12个被跟踪引用GC后0存活。该小样本不支持速度或分配改善结论；证明的是等价输出、并发界和释放，不把失败的88文件基线当性能对照。
- 根 `npm run check`、LSP `npm run typecheck`通过；`npm run build:offline`12/12，7,283ms；之后才跑消费dist的测试。实际生产LSP对runner.ts、limits.ts的诊断为0错误/0警告/0提示。
- 完整根npm test仍由原有六个CI分片执行，不修改workflow、测试runner或旧断言。最终head审查/CI见PR。

## 重跑与限制

```powershell
npm run check
npm run typecheck --workspace @super-pi/lsp
npm run build:offline
node --experimental-strip-types --test tests/lsp-diagnostic-batches.test.ts tests/lsp-validation-scope.test.ts tests/lsp-collection-hot-paths.test.mjs
$paths = @(git diff --name-only --diff-filter=ACMR 19f536e8cde67a9dac76d19b4755b21a61b1a8e1..3e8b2f5a1 -- packages | Where-Object { $_ -match '\.(ts|mjs|js)$' -and $_ -notmatch '\.d\.ts$|(^|/)(test|tests|fixtures|scripts)/' -and (Test-Path -LiteralPath $_) })
$paths.Count # 88
```

真实复现对照应在同一机器、构建过的基线与候选各启动新生产pool，把以上paths与limit:200传给runDiagnostics，分别保留8000/15000/30000的临时grace条件；按上述preload记录实际tsserver stderr和memoryUsage，结束后关闭该pool。30000条件每个空诊断批次会用满既有grace，约3分钟，属于手动真实服务器探针，不纳入CI或日常单元测试。分批不能保证服务器保留项目内存有硬上限；8000仍可能因冷项目超时而失败，这是未确认诊断而不是完整通过。
