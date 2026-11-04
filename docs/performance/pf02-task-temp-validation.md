# PF02 验证前置：仓库内临时目录的测试隔离与释放

日期：2026-11-05。基线 `0a4191e9bde5e97714674d8b048a7e91327bb1f8`。作为 PF02-B 启动优化的独立验证前置，[PR #218](https://github.com/dragonbaba/super-pi/pull/218) 已交付，不包含 Jiti 生产改动。原始失败、归因探针、最终检查和复现脚本见[PF02-V 证据](../evidence/performance-pf02-task-temp-2026-11-05.json)。

## 已复现问题

本轮按仓库约定将 `TMP/TEMP/TMPDIR` 设置在 `.task-tmp`，并隔离 HOME/agent 配置。初次全套检查暴露四个旧夹具问题；将 loader 替换为基线原文后同样复现，不能归因于 PF02-B 的 Jiti 入口变化。独立前置分支采用较长的任务目录/分支名后，又复现 footer 扫描夹具的宽度假设。

| 夹具 | 原有假设与观察 | 修复 |
| --- | --- | --- |
| mutation-contract-recovery 的缺失 parser | detached 文件仍位于仓库下，`createRequire(import.meta.url).resolve('typescript')` 可沿父目录找到宿主依赖，因此预期拒绝没有发生 | 在夹具自己的 `node_modules/typescript` 设置空 exports，明确构造不可解析的依赖；保留原始 fail-closed 断言 |
| native-file-metadata 的缺失平台 binary | 复制 Koffi、不复制平台包，但其真实 static loader 仍能解析父目录的 `@koromix` 二进制 | 只在复制的 Koffi 内部 shadow 当前平台裸包 specifier；dynamic binary 路径仍为空，保留真实 Koffi 诊断及拒绝修改断言 |
| interactive-control-images | 最后一个用例已通过，但方法级 InteractiveMode 没有 stop；Git 祖先可见时 FooterDataProvider 创建的监视器继续持有进程 | 创建 mode 后立即注册 `t.after(() => mode.stop())`，测试框架等待公开生命周期方法完成 |
| tui-retained-session-rebuild | 仅停 renderer、dispose session，没有释放完整 InteractiveMode 的 FooterDataProvider | 异步等待 `mode.stop()`、runtime dispose，再移除夹具；返回/等待所有清理 Promise |
| alpha-footer-scans | 120 列容纳较长路径、Git 分支名后截断会话名，导致扫描语义断言误报 | 按实际路径/分支可见宽度加固定余量；扫描次数、迭代器结果数、缓存复用与会话名断言均保留 |

两个缺失依赖断言在基线独立子进程中均以 `Missing expected rejection` 复现。两个未退出文件各做基线/候选诊断，共四个进程：全部用例执行到最后后仍存活，12 秒资源快照定位到 `FooterDataProvider.setupGitWatcher` → `InteractiveMode` → 测试 fixture。image 两侧均有 7 个、retained 两侧均有 70 个持有引用的 FSEvent watcher；18 秒诊断上限只终止所创建的进程，结果记为失败。没有修改产品 deadline、生产隔离、断言或测试成功条件。

footer 的独立生产函数对照在同一夹具中证明：120 列确实不包含会话名，按实际路径/分支计算的 358 列则包含；没有修改 footer 截断行为。第一轮前置分支完整测试正常结束，仅该文件失败，随后修正夹具并重新检查。

原全套测试中两个未退出 worker 的 PID、父 PID、创建时间和命令已记录；保留输出后再次核对身份，仅停止对应 worker，让测试父进程自然报告失败。首次身份核对发现 PowerShell 自动将 JSON 时间转换为 DateTime，比较拒绝执行；改用保留字符串的读取后确认身份相同，再执行清理。未广泛扫描或结束猜测进程。

## 范围与验证

只修改五个测试文件和验证文档，不变更运行时生产代码。缺失模块夹具不能依赖系统临时目录恰好位于仓库之外；TUI 夹具必须释放自己创建的完整 owner，即使没有调用 init。没有新增产品缓存、闭包、正则、池或热路径分配，因此不将本项描述为产品性能优化。

定向运行四文件：170 项，148 通过、22 项按既有平台条件跳过、0 失败，进程正常退出。footer 定向 3 项通过。最终 `npm run check` 通过；`npm run build:offline` 12/12 包通过。最终 `npm test -- --keep-going` 的 440 个执行单元全部 exit 0，整套正常退出，未使用强制成功退出参数；平台跳过仍由原用例定义，Linux/Windows 覆盖须以六分片 CI 确认。

同一资源探针复核修复后的两个测试文件：引用中的 Git watcher 分别为 7 → 0、70 → 0；两个进程自然 exit 0。退出阶段仅剩诊断父进程所用的三个 stdio PipeWrap，随后子进程 close；未将 stdio 的存在误写为零资源，也未把强制停止的旧诊断写成成功。该证据只证明测试夹具释放，产品关闭的 PF07 待验证项仍保留。

当前任务根 `.task-tmp/pf02-validation-8c7487f66a`；此前失败与根因证据来自仍由 PF02-B 持有的 `.task-tmp/pf02-bundled-Tfkp8k`。正式证据归档后分别按身份清单清理，不删除另一个仍有后续工作的任务根。首次推送后等待当前 head reviewer；任何新增推送都重新单独 `@codex review`，六个 CI 检查全部成功后才合并、同步 main 和删除对应两端分支。

交付回执：最终 head `8d2d49a7b9435751092a71c647ef80c7776cd202` 的 [review](https://github.com/dragonbaba/super-pi/pull/218#issuecomment-6640869017) 已完成，无未处理发现；[CI 41903205123](https://github.com/dragonbaba/super-pi/actions/runs/41903205123) 六分片首次运行全部成功。合并为 `039134566b4ec78efcea8692d0267aee793608a4`，head/squash tree 同为 `4e4a3cfa7a750a45a34b8cc99239e90315b2d5eb`，已确认进入 main、切回并同步主分支，精确删除两端 `codex/test-task-temp-isolation`。13 个直接进程与两个释放探针子进程完成后，按身份清单移除上述验证根的 339 个资源；共享父目录和 PF02-B 根保留。[合并、分支与资源回执](https://github.com/dragonbaba/super-pi/pull/218#issuecomment-6641077042)。
