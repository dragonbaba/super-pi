# Shell 推测性预检退役与验收

日期：2026-11-05。基于 `d67a30f0f0e314191e5673f2826dccc769381088`，接续[会话诊断与提示修正](session-shell-guidance-2026-11-05.md)。用户要求修复指令预检误拦。原始回归失败、命令、源文件摘要、AST 计数和分配采样见[机器可读证据](shell-precheck-retirement-2026-11-05.json)。

## 依据与根因

[权限方案](../Super%20Pi%20权限简化与原生能力整合方案.md)明确要求命令规则使用已验证的解析与明确匹配，不扩张成通用 Shell/PowerShell 解释器；[生命周期守卫说明](../../packages/extensions/resource-lifecycle-guard/README.md)明确规定解析不确定性本身不构成拒绝。

旧 tool-loop 预检使用 Node 原生路径规则解释 Bash 内部的 `cd`，把 Git Bash `/tmp` 解析为 `D:\tmp`。它只解析命令前缀，会阻止 `cd missing-directory || ...` 的合法恢复；还要求 npm 生命周期命令的直接工作目录存在 package.json，阻止 npm 自身向父级查找项目。两项新真实调用测试在修改前均失败，分别记录了静态 cd 和 npm manifest 的 `WORKDIR_MISMATCH`。

## 修改范围

删除这段推测性硬拦及其 5 个辅助函数、3 个正则、专用常量和不再使用的预检 cwd 参数。保留调用钩子原有的 await 和取消/身份复核顺序。命令内部的路径、复合控制流和包定位交给实际 Bash/npm；没有增加 `/tmp` 特例、工具扫描、进程启动、缓存或对象池。

显式工具 cwd 仍经原生存在性、身份及执行前复核；统一权限、资源生命周期、调用去重、重试容量和真实执行状态保持有效。结构化 rg 的字面参数检查仍保留。实际错误继续显示原命令诊断和退出状态。

同步更新扩展 README 和前一份证据中的后续修复链接。原有四个静态提示文件的修改保留，未在本次变更中再次调整。

## 行为验收

新增测试通过真实 Agent 调度、生命周期守卫、tool-loop 钩子和原生 Bash 后端执行：

| 场景 | 修复后结果 |
| --- | --- |
| `cd /tmp && printf ...` | Bash 自行解析目录，成功且记录 started=true、exit=0 |
| `cd missing-directory || printf ...` | 恢复分支正常执行，exit=0 |
| `cd missing-directory && printf ...` | 保留真实非零退出与目录错误，后续标记未执行 |
| 显式 cwd 指向不存在的目录 | 仍拒绝，命令标记未执行 |
| 子目录中 `npm run verify --silent` | npm 找到父级 package.json，脚本成功执行，无依赖下载 |

8 个相关测试文件共 **134 项：132 通过、2 跳过、0 失败**，覆盖显式 cwd 与身份漂移、权限/生命周期放宽边界、只读 find 兼容性、错误恢复、重复调用及热路径源码约束。跳过项为非 Windows PowerShell 拒绝契约和 Unix uv 可执行链接夹具，本机为 Windows。

## 热路径与生命周期

审计链路：`tool_call` → 有界调用登记 → `prepareDeterministicCall` → 取消/身份复核 → 参数哈希/兄弟去重/重试 → 原生 cwd 与权限、beforeSpawn → 后端执行与 cwd 释放 → `tool_result` 使用已登记摘要 → finish/end/agent_end 清理。

core 中其余 25 个顶层函数内容不变。新增闭包、正则、Promise 构造器和 AbortController 均为 **0**；index 中原有 9 个生命周期/注册回调数量不变。删除两层异步预检辅助函数和 3 处文件探测调用点；保留原有拦截边界的 Promise。没有新增每次调用的数组、包装对象或完整输入字符串副本。

运行既有 `scripts/bench/tool-loop-repeat.ts`，每场景预热 32 次、测量 256 次：

| 场景 | 旧版采样字节/调用 | 修复后采样字节/调用 | 修复后 p95 ms |
| --- | ---: | ---: | ---: |
| 64 B 成功 | 5847.06 | 6348.47 | 0.0189 |
| 1 MiB 成功 | 22909.06 | 21254.38 | 1.2066 |
| 64 B 失败 | 6304.59 | 6377.63 | 0.0235 |

该基准驱动真实守卫钩子，但工具名为 fixture_operation，因此用于核对共享调用链分配与释放，**不用于宣称 Bash 文件探测耗时下降或整体加速**。一次采样存在波动，原始站点、堆数据及旧版时间保存在 JSON。主要采样来自参数哈希分块、钩子及测试驱动。

三场景的确定性计数前后一致：每场景 admission digests=256，结果阶段扫描字节和 digest 均为 **0**。小输入扫描 50688 字节、3584 次 hash update，大输入扫描 536890112 字节、134400 次 hash update；没有新增建议消息。保留 64 组钩子与 32 个重试 ledger 的受控 GC 验证中，288 个观察对象在正常结束、失败、取消及清理后 retainedAfterGc=**0**。既有表容量、所有权和清理边界未变。

## 本地构建与交付状态

在 PowerShell **7.6.9**、Node **26.13.0** 下执行 `npm run check`、`npm run build:offline`、离线 version/help，全部退出 0。最终构建 **12/12 包、7033 ms、peak=2**。扩展由仓库捆绑配置引用，测试直接加载本次修改后的守卫源码。重启 Super Pi 后加载新模块。没有重跑原用户素材会话或调用在线模型。

本次修改和前一轮提示修正已完成本地验收；提交、审核与 CI 状态以包含本记录的 PR 为准。

## 临时资源

任务根为 `.task-tmp/shell-precheck-acd08140cd`。子进程使用任务级 TMP/TEMP/TMPDIR，并通过 Node os.tmpdir() 断言；runner 同时隔离 HOME、用户配置和 npm cache。证据归档后按身份清单检查路径与链接边界，清理结果以 JSON 回执和下方记录为准。

清理回执：24 个登记进程均已结束；648 个资源经身份和链接边界核验后删除，30 个直接子项，cleanup PID 41188。任务根已不存在，共享 .task-tmp 和离线 dist 保留。
