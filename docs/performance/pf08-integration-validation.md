# PF08 集成、文档与交付验证

日期：2026-11-05。累计生产版本 `a8fc80aa5bd03ce5e33a7ac5def010b9c30f521d`，生产树 `293ad784c39d19d315193350c9ee7f73ab6dddd4`。本阶段只更新文档和证据，没有修改生产代码、构建脚本或测试。本文固定本地验收结果；当前 head 的审查、六项 CI、合并和分支/资源清理状态见[本阶段 PR 与收尾回执](https://github.com/dragonbaba/super-pi/pulls?q=is%3Apr+head%3Acodex%2Fperf-pf08-integration)。原始记录及复现脚本见 [PF08 证据](../evidence/performance-pf08-integration-2026-11-05.json)，约束见[总方案](../super-pi-performance-followup-plan.md)。

## 累计版本的组合验收

选择实际会重叠的交互边界，未机械重跑无关笛卡尔积，也未从单次计时宣称新提速：

| 组合 | 观察与验收 |
| --- | --- |
| 5000 条历史 + Markdown 流式更新 + 工具进度 + 连续宽度改变 + 慢 Writable | 三个独立进程，每次 regular/fullscreen 两种模式；各 64 次复杂文本更新、64 次进度、16 次合成 resize，最终 95413 字符与新建组件的渲染逐行一致 |
| 同宽纯文本追加负对照 | 先执行 8 次正常追加，已完成历史重绘和 fullHistoryFallback 均为 0；默认关闭的 overlap 统计沿用既有零扫描回归 |
| 背压与 owner 释放 | 组合中 frame Promise/controller/wrapper/完整副本为 0，queue high water 为 1、pending render request 不超过 1；flush 后队列归零，六轮跨事件循环 GC 后七个 session/UI/frame/message owner 引用均释放 |
| 5000/50000 条完整重放、双 resize、abort | 门控输出期间只有 1 个 active frame、0 个 pending 完整帧、1 个 primitive render intent；flush/abort 后所有队列/终端帧引用和字节归零，无完整副本或 per-frame Promise/controller/wrapper |
| 分支、压缩、重试、凭据代次与前缀诊断 | 60 项定向测试通过，包括增量统计/失效、实际请求响应归因、manifest 单遍计数、生产装配/差异原因、Main viewport 重放 oracle 和工具进度背压 |
| 真实 TTY 功能 | regular/fullscreen 各一组，parent/child stdin/stdout 均为真实 TTY；ACK 得到 12 个活动工具/43 个命令，中文、emoji、组合字符输入逐字一致，退出 0、raw=false、单次 shutdown；观察到括号粘贴恢复，全屏另有 alternate screen/鼠标追踪恢复 |
| 活动工具/VM 退出和完整回归 | 复用同一生产版本的 PF07：完整本地 450 个单元、Linux 2 + Windows 4 六项 CI，以及实际 VM 取消/物理进程释放；本次构建的十二包产物摘要与该版本完全一致 |

组合 fixture 使用真实 Session/InteractiveMode、生产组件、ProcessTerminal 和延迟 Writable，但直接投递事件、合成 resize source；它不是网络 provider 或物理窗口缩放。原生 TTY 检查由操作者通过真实输入驱动，隔离 HOME 中没有 provider 凭据，仅执行两个本地扩展命令，未发起模型请求。不能用这些结果替代在线命中率、原生延迟分布或鼠标选择验收。

## 两次夹具失败与 regular 重放边界

第一版错误地要求组合场景所有 fullHistoryFallback 都为零，regular 下得到 3 次。第二版仅容许宽度改变，遇到既有的屏外活动内容高度改变后重放而失败。未修改产品或吞掉错误：生产 doRender 在尺寸变化时进行完整重放；renderVisibleDocument 对旧窗口之外的变化区间采取保守重放。既有 tui-main-viewport-lifecycle 回归明确要求 active grow/shrink 的此行为。

最终探针逐次记录重放时的尺寸、mutation kind、heightChanged 和区间；只接受尺寸变化或已观察到的 range + heightChanged，仍保留同宽纯追加零重放、最终输出 oracle、队列和分配门禁。三轮 regular 实际为 4/4/3 次重放，fullscreen 为 0。两次失败日志、原版/中间版 fixture 均归档，不覆盖成通过。

regular 组合的最大帧为 1118677 B，fullscreen 为 9541 B。既有完整重放基准中，5000/50000 条历史的首个 resize 帧分别为 1486692/14866692 B。队列有界不等于输出字节少；regular 保留终端 scrollback 的语义仍有这部分成本。基准中的按带宽推算值是估计，不是实测 OS 写入延迟。本轮不为减少字节而删除 scrollback、跳过必要重放或提前退出；若将其作为新优化目标，需要独立兼容性设计与原生终端验收。

## 最终离线构建与 README

在隔离的 PowerShell **7.6.9** 子进程直接执行 **npm run build:offline**，PATH 解析到 `D:\Nodes\26.13.0\npm.ps1`；12/12 包完成，7428 ms、并发峰值 2。随后 `npm run superpi -- --offline --version` 输出 1.0.0，离线 help 正常退出。证据保存 1547 个生产/资源/依赖/构建输入文件的摘要，以及 12 包共 2864 个 dist 文件的分包摘要；十二包均与 PF07 的已验收构建逐包完全一致。版本号本身不用于证明提交新鲜度。

中英文 README 和构建指南统一使用普通 `npm`。若 PowerShell 执行策略拦截安装目录里的 npm.ps1，可改用 npm 自带的 npm.cmd；与在线发布无关，也不需要额外仓库构建包装脚本。README 补充同次前缀计算去重、实际派发归因及共享 Sandbox close 的边界，并保留 CH/长度估计语义及清理 `.task-tmp` 不影响 dist 的说明。

PF08 没有生产修改，本地完整 450 单元、typecheck 和实际 VM 不机械重复；它们对应同一生产版本且 dist 摘要一致。另行执行本阶段的新组合/原生检查、60 项交互定向测试和最终构建；7 份修改文档的 155 个本地链接、代码围栏、命令示例和源/复现哈希核对通过，git diff --check 通过。PR 的六分片仍按现有 CI 执行全部要求。

## 退役核对

- 根构建中重复的串行长命令已在此前构建优化中退役，现用 scripts/build.mjs 的统一依赖调度；仓库没有额外的 .cmd/.ps1 构建包装入口。
- Windows Sandbox volume helper、diagnostic 及测试 .ps1 仍有打包、acceptance 和测试消费者；appcontainer spike 仍被历史设计文档引用，保留各自用途。
- 历史 next-phase-pty-startup 及其 provider/preload 没有当前 package/CI 入口，使用旧配置/接口。其真实工具调用场景不等同本次 command/Unicode smoke，尚未证明完全等效替代；因此保留为历史材料，不列为当前 native 验收。PF00 的重用前核对说明继续有效。
- 本次将当前说明中默认追加 .cmd 的示例统一为 npm，保留 npm 的标准兼容 launcher。没有删除仍有用途的脚本或历史失败证据。

## 本轮交付与剩余验收

| 阶段 | 已交付内容与 PR |
| --- | --- |
| PF00 | 比较协议、基线、任务隔离，[#215](https://github.com/dragonbaba/super-pi/pull/215) |
| PF01 | 长历史宽度计算与有界缓存，[#216](https://github.com/dragonbaba/super-pi/pull/216) |
| PF02 | 快速版本入口、验证前置、默认扩展加载，[#217](https://github.com/dragonbaba/super-pi/pull/217)、[#218](https://github.com/dragonbaba/super-pi/pull/218)、[#219](https://github.com/dragonbaba/super-pi/pull/219) |
| PF03 | 复杂 Markdown 宽度热点，[#220](https://github.com/dragonbaba/super-pi/pull/220) |
| PF04 | 缓存统计口径、请求/响应归因与释放，[#221](https://github.com/dragonbaba/super-pi/pull/221)、[#222](https://github.com/dragonbaba/super-pi/pull/222) |
| PF05 | 增量 footer/长度统计与代次失效，[#223](https://github.com/dragonbaba/super-pi/pull/223) |
| PF06 | 同次 manifest 摘要/规范化去重，[#224](https://github.com/dragonbaba/super-pi/pull/224) |
| PF07 | 并发 Sandbox 清理、活动 VM 和退出阶段验证，[#225](https://github.com/dragonbaba/super-pi/pull/225) |
| PF08 | 本文的累计组合验证、最终离线产物和当前使用说明；审查/CI/合并清理见本阶段 PR 回执 |

本轮本地可执行范围已完成，以下仍保留为限制或外部验收项，不宣称整轮所有环境均已验收：

1. **V：** PF05 孤立纳秒微基准未稳定，实际完成消费者已有对照；PF07 runtime 约 5 ms 短阶段的相对波动带仍为 10.48%，总退出窗口已稳定。未因宽噪声带降低门槛。
2. **E：** 在线 provider 的缓存命中、跨账户/凭据服务端行为、计费和 retention 仍需明确账户/预算及服务端数据；本地前缀稳定不能替代，没有启动付费 cache warming。
3. **E：** 原生终端的连续物理 resize、选择、长期输入和延迟分布仍需对应环境/自动化；本次仅补齐最终累计版本的功能 smoke。
4. **明确保留的设计：** regular scrollback 重放成本、完整 summary/恢复扫描，以及缺少可信版本时不跨请求缓存可变前缀。它们未被伪装为零成本或已优化完成。

任务根 `.task-tmp/pf08-integration-98601e66b8`；测试、TTY、构建 owner 的 PID/时间和文件身份已登记，退出后按精确清单清理。构建产物与共享 `.task-tmp` 父目录保留；不清除其他任务资源。
