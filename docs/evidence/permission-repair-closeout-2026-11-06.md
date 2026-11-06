# 权限与子代理修复：集成验收与启动测量（2026-11-06）

本记录属于修复计划阶段 F。各阶段必要的真实验证已经在对应 PR 合并前完成；这里汇总仍有效的集成证据，并补齐启动和内存测量。没有新增命令预检、解析规则、筛选矩阵、缓存优化或内存配置。

## 修复范围与集成证据

| 范围 | 最终有效证据 |
| --- | --- |
| 工作区规范化、大小写/短名、失效附加目录、取消/超时与历史拒绝恢复 | A：#232/#233；修复计划阶段 A 的完成记录与现有 `sandbox-workspace-paths`、`native-execution-policy`、`permission-interaction` 用例 |
| 子代理传输预算、stderr、启动报错 | B：#234；受控真实子进程、生产传输分配基准与生命周期验收 |
| 原生外部删除询问、敏感删除拒绝、agent 修改询问 | C1：#235；真实文件副作用、实际 selector、批量与链接身份验证 |
| Shell 接入既有分析结果、普通指令与工作区兼容 | C2：#240；[适配验收](native-shell-result-adapter-2026-11-06.md)，真实 Bash/PowerShell、CodeMode、后台命令、`/tmp`、失败 cd 恢复与 npm 父级查找 |
| D5 停止整轮、在途工作排空、新用户指令恢复 | C3：#241；[暂停验收](external-write-turn-pause-2026-11-06.md)，实际 Agent/CodeMode/后台进程及同会话权限切换 |
| 宿主子代理显式父权限、跨进程询问/拒绝/暂停 | C4.a：#242；[父级通道验收](subagent-parent-execution-2026-11-06.md)，9 个真实 CLI 用例、16 个引用释放 |
| 两档沙箱子代理、同一 VM 队列、附加 cwd、取消与恢复 | C4.b：#243；[父沙箱验收](subagent-parent-sandbox-2026-11-06.md)，3 个真实 CLI+VM 场景，108 通过/1 平台跳过及容量/GC 验证 |
| 沙箱分类、搜索、D7 保留/丢弃、D8 私有目录 | D：#238/#239；[目录一致性](sandbox-directory-consistency-2026-11-06.md)、[恢复与私有目录](sandbox-private-recovery-2026-11-06.md)，实际 VM、写回与宿主私有哨兵验证 |
| 子代理运行中进度与释放 | E：#244；[原生进度验收](subagent-native-progress-2026-11-06.md)，实际生产界面加受控子进程；checkpoint 交接和失败历史重绘反馈复现、修复并补入计划 |

T1–T24 及 A-1/C4-1/C4-2/D-1–D-3/E-1 的分配与实际结果以修复计划及上述记录为准。没有将未支持的 Shell 写法改记为覆盖完成。D9 的 MCP destructiveHint 强制询问继续按用户决定暂缓；既有命令分析只能防误操作，识别限制不转成预检增强任务。

F 额外测量使用的真实 CLI 用例再次验证了三种全局默认下显式 host-write 父权限，以及四个真实父级 read/grep/find/ls 调用；依赖 rg/fd 均可用，4 项通过（含三个子项）。后续 E 只改本地显示，未改变权限、执行通道、队列或沙箱，因此没有重复 A–D 的全部 live 用例或完整本地测试全集。对应 PR 的 CI 按原配置完整执行。

测试维护：C2 复用旧分析器行为测试；D.a 删除失效范围函数及断言；E 两轮审查均扩展已有交接/进度用例。没有为进度组合、命令绕过或性能采样新增 CI 测试矩阵，手动测量不成为每次 CI 的常驻负担。

## VM 启动与 P2

Windows、Node v26.13.0，真实 pinned Windows Sandbox CLI 0.8.107.0。测量基线 `e3d3f1ff90053e64ac728f7a8f421d56ab3f24c6`；复核内存时 HEAD 为 E 的后续显示修订，相关后端与运行器文件未变。独占三文件工作区，额外只读映射已安装的 TypeScript native compiler 目录；不读取用户配置或真实项目内容。

| 明确定义的边界 | 首次测量 ms | 内存复核那次 ms |
| --- | ---: | ---: |
| `SandboxToolchains.validateTrees` | 2587.73 | 2590.72 |
| 工作区输入 capture | 2.21 | 2.26 |
| `SandboxLifecycle.start`（注册，尚不代表首个来宾工作完成） | 1707.23 | 1685.92 |
| `WorkspaceSandboxBackend.start` 全部准备与注册 | 5454.30 | 5522.39 |
| 首次 `invoke(read)`，含来宾首次就绪与实际读取 | 6212.16 | 6246.75 |
| 同 VM 第二次读取 | 666.26 | 659.65 |
| 同 VM 第三次读取 | 643.12 | 622.95 |

