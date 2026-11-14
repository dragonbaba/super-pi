# 测试与文档清理核实

日期：2026-11-14。基线 main `c51a46f059`，Windows / Node 26.13.0。本项保留此前未提交的 Responses 复跑文档调整，只修正文档中的失效入口与链接。R0 测试文件与该 main 提交保持一致。

## R0 冻结断言核实

默认发现清单为 460 个测试文件加 memory 工作区，2/4 分片均无重复或遗漏；463 个测试文件中未发现整文件副本。不同 provider、终端协议和输入序列的相似契约有独立生产入口，保留。

[修复计划](../codemode-recovery-repair-plan.md)已将 F-B11 的小预算长行无法前进登记为缺陷；R1.6 要求普通文本按字符分片前进，分片不提供编辑凭证，并给带快照的不可拆分行提供可执行出路。F-B8 的 8 条组依赖同一 E 波的 F-B11 修复。计划 §4.1 第 5 条明确冻结 R0 断言。

生产 owner 在 1024 下拒绝、6000 对照成功，只复现了已登记的缺陷，不能证明契约改变。现行 `tool-result-read-recovery.test.ts` 在 128 下拒绝、6000 下读完，也没有覆盖 1024 预算下分片前进，不能替代 F-B11 的验收目标。

R0 测试文件未改动；没有修改冻结断言或 R1.6 契约。

## 保留的七项未通过验收目标

| 目标 | 当前观测及保留理由 |
| --- | --- |
| F-B8，8 条组 | 长行恢复不能在 1024 预算下前进；依赖 R1.6/F-B11，保留首尾顺序验收 |
| F-B11 | R1.6 待实现；保留每段不超过 1024、不带 readBoundary、可逐字恢复的断言 |
| F-B9 | 历史投影扩张后，usage 加尾部估算仍为原值；保留 R1.4 的历史稳定及计量验收 |
| F-B12，continuation 与 artifact 两项 | compaction 后条目仍持久化，但当前 Session API 以 `agent.state.messages` 解析，两种恢复均报 stale；保留 R1.6 持久来源恢复验收 |
| F-B10 | 未找到符合用例条件的模型可调用恢复工具；保留 R1.6 公开续读能力验收 |
| F-B13 | 两个子结果分别符合预算，父结果展示仍截断；保留 R1.7/D1 的预算作用单位验收 |

这七项冻结断言全部保留。当前实现仍出现计划中登记的失败，不能作为删除验收目标的依据。确需改变契约时，须由用户决定，并按 §4.1 第 5 条单独提交、附断言对照并交 Claude 单独复审；本项不进行该变更。

## 文档修正

openai-server-compaction、provider-aware-compaction、tool-classification 的旧验证命令已分别对照实际 package/root scripts，改为仓库现存的离线契约入口。缺失的 live 脚本不再作为可执行指令；实时兼容及性能结论仍需独立验收。修正四处失效锚点，移除 memory 的五张缺失图片和两个缺失文档链接，改指当前源码与本地变更说明。历史 VM、旧扩展资料及其引用锚点保留为历史。

## 验证与复跑

文档中修正的验证入口已实跑：read recovery 19/19、server compaction 103/103、provider-aware 1/1、activation/search 59/59，共 182 项通过，根 `npm run check` 通过。这些通过结果不覆盖上述七项未通过的 R0 目标。

本次复核按计划 §4.2 先执行 `npm run build:offline`，再运行恢复后的专用入口：127 项、120 通过、上述 7 项失败，退出码为 1；没有删除、跳过或改写断言。改动文档的本地链接/锚点及 diff 空白检查通过；默认发现和 CI 工作流不变。

先按 [testing](../testing.md) 为子进程设置新建独占 TMP/TEMP/TMPDIR，再按需运行：

```powershell
npm run check
node --experimental-strip-types --test tests/tool-result-read-recovery.test.ts
npm run build:offline
npm run test:codemode-recovery
```

其余已验证命令见 [server compaction](../../packages/openai-server-compaction/README.md#testing)、[provider-aware](../../packages/provider-aware-compaction/README.md#verification) 和 [tool classification](../../packages/tool-classification/README.md)。最后一个 R0 命令保留失败目标，不是当前全量测试通过门槛。未触及生产热路径，跳过新增分配基准；没有改 CI、命令预检或审批行为。
