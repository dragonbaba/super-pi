# LSP 提示清理、CLI 时序与动态预算断言

日期：2026-11-14。基线 main `d370715a0dfc34972b9bc45a98a422a461cd14ce`，Windows / Node 26.13.0。生产工具行为和原有 CI 工作流、分片、并发、测试入口保持。

## 问题与核实

真实 TypeScript 诊断在五个文件确认六条提示。两个无用导入可直接清理；workspace-tools 的 id 只在两个私有方法间传递。文档缓冲区只删除 perform 参数和调用参数的对照，把 TS6133 从 124 行移到 111 行，因此本次同时清理私有 execute/perform 链，公开工具回调保留 _id 的参数位置。memory 的 signal 属于独立取消修复，不作为无用参数删除。

MxcProcess 的两条 TS80007 不能按文字建议删除 await。正常返回和异常 finally 的受控生产 owner 均必须等物理清理 Promise，完成后才释放 streams/job 并允许下一调用。本次让已有实例 stop 回调返回同一个 coalesced Promise，在两个调用点直接等待，不新增清理任务。

历史 main 的 Windows 3/4 失败：`53e2a4fc5` 的 RPC 看门狗触发，清理回执已完成；`b1ee66e3c` 的 MCP spawnSync 报 ETIMEDOUT。分别见 [RPC 日志](https://github.com/dragonbaba/super-pi/actions/runs/43501057994)、[MCP 日志](https://github.com/dragonbaba/super-pi/actions/runs/43499358407)。这证明测试期限被触发，没有足够阶段信息证明唯一原因是宿主机器慢；整段用例耗时也不能直接当作就绪后的关闭耗时。

另一个真实 CI 失败是 read-recovery 测试写死 minimumNotice=304，实际为 302。生产 projection owner 的可控会话 `00000000-0000-4000-8000-000000000068`、相同内容与 read-1-0/read-1-1 两个调用，得到 150/152：前者 sourceKey 全数字，fallback estimator 的数字串计价与混合十六进制不同。其合计 302 是有效的动态最小预算，不是产品放宽检查。测试改为校验最小值为安全整数、超过当前 256、与 required tool minimum 一致、context minimum 为正；同时对两种恢复路径都检查下一请求总量不超过实际 512 预算。原始工具状态、请求/读取次数和内容不变断言保留。

## 修正和对照

- RPC 保留启动看门狗 20 秒，关闭窗口改为 15 秒，外层测试期限为启动 + 关闭 + 5 秒清理余量，即 40 秒。只有原来的一个阶段看门狗；不改退出、错误、释放、调用次数和监听器断言。
- MCP spawnSync 预算改为 30 秒，原有禁用 MCP、工具输出、配置不变和无缓存/激活副作用断言全部保留。
- 两个测试在断言前输出阶段耗时与操作系统实际退出码/信号；失败也能看到这些数据。RPC 区分 ready/gate/release/close，MCP 记录是否已观察到工具输出。
- 请求级进程 stop/清理生命周期改变了类型可见性；stdout/stderr 稳定回调与字节环 append 未改，不新增每数据块分配。两个源码/分配门禁通过：16,384 块输入、32,768 字节保留输出；交付期间 Promise、payload Buffer、Buffer view、字符串物化均 0；数据监听器 0，四次 GC 后 owner/input 保留均 0。不宣称性能改善。

任务临时 loader 只改测试夹具：RPC shutdown gate 释放后额外等待 6000ms；MCP CLI preload 额外等待 16000ms。延迟没有进入产品或日常测试。

| 对照 | 原预算 | 修正预算 | 修正后的实测 |
| --- | --- | --- | --- |
| RPC，6 秒 fixture 清理 | 5 秒看门狗失败，整段 5851ms | 15 秒关闭、40 秒外层 | 整段 6781ms，关闭 6038ms，OS code=0，释放回执齐全 |
| MCP，16 秒 preload | 15 秒 ETIMEDOUT | 30 秒 spawnSync | 16612ms，OS code=0，禁用 MCP 的全部断言通过 |

这是受控期限压力对照，不是对原 CI 宿主根因的重现或性能优化测量。普通定向检查 14 项，12 通过、2 项 Windows POSIX 信号跳过；含新增的进程错误→finally 等待→下一调用回归及既有取消、清理失败、输出分配检查。

## 验证与重跑

冻结候选的根 check、离线构建 12/12 通过；完整 npm test -- --keep-going 为 461/461 单元成功，共 6169 项，6053 通过、116 按既有条件跳过、0 失败。真实 TypeScript LSP 对四个变更源文件 4/4 确认、0 诊断。独立 memory 取消 PR 负责第六条提示，本 PR 的五条提示均已消除。PR 审查和六个原有 CI job 必须对应最终 head。

```powershell
# 先把子进程 TMP/TEMP/TMPDIR 指向本次专属 .task-tmp 目录
node --experimental-strip-types --test tests/mxc-process.test.ts tests/mxc-output-hot-paths.test.ts tests/rpc-close-overlap.test.ts tests/mcp-disabled-cli.test.ts
npm run check
npm run build:offline
npm test -- --keep-going
```

手动延迟重跑：在专属任务目录写 ESM preload，使用 node:module 的 registerHooks，仅对 `tests/fixtures/rpc-close-overlap-extension.mjs` 的 `process.off('message', onMessage);` 前插入 `await new Promise(resolve => setTimeout(resolve, 6000));`；另在 `process.argv[1]` 为 `packages/coding-agent/dist/cli.js` 时用 node:timers/promises 等待 16000ms。通过子进程 NODE_OPTIONS 的 `--import=<loader file URL>` 分别运行 RPC 的 `--test-name-pattern='^RPC overlap eof:'` 与 MCP 文件；记录实际命中的 PID/延迟阶段，finally 恢复环境并清除任务夹具。该入口独立于日常测试，不开启网络或模型请求。