首轮 PowerShell PATH 查询的进程等待为 263.61 ms，C# csc 编译等待为 102.50 ms；第二轮分别 260.26/100.75 ms。这些计时有嵌套关系，不能相加当成总耗时。不是 OS 冷缓存实验，也没有测 p95。此前把构建流程约 11 秒称为 VM 冷启动的说法不成立，不使用该数字。

`node.exe` 实际为 100,097,864 bytes；生产代码读取源、写副本、读回校验，对应约 300,293,592 bytes 的逻辑读写，不等同物理磁盘读取。没有单独量出拷贝/哈希 CPU，也没有做缓存 A/B，不能把剩余启动时间归给这一步。当前样本里工具链检查明显高于 csc 编译；尚无足够收益证据支持增加跨会话缓存及其失效/身份复杂度。本轮不做 P2 缓存优化。

## P5：2048 MiB 下的大型 TypeScript 检查负载

使用生产 backend 的 sandbox-write VM，原 `<MemoryInMB>2048</MemoryInMB>` 不变。来宾独占 `target` 内生成 **6000 个模块、192000 个导出函数、22,920,000 bytes 源码**，调用仓库已安装的 native TypeScript compiler，strict/noEmit/ES2022/ESNext。共 6063 个输入（含标准库）、254144 行、2352090 标识符。这是大型编译器检查负载，不是完整应用打包、链接或并行构建。

- 编译退出 0；编译器报告总时间 3.874 s，进程从启动至退出实测 8.094 s；含生成、Shell 与来宾工具链的整次工具调用 13.026 s。不同边界不能混为一个构建耗时。
- 编译器报告 Memory used 2,025,976 K；每 50 ms 读取进程指标，观测峰值工作集 1,157,697,536 bytes、峰值 private commit 2,399,326,208 bytes。采样可能漏过更短峰值。
- 只为厘清内存口径追加一次空载 VM 查询，没有重复构建：来宾可见物理内存 **2046.94 MiB**，总虚拟内存 **3774.94 MiB**。提交量可超过物理内存；上述成功不是“2 GB 内存无压力”的证明。
- 构建源与输出留在 VM 私有 `target`，宿主新增候选为 0；结束 backend vm=false、sourceFiles=0、ownedArtifacts=0。第二次查询也完成相同释放检查。

结论仅限这个可复现负载：本次完成，没有证据要求立即改变默认内存。但已有约 2.23 GiB private commit，不能保证其他大型项目、并行构建或不同宿主压力下够用。实际用户项目出现 OOM/换页退化时，应以该项目数据决定可配置内存或默认值，不能仅凭一次合成成功或 private commit 超过物理内存就调整生产策略。

## 子代理启动与 S5

复用 `tests/subagent-parent-execution.test.ts` 的真实生产 CLI、离线受控 provider 和父级 IPC 通道；三种全局默认依次为未设置、trusted-host、sandbox，父会话均显式 host-write。父进程在 `spawn()` 前记时，监听既有 `child-observation.jsonl` 的文件事件，首次 provider request 表示启动准备已完成。

| 顺序 | spawn → 观察到夹具入口 ms | spawn → 观察到首次 provider request ms | spawn → child close ms |
| --- | ---: | ---: | ---: |
| 1 | 59 | 2421 | 2586 |
| 2 | 60 | 1237 | 1390 |
| 3 | 61 | 1248 | 1396 |

这是父进程观察时间，包含文件通知调度延迟、tsx 源码加载、显式父权限初始化和 CLI 准备；不包含真实模型网络时间，也不能当成 bundled 可执行文件的启动指标。首轮较慢不等同全局模式造成差异。首次探针只拿到 spawn/close：子环境按既有规则没有继承探针的 NODE_OPTIONS；随后改用父进程文件观察，没有放宽子进程环境规则，前次全程耗时不冒充启动耗时。

没有证据支持在此阶段增加持久子代理进程、共享会话或更大的启动缓存；这些会改变生命周期与权限代次，需另有真实需求和测量。

## CodeMode 空闲回收

使用已编译 `CodemodeSandbox`，与应用一致的 `reuseWorker:true, timeoutMode:"active"`，执行 `return 42`：模块导入 2.925 ms，首次 41.028 ms，同 worker 两次 7.937/6.724 ms。实际空闲 **31007.76 ms** 后 started=stopped=1；再次执行 24.039 ms，并确实新建第二个 worker。最终 close 后 active=0、started=stopped=2。

基线 `fe7a2d24cfef5f3c33c3a9e7607d2255e97aa120`，后续 E 未改 CodeMode。首次包含 WASM/worker 初始化；空闲后进程级 WASM 缓存仍在，不是全进程冷启动。最早一次探针误用了库的 one-shot 默认值，计数暴露每次都新建 worker，已改为实际应用配置；不把那组数据当作应用空闲回收测量。单进程四个样本不能代表 p95，本轮没有更改回收策略。

## 稳定复现方法

