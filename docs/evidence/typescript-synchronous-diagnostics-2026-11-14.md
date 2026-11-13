# TypeScript 同步诊断：等价性与真实服务器测量

日期：2026-11-14。基于 main `53e2a4fc5beec203888881db697ae06d882eb93e`，Windows、Node 26.13.0、typescript-language-server 5.3.0、TypeScript 5.9.3。没有提高 tsserver 堆上限。以下是真实生产 client/pool/runner 测量，不进入日常 CI。

## 问题与先行门槛

发布路径即使已经收到空报告，也要等待显式 30 秒观察窗口。88 个文件在最多 16 个打开文档的滑动调度下约需 180 秒。项目就绪及 geterr 的 requestCompleted 都不能证明诊断最终完成。

在改生产代码之前，冻结 main 与文件内容，对现有发布路径（waitMs=30000、timeout=45000）和逐文件打开→三个同步请求→关闭的探针逐文件比较起止行列、代码、严重级别、消息，保留重复项，不去重。冷、热两组均为 **88/88 确认、6 条诊断，集合完全一致**，同步请求失败 0 次。发布冷/热 180.054/180.086 秒；同步探针冷/热 38.577/28.401 秒。门槛通过后才开始实现。

88 文件由合并的 #296–#298 变更生成：72 TS、13 MJS、3 JS。规范化相对路径 JSON 的 SHA-256 为 `2660ead41d27c768939b5c335224ac602ae0d0a6cc97e2666ecef6bc5f2ff6f6`，与旧记录清单相同。每次探针记录各文件内容哈希，并验证前后一致。最终候选的内容清单哈希为 `aa2aad017de84d02af6b5dc78a1e27ea7a0205e4bc964f87486c856f5aa5ad34`。

### 历史 11 条为何变成 6 条

#299 `b352b766a4ebeabc79ff63663a8a0e8fc538714e` 删除五个未使用符号：worker 的 lstat、captureTreeIdentity、sameIdentity，file-result-store 的 proofRequestHash，file-batch 的 MutationStatus。生产服务器反事实探针只在打开文档的缓冲区恢复这五处（不写源文件）：这三个文件从 0 条恢复为恰好 **5 条 TS6133 提示**，名称逐一对应。因此历史差额来自代码清理。

当前保留的六条都是提示：calculateContextTokens、id、dirname、signal 的 TS6133，以及 mxc-process 的两条 TS80007。在本清单上未发现 region 语义、配置文件诊断或去重导致的两路径差异；这不代表已覆盖所有 TypeScript 项目形态。

### geterr 屏障已否决

本机 TypeScript 5.9.3 的 MultistepOperation.startNew 先完成上一轮 geterr；语言服务器 didOpen 会取消并重发 geterr，桥接又丢弃 requestCompleted.performanceData。取消轮次也能发完成事件，因此不能拿它当诊断完成证明。本实现使用三个有响应的同步请求，没有实现 geterr 屏障。此前建议见[历史发布路径证据](post-review-lsp-diagnostics-2026-11-14.md)，现以本结论替代。

## 实现与失败语义

- 适配器声明可选的同步能力（命令、三个请求名、并发度）；只有 TypeScript 路由声明。runner 不判断服务器名。initialize 必须实际公布 typescript.tsserverRequest，否则保留现有 publish/pull，并返回 command_not_advertised。
- 每个文件依次调用 syntacticDiagnosticsSync、semanticDiagnosticsSync、suggestionDiagnosticsSync，全部成功且有完整数组才确认。独立纯转换模块处理 1→0 基位置、与 TLS 相同的严重级别、source/code、相关信息、unnecessary/deprecated 标记，不改变输入或去重。
- 单请求失败/超时只让该文件未确认，保留其他文件结果；不重试、不转回发布窗口补救。服务器退出仍 failed，列出未确认后缀；沿用共享诊断轮次、排队取消和活动取消语义。
- 同步结果保留 initialization.diagnostics.ignoredCodes。真实服务器审查复现：agent-session.ts 不配置忽略时 publish/sync 均 1 条 TS6133；配置 [6133] 时修正前为 0/1，修正后为 0/0，全部确认。转换按 TLS 的严格代码成员判断过滤；另有非匹配代码、配置改变后的下一调用对照，不修改通知处理。
- 结果给出 diagnosticPath、每文件耗时、实际打开峰值。sync-request 的 effectiveWaitMs 为 not_applicable，outcomes 不输出就绪字段。publish 的 waitMs 仍为首份报告观察窗口，pull 仍为首份报告请求超时；sync 忽略 waitMs，每个请求只受当前全局 timeout 约束。复用 client 后调大全局 timeout 也生效。
- 通知接收与等待者回调路径未改动；新增分配仅属于显式文件/请求设置，不新增每通知回调、Promise、定时器或包装对象，因此按契约跳过额外分配基准。既有相关测试中的源码不变量和 VM 分配/生命周期检查仍通过。

## 并发选择

使用同一代码、同一 88 文件、相同配置；每个并发度新建 pool 跑冷项目，再复用同一服务器跑热项目。每行两次均确认 88/88、6 条诊断；打开峰值分别为 1/4/16，最终打开数为 0。

