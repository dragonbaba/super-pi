# MXC 迁移与大项目访问验证（2026-11-10）

基线：`e306949ac3e6314f1075c6a1b1a826e490db421a`。实现分支 `codex/mxc-only-sandbox`。本页记录实现与本地验证；远端审查及 CI 以该分支 PR 的最新提交结果为准。

## 问题与修复

Unity 项目有 164,374 个文件/目录，旧后端在启动 VM 前复制整棵工作区，第 20,001 项 `DefaultSolidNode.cs` 触发本项目设置的门槛。该文件是普通 2,268 B 文件，目标文档为 73,807 B。失败与文件名本身或 Windows 必要容量上限无关。

用户接受共享剪贴板、父目录查询带来的外部目录名/文件名可见性，以及 Git/MSYS 兼容限制；文件内容读取和写入仍受授权限制。本轮未触碰用户剪贴板，不把历史剪贴板失败写成重新复现或已修复。

- MXC 为唯一 Windows 后端，无 VM 或回退选项。固定 `@microsoft/mxc-sdk@1.0.1`，x64 执行器 SHA-256：`090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a`；启动要求 `base-container` 且无需 DACL augmentation。
- 文件和命令直接访问授权工作区，不扫描/复制整项目、不走快照写回。`.git`、`.sp` 只读。`target`、`.venv`、`__pycache__`、`node_modules` 持久保存在项目；D8 私有目录配置退役。失败不回滚已完成修改，不自动重试。
- 沙箱只有 PowerShell 7；不回退 PS5/cmd/Bash/WSL/宿主。宿主工具列表不变，不新增 `exec_command`。固定启动设置只负责本进程执行策略、UTF-8 输出及禁止隐式 WinCompat，不分析或改写用户命令主体。沙箱交互 `!` 不触发宿主 Bash 扩展钩子。
- CodeMode 和子代理共用父授权入口。明确声明 PowerShell 的用户定义可写子代理可调用父 MXC；Bash 不进入沙箱能力列表，PowerShell-only 角色仍受 writer 排他约束。默认只读子代理不会因此得到 shell。
- 网络默认关闭，保留既有联网询问；移除命令路径预检，不增加命令筛选/白名单。配置 clipboard=all、独立 desktop、禁止输入注入；清理等待真实进程族退出，失败禁止复用。
- 删除生产 VM 运行器、打包入口和过期快照/工具链测试；旧 `inputs/writes` 协议移至 `scripts/acceptance/retired-sandbox/`，仅保留历史验收用途，不进入产品构建。构建清理旧 dist 产物。

## 验证

Windows `26300.9711`、Node `26.13.0`、完整 PowerShell 7。真实项目只读，变更及越界试验仅操作任务夹具。

| 检查 | 结果 |
| --- | --- |
| 最终 dist 访问原大项目 | 首次 ls 684 ms，目标文档首行 read 182 ms，PowerShell 原路径及 Node/npm 902 ms；单次观察，不作稳定基准 |
| 实际 MXC 文件/命令 | 只读/读写均通过；附加目录大写授权和请求拼写、非零退出 23、Node/npm、元数据写入拒绝、外部内容拒绝、snapshot 编辑及 .venv 持久化通过 |
| 图片 | 两档 dist 各读主/附加目录，共 4 次，每图 184,140 B，完整字节一致，剩余附件 0 |
| 真实子代理 | 两个只读子进程共享父 owner；可写子进程使用含中文/空格/单引号的 cwd，修改直接保留；暂停终止已运行命令、撤销排队请求，新用户指令可继续；宿主继承、审批、D5 回归通过 |
| 定向测试 | 会话、CodeMode、子代理及热路径等 11 文件：194 通过、1 个 POSIX 专用用例跳过；文件/图片、关闭/排队、schema 和源码约束 6 文件：48/48；工具发现 6/6、网络/路径诊断 6/6 |
| 构建 | 根类型检查通过；离线构建 12/12 包成功；最终大项目调用后 Job handles、child/job/streams 均为 0 |

早期独立 MXC 验收另完成受控入口 6/6、目录查询入口 8/8：外部 junction 读写拒绝，宿主连接阳性对照成立时禁网阻止同一连接，取消真实后代进程后 Job/process handles 归零。联网 UI 由定向测试验证；未进行真实外网请求、剪贴板内容测试或完整 TUI 手工验收。

