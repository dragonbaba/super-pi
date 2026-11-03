# T02 — 无项目资源时尊重保存的信任决定

基线：`ed53fbe72a1c2c27b64fec78980ccb46bacca476`（#176、#177 已合并）。分支：`codex/t02-saved-trust-decisions`。状态：按先落盘方案后实施的顺序完成两个入口修复，正在验收，尚未合并交付。验收只使用当前 Node 26.13。

## 根因与完整入口核对

`resolveProjectTrusted()` 在 `hasTrustRequiringProjectResources(cwd) === false` 时提前返回 true，跳过保存的 false。检查实际调用者还发现 CLI `main.ts:createRuntime` 有相同短路：无资源时直接可信，根本不调用公共解析器。只改公共函数无法修复实际 CLI。

| 入口/消费者 | 现有语义与处理 |
| --- | --- |
| 公共解析器 → package/config 命令 | 修正无资源分支，使用 store 返回的有效决定；null 才沿用自动信任 |
| CLI TUI/print/json/RPC → createRuntime → SettingsManager → services/resource loader | 修正共享启动分支；保持 cached decision、显式 override、需资源的 extension hook 先后顺序 |
| ProjectTrustStore.get → getEntry → 锁内读取 → 最近目录/父目录决定 | 原实现已支持 false、true、null 和父级继承，复用，不增加另一套路径规范化/存储/缓存 |
| ResourceLoader.reload → SettingsManager.projectTrusted → 项目资源/扩展消费者 | 消费已解析的 boolean，reload 保留状态；不在每次工具调用或渲染中重新读 store |
| InteractiveMode 隐式 reload 保存 | 已有 `!isProjectTrusted()` 和 store 中已有决定的门禁；修正启动状态后保存 false 不会变成 true，不需改 UI/渲染 |
| 直接 SDK createAgentSession / createAgentSessionServices | 信任由宿主提供的 SettingsManager/resource loader 决定；默认构造不调用公共解析器。保持现有 SDK 接口，不擅自新增磁盘授权读取或重排宿主授权 |

仅含 `AGENTS.md` 不属于当前需信任资源分类。本项修正其有效信任状态，不改变上下文文件分类，也不宣称证明 Windows Sandbox 隔离。

## 最小实施步骤

1. 增加行为回归并先观察失败：无资源目录的保存 false/true/null、父级 false 与子级覆盖；显式 override 不读 store；有资源 hook 优先级和无 UI 行为；坏 trust 文件错误传播与锁释放。
2. 在公共解析器的现有无资源分支返回 `trustStore.get(cwd) ?? true`。null 是明确的“没有决定”，不是遇错后的兜底。
3. CLI 现有启动表达式改为先取有效 store 决定，仅 null 时使用 `!hasTrustRequiringResources`。有资源且需要 hook 的路径仍由原 resolver 处理，不提前重复读 store。
4. 扩展已有真实 CLI fixture 的一项配置场景：仅 AGENTS.md、保存 false，验证 `ctx.isProjectTrusted()` 为 false、没有执行项目扩展、store 未被改写；保留原隔离 HOME、退出与资源释放断言。
5. Node 26.13 下运行针对性测试、typecheck、离线构建、完整测试和现有 Linux 2 / Windows 4 分片 CI。按独立功能创建 PR，不自动合并或混入 T03。

## 性能、错误与资源边界

遵循 [hot-path allocation contract](../performance/hot-path-allocation-contract.md)。新增读取只发生在启动/显式命令原无资源分支，每次解析一次；显式 override 零读取，hook 已作决定时零读取。有资源 hook 未决定时仍是一次原 store 读取。测试使用真实 store 的 spy 计数，不复制存储实现。

本项不修改 delta、progress、observer、布局或终端帧链，不增加每事件的 closure/Promise/controller/wrapper；没有新 watcher、缓存、重试或对象池。已有读取会获得 trust lock、解析 JSON 并查找最近路径，临时数据随调用释放，锁由原 `finally` 释放。错误直接传播，不用 catch 返回 true/false。用损坏文件后恢复再读取的行为测试确认失败不会留下锁；不把非热路径改动包装成需要新 allocation benchmark 的优化项目。

## 验收记录

修复前，新增 resolver 文件 12 项中 6 项失败、6 项通过；真实 CLI 的新场景失败，日志明确为 `ALPHA_PROJECT_TRUST:true`。这不是只对源码表达式的推断。

修复后，resolver 与既有 extension timeout 回归 **22 pass / 0 fail / 0 skip**；离线构建产物的 3 个实际 CLI 信任场景全部通过。新场景报告 false，原有项目扩展执行、存储决定、退出码 0、shutdown=1 和 raw mode 恢复断言通过。`npm.cmd run check` 和 `npm.cmd run build:offline` 通过。Node 26.13 完整测试 **389/389 个执行单元成功，5,104 pass / 96 原有 skip / 0 fail**；最终 SHA 的远端 CI 状态以 PR 检查列表为准。

[JSON 证据](../evidence/pi-150-t02-saved-trust.json)记录基线、候选源码的 LF-normalized SHA-256、失败/成功结果、精确读取次数、锁释放和覆盖边界；原始日志保留在任务目录 `.git/pi150-t02`。没有新增测试跳过项、降低断言、修改超时或引入对象池。

```powershell
node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/project-trust-decisions.test.ts tests/extension-hook-timeout.test.ts
npm.cmd run check
npm.cmd run build:offline
node --experimental-strip-types --test --test-name-pattern=project- tests/alpha-cli.test.ts
npm.cmd test -- --keep-going
```