| 并发 | 冷/热总秒数 | semantic tsserver RSS 峰值 MiB（冷/热） | 全部 tsserver RSS 峰值 MiB（冷/热） |
| --- | --- | --- | --- |
| 1 | 30.292 / 29.477 | 2919.0 / 3140.5 | 3114.1 / 3344.2 |
| 4 | 30.927 / 29.726 | 3332.8 / 3008.7 | 3534.1 / 3218.6 |
| 16 | 30.971 / 32.182 | 3838.1 / 4103.0 | 4068.5 / 4259.6 |

4 和 16 没有同时在耗时、内存上不劣于 1，因此选择 **1**。请求调度仍使用既有 slot 和共享 DIAGNOSTIC_BATCH_SIZE=16 上限。矩阵之后修正了“复用 client 仍用初始较小 timeout”及忽略码兼容问题；矩阵两 timeout 均为 45000，配置未忽略本清单任何诊断，对照条件未变。最终候选另外完整重跑如下。

## 最终同代码对照

冻结生产源码与探针后，两路径均在同一候选、同一清单和配置上重跑。每次均 **88/88 确认、6 条诊断、0 请求失败**；冷、热逐文件集合再次完全相同。没有通过减少覆盖换取耗时下降。

| 路径 | 冷/热总秒数 | 打开峰值 | semantic RSS MiB（冷/热） | semantic heapUsed MiB（冷/热） | 全部 tsserver RSS MiB（冷/热） |
| --- | --- | --- | --- | --- | --- |
| publish，30 秒窗口 | 180.199 / 180.059 | 16 | 3989.3 / 4051.2 | 3703.3 / 3750.4 | 4167.9 / 4266.1 |
| sync-request | 30.330 / 29.164 | 1 | 2919.0 / 3150.2 | 2484.2 / 2550.9 | 3115.0 / 3353.2 |

内存来自仅注入所建服务器子进程的 100ms RSS/heapUsed 采样，表中是采样峰值而非操作系统瞬时精确峰值；全部 RSS 为语法与语义 tsserver 的采样合计。冷表示新语言服务器，不表示清空 OS 文件缓存；热表示同 pool/server 的下一次调用。每组结束释放 lease、关闭 pool；文件关闭计数与打开计数一致，没有保留打开文档。最终探针也记录每文件耗时与逻辑 batch 的起止跨度。

## 验证与重跑

- 可控假服务器新增 14/14 通过：能力开关及对照、完整三请求、转换及忽略码、失败隔离/下一调用、全局超时及调大后复用、退出、取消、并发上限/排队取消。
- 最小相关回归 64/64 通过；首轮离线构建后相关回归 31/31 通过，忽略码修正后重新构建并完整测试。
- npm run check、LSP typecheck、探针单独 strict typecheck 通过；build:offline 12/12 通过。真实 LSP 检查变更的 9 个 TS 文件：9/9 确认，0 诊断。
- 首次 npm test 在未改动的 host-file-permissions 选择器测试中遇到轮询时序失败（固定 1000 次让步后未见 UI），该文件单独重跑 9/9 通过。随后使用原有 npm test -- --keep-going 完整重跑通过；忽略码修正后再次完整重跑：461/461 单元退出成功，共 6168 项，6052 通过、116 按既有条件跳过、0 失败。没有修改权限预检、测试入口或调度。PR 的原有六个 CI job 以最终 head 的结果为准。

在任务分支根目录运行 PowerShell，输出和子进程临时文件放本次专属目录；不要复用其他任务目录：

```powershell
$probeRoot = Join-Path (Get-Location) ('.task-tmp/typescript-sync-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $probeRoot | Out-Null
$env:TMP=$probeRoot; $env:TEMP=$probeRoot; $env:TMPDIR=$probeRoot
$files = @(git diff --name-only --diff-filter=ACMR 'f6fe77936^..3e8b2f5a1' -- packages | Where-Object {
  $_ -match '\.(ts|mjs|js)$' -and $_ -notmatch '\.d\.ts$|(^|/)(test|tests|fixtures|scripts)/' -and (Test-Path -LiteralPath $_)
})
if ($files.Count -ne 88) { throw 'The historical cohort changed; inspect it before comparing.' }
$files | ConvertTo-Json | Set-Content -LiteralPath "$probeRoot/cohort.json" -Encoding utf8NoBOM
node --experimental-strip-types scripts/bench/lsp-typescript-diagnostics.ts --paths "$probeRoot/cohort.json" --output "$probeRoot/equivalence" --mode both --concurrency 1
node --experimental-strip-types scripts/bench/lsp-typescript-diagnostics.ts --paths "$probeRoot/cohort.json" --output "$probeRoot/concurrency" --mode sync-request --concurrency 1,4,16
node --experimental-strip-types --test tests/lsp-sync-diagnostics.test.ts tests/lsp-diagnostic-results.test.ts tests/lsp-diagnostic-batches.test.ts tests/lsp-validation-scope.test.ts tests/lsp-collection-hot-paths.test.mjs
npm run check
npm run typecheck --workspace packages/lsp
npm run build:offline
npm test
```

探针需要本机已安装并配置支持该命令的 TypeScript 服务器；不安装或修改个人配置。results.json 保留路径选择、逐文件结果、每批耗时和内存，equivalence.json 给出冷/热比较；不完整或不等价时退出非零。真实 88 文件测量脚本在 scripts/bench，日常测试仅运行可控假服务器。