所有临时脚本与夹具须在按 `AGENTS.md` 登记的独占 `.task-tmp/<task-id>-<unique>/` 中，子进程启动前设置 TMP/TEMP/TMPDIR 并用 `os.tmpdir()` 验证；使用已有 owned helper/任务 runner 记录进程及资源。不要将本次待清理日志路径当作唯一复现入口。

1. 基础集成测试入口见上表链接；真实沙箱使用现有 `SUPERPI_SANDBOX_WORKSPACE_ACCEPTANCE=1` opt-in，不更改 CI 的默认 live 门禁。
2. 启动测量：从仓库根以 `node --import tsx <任务脚本>` 导入 `packages/coding-agent/src/core/sandbox/workspace-backend.ts`，在独占目录写 `marker.txt`、下方生成器和 PowerShell 测量器；创建 `new WorkspaceSandboxBackend(project, ownedArtifacts, "sandbox-write", {settings:{include:[realpath("node_modules/@typescript/typescript-win32-x64/lib")]}})`。用 `performance.now()` 包住 `invoke("read",{path:"marker.txt"})` 三次，再执行 `invoke("powershell",{command:"& ./measure.ps1",timeout:120})`。原型包装只用于手动测量 `start/capture/validateTrees/SandboxLifecycle.start`，必须调用原方法、在 finally 记时，不改变行为。源码 backend 使用 `scripts/acceptance/windows-sandbox-lifecycle.mjs`；编译版本使用打包后的 runtime，不能包装错误模块。最后 `await backend.close()` 并断言 vm/sourceFiles/ownedArtifacts 归零。

生成器 `generate.cjs`（运行于来宾 workspace，不在宿主生成 6000 个源码文件）：

```js
const fs = require("node:fs");
fs.mkdirSync("target/src", { recursive: true });
let bytes = 0;
for (let i = 0; i < 6000; i++) {
  let s = "";
  for (let n = 0; n < 32; n++) s += "export function f" + n +
    "(x:{value:number,label:string}):{result:number,text:string}{return {result:x.value+" + n + ",text:x.label}}\n";
  bytes += Buffer.byteLength(s); fs.writeFileSync("target/src/m" + i + ".ts", s);
}
fs.writeFileSync("target/tsconfig.json", JSON.stringify({ compilerOptions: {
  target: "ES2022", module: "ESNext", strict: true, noEmit: true, skipLibCheck: true
}, include: ["src"] }));
console.log(JSON.stringify({ files: 6000, functions: 192000, sourceBytes: bytes }));
```

`measure.ps1` 先 `node ./generate.cjs`，再通过 `System.Diagnostics.Process` 执行已映射的 `tsc.exe -p target/tsconfig.json --extendedDiagnostics`。本机编译器来宾路径为 `C:\SuperPiToolchains\D\RMProjects\Pi\node_modules\@typescript\typescript-win32-x64\lib\tsc.exe`；其他安装必须使用实际映射。设置 `UseShellExecute=false`、`CreateNoWindow=true`，异步读取 stdout/stderr；每 `WaitForExit(50)` 后 `Refresh()`，取 `PeakWorkingSet64` 和 `PrivateMemorySize64` 的最大值，退出后读取真实 ExitCode、Dispose。内存口径用 `Get-CimInstance Win32_OperatingSystem` 的 TotalVisibleMemorySize/TotalVirtualMemorySize，单位 KiB，除以 1024 为 MiB。不要用总测试时间代替子进程计时。

3. 子代理：运行 `node --import tsx --test --test-name-pattern="real CLI children inherit explicit host mode" tests/subagent-parent-execution.test.ts`。仅在父级测量脚本包住 `child_process.spawn` 并 `syncBuiltinESMExports()`，筛选 argv 的 `subagent-parent-cli.mjs`；在原 spawn 调用前记 Date.now()，用 `fs.watch(options.cwd)` 读取完整换行的既有 observation JSONL，记录 start/profile/runtime/首次 request 和 close 的首次观察时间。每个 child close 时关闭 watcher；保留原 spawn 的参数、环境与返回值，不向子环境注入测量变量、不记录 provider 内容。
4. CodeMode：从 `packages/codemode/dist/runtime/host.js` 导入 `CodemodeSandbox`，创建上述应用选项；依次计时三次 `await owner.execute("return 42")`，真实等待 31000 ms，断言 workersStarted===workersStopped，再执行一次并断言 started 增加 1，最后 close 并断言 active=0、started===stopped。若使用源码/不同选项或少于 30 秒，不能与本文数字直接比较。

## 最终交付门槛

本记录的测量不替代最终主线构建。阶段 F 文档 PR 也须最新提交 reviewer 无剩余有效问题、CI 全通过、合并并清理远端/本地分支。随后在同步后的最终 main 执行 `npm run build:offline`，核对退出状态、12 个构建包及关键产物；保留最终 SHA 与结果，按精确清单清理本任务临时资源。该 PR 的最终验收回执记录实际构建与清理结果；回执出现前不宣称全任务完成。