## 性能证据

审查链：MXC stdout/stderr → 固定字节环 → 单次完成结果 → 现有 CodeMode/交互结果通道；图片为受控读取 → 独立附件 → 有界校验 → 现有图片处理。工具选择、模式切换及历史协议搬迁是冷路径；未改逐帧渲染算法。

- 16,384 个 64 B 分块（1 MiB），保留 32 KiB；分发阶段 Promise、payload Buffer、Buffer 视图和字符串物化均为 0；AST 检查稳定监听器/append 无新增闭包或包装对象。四次 GC 后 owner/input 引用及 data 监听器均为 0。
- 图片 24 次、每次 2 MiB，仅 24 个精确 payload Buffer；四次 GC 后保留 payload 0、磁盘附件 0。
- 队列 1,000 次调用：最大并发 1、残留 reservation 0、请求期间 idle deferred 0，16 个 owner 引用释放。子代理 IPC 1,000 次调用单槽，provider 请求 0、残留 scope 0、16 个任务引用释放。
- 子代理既有真实进度链成功/失败/取消各 2 次协议更新，终止后 timer/live owner 均为 0。没有对象池。

## 兼容限制与来源

启动与容量回归：Windows 首次配置曾生成退役 VM 设置，现改为持久化原生 sandbox-write 并验证首次/再次加载；旧 VM 显式选择仍拒绝。真实 writer 子进程在宿主 PowerShell 缓存为 unavailable 时复现工具丢失，修复后由父能力决定工具选择与可用性，5 次委派调用通过。13,000 余字符脚本复现 ENAMETOOLONG，改用只读受控脚本传输；真实 MXC 两档均验证长中文脚本、非零 23、元数据保护及清理。

搜索完整响应按 32,768 UTF-16 字符预算约束（含路径/分隔符，JSON 最坏每字符 6 B），无需反复序列化结果。长中文路径与 200 个匹配文件的容量回归通过；生产扫描辅助函数 AST 无逐行闭包、数组、对象、Promise。`mxc-search.ts` 16 次扫描：1,104 条保留行、1,120 次有界片段、最大 32,490 字符，扫描内 JSON 物化 0，采样分配 8,352,672 B（含输入与测试观测），四次 GC 后 32 个输入/数组引用存活 0。搜索 owner 的 pending/rows 在 finally 清空；响应只在 worker 出口编码一次。

本机 Git Bash 在 MXC 初始化时报 `NtCreateDirectoryObject: 0xC0000022`、退出 `0xC0000142`；PowerShell → Git → sh.exe 同样复现。git --version 成功不代表完整 Git 支持，测试仓库还出现所有者/工作树识别问题。用户可在宿主模式处理 Git；没有替换第三方库、写全局 Git 配置或自动回退。

微软 [MXC #1061](https://github.com/microsoft/mxc/issues/1061) 仍记录 MSYS 问题。Codex [默认 shell 选择](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/shell-command/src/shell_detect.rs) 优先 PowerShell，不证明已解决 Git Bash；其 [MXC 策略](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/mxc-sandbox/src/policy.rs) 使用 desktop，固定微软依赖 `b21120168d70befe12356411423266bfef168446`，默认 clipboard=None，与本项目的用户授权 clipboard=all 不同。

## 复跑

创建新的 `.task-tmp/<唯一任务标识>/`，在子进程环境将 TMP/TEMP/TMPDIR 指向该目录。真实测试设置 SUPERPI_MXC_LIVE=1、SUPERPI_SANDBOX_LIVE=1、SUPERPI_SANDBOX_WORKSPACE_ACCEPTANCE=1；文件/图片的 dist 验证另设 SUPERPI_SANDBOX_USE_DIST=1。

```text
npm run check
npm run build:offline
node --expose-gc --experimental-strip-types scripts/bench/mxc-search.ts
node --expose-gc --experimental-strip-types --test tests/mxc-process.test.ts tests/mxc-output-hot-paths.test.ts tests/mxc-file-worker.test.ts tests/mxc-workspace-lifecycle.test.ts tests/mxc-toolchains.test.mjs tests/sandbox-image-hot-paths.test.ts tests/sandbox-operation-queue.test.ts tests/source-invariants.test.ts
node --experimental-strip-types --test tests/mxc-workspace-live.test.ts tests/sandbox-image-read-live.test.ts tests/subagent-parent-execution.test.ts
```
