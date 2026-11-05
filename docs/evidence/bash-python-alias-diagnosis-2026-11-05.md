# Bash Python 入口与退出码 49 诊断

日期：2026-11-05。仓库提交：`d67a30f0f0e314191e5673f2826dccc769381088`。本次仅诊断，没有修改产品代码、用户/系统 PATH、应用执行别名或工具安装。

## 会话证据

用户指定 session `01a1aa6e-a111-7ba4-a440-96ca81c262ca`，cwd 为 `D:\RMProjects\ModelTest\Image`。仅记录相关调用事实，不复制完整会话或素材内容。

- JSONL 第 25–26 行，06:40:16 UTC：`which python python3 magick convert ffmpeg aseprite 2>&1; python3 -c "import PIL; print(PIL.__version__)" 2>&1` 返回 49。调用使用 `allowFailure:true`，codemode 记录为已处理的子调用失败。
- 第 27–28 行，约两秒后：改用 `python`，成功输出 `PIL 12.1.0`。该组合命令的另一个模块探测被管道接到 head，整体退出 0 不代表每个模块均可导入。
- 第 31–32 行：后续 Python 脚本成功读取目标文件的头信息。
- 会话代码显式 `console.log(r2.content?.[0]?.text)`；聚合结果中保存了打印的完整错误，子调用信息也保存错误摘要/tail。因此重复显示不等于命令重复执行。

## 独立对照

通过当前生产 `getShellConfig()` / `getShellEnv()` 解析到 `D:\Git\bin\bash.exe -c`。Node 26.13.0；外层仅使用 PowerShell 7.6.9。cwd 与会话相同，子进程 TMP/TEMP/TMPDIR 指向本次任务根，真实 Python 的 tempfile.gettempdir() 验证一致。

| 探针 | 观察 |
| --- | --- |
| 原始完整命令 | exit 49 |
| 仅 `python3 -c "import PIL; print(PIL.__version__)"` | exit 49，无 stdout/stderr |
| 直接启动 WindowsApps/python3.exe，同样的 -c 参数 | Windows 原生 exit 9009，无 stdout/stderr |
| `python -c "import sys,PIL; print(sys.executable); print(PIL.__version__)"` | exit 0；C:\Python313\python.exe，Python 3.13.7，Pillow 12.1.0 |
| 对六个名字逐个 `command -v`，单独记录缺失项 | exit 0；python/ffmpeg 可解析，python3 指向 WindowsApps，magick/aseprite 不在当前 PATH，convert 指向 System32 |

9009 % 256 = 49，与 Bash 返回的 8 位状态一致。分号连接时整条命令取末尾 python3 的状态；这次 49 不是 magick/aseprite 缺失造成的。

fsutil reparsepoint query 确认 WindowsApps/python3.exe 的 tag 为 `0x8000001b`，目标为 Microsoft.DesktopAppInstaller 的 PythonRedirector / AppInstallerPythonRedirector.exe；它并非 C:\Python313 的解释器。System32/convert.exe 文件描述为 File System Conversion Utility，并非 ImageMagick。这里没有运行 convert，也没有修改或删除任何别名。

当前宿主进程 PATH 有 65 个非空条目（48 个大小写不敏感的唯一字符串）；系统 PATH 23 项、用户 PATH 37 项，按大小写和尾部分隔符规范化后有 15 项重叠。生产 getShellEnv 后 66 项，仅前置 agent/bin，原有 PATH 保持完整。重复在进入该函数前已存在，不能将本次重复归因为 Super Pi 反复拼接。PATH 包含 WindowsPowerShell/v1.0 目录也不证明执行过 PowerShell 5.1。

源码 `packages/coding-agent/src/core/tools/bash.ts:1144` 对已启动进程的非零 exitCode 使用 `[SHELL_RUNTIME_FAILED]`；这次分类与实际子进程状态相符，不是 shell 启动失败或崩溃。

## 使用结论与边界

当前机器执行 Python/Pillow 使用 `python`，并核对 `sys.executable` 与实际 import。工具发现应先逐项查询，再对所需工具验证身份/版本/最低功能；命令名可解析不等于它是期望工具，也不等于能运行。不要把所有 WindowsApps 条目一律删掉，或擅自把所有 python3 调用改写为另一解释器。

本次未安装 magick/aseprite，仅证明它们不在当前 PATH；未据此断言整台机器没有安装。诊断阶段未修改产品错误分类、全局别名或 PATH。后续提示与预检修复见[会话工具提示记录](session-shell-guidance-2026-11-05.md)；提交、审核与 CI 状态以包含这些记录的 PR 为准。

任务根 `.task-tmp/shell-alias-diagnosis-c947b61d38`。成功探针 owner PID 23128，子进程 PID 41212/30820/41116/12968/16248 均已结束；owner 退出 0。首版诊断脚本因多写一层相对目录而在 import 前失败（工具记录 3d1543、exit 1），修正后才执行上述探针，未将夹具错误归因于产品。临时原始记录只供本次诊断，身份清单验证后清理；本文件保留可复现的命令和结果。
