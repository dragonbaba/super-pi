# 沙箱目录分类与范围搜索验收（D.a）

日期：2026-11-06。代码基线 `e661c349375f081897337f9d8aac12f746636ad9`。本批处理 B2、N6、P4；D7 的失败保留和 D8 的配置目录尚未实现。遵守任务计划的命令预检禁令：不新增命令识别、筛选或环境切换，不修改 Shell 内部路径解释及既有工作区来宾映射。

## 修改与实证

宿主捕获原本排除 `.git`、`.sp`、`.artifacts`、`.codegraph`、`node_modules`，来宾候选只跳过 `node_modules` 目录。现在捕获、候选收集及宿主整批候选校验共用现有名称分类；来宾文件工具仍拒绝直接访问三个受保护名称 `.git/.sp/node_modules`，`.artifacts/.codegraph` 可在 VM 内使用但不发布。具体分类见[修复计划 0.5](../宿主机权限与子代理修复计划.md)。不吞掉非法候选或发布错误。

搜索从已经校验的文件或目录开始，移除整工作区 catalog 后再过滤的路径。`ls` 只列直接子项并显示空目录。只有发现第 201 条匹配结果才显示截断提示；最多物化 200 行。

首轮真实 VM 暴露出授权遗漏：`.artifacts/native.txt` 已写入 VM，但读取授权要求宿主同名文件存在，因 `realpath` 的 ENOENT 失败。沙箱目标改用已有 prospective 规范化，工作区及显式规则仍检查，实际文件存在性由来宾验证；宿主读取仍要求宿主文件存在。随后用同一原生授权 → 来宾工具 → 宿主发布链复验成功，没有绕过授权夹具。

真实 VM 验收复用 `sandbox-execution-contract-live.test.ts` 的 unified workspace 用例：

- 既有 50 个图片/大文件候选正确写回，2 MiB 二进制保持准确；附加工作区与两种 Shell 的原生 cwd、额外盘符访问继续通过。
- 一次真实 Bash 命令执行 `git init -q nested`，创建 `.artifacts/.codegraph` VM 私有文件，同时发布 202 个普通文件。私有宿主内容未导入且原样保留，私有新文件及 Git 元数据没有写回。
- 原生 write/read 可操作 VM 私有文件，宿主未创建该文件。
- `ls/find/grep` 超过 200 条时均提示截断；空目录可见，受保护元数据不干扰普通列举。
- 外部编辑冲突仍保留宿主版本并报告真实失败；关闭后 `ownedArtifacts=0`、`sourceFiles=0`。

第二次 live 用例耗时约 31.2 秒，是整个用例耗时，不是 VM 启动测量。第一次约 26.5 秒后失败的记录保留为诊断，不计作成功验收。

## 可复现检查

按 `AGENTS.md` 创建并登记任务临时根，将测试子进程 `TMP/TEMP/TMPDIR` 指向该根并验证实际生效，然后从仓库根运行：

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/sandbox-search-scope.test.ts tests/sandbox-workspace-paths.test.ts tests/sandbox-image-read.test.ts
node --experimental-strip-types --test tests/native-execution-policy.test.ts
node --experimental-strip-types --test '--test-name-pattern=sandbox literal search|guest writes|sandbox text editing' tests/source-invariants.test.ts
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit
node --expose-gc scripts/bench/sandbox-search.mjs
node --expose-gc scripts/bench/sandbox-workspace-paths.mjs
```

结果：首组 31/31、授权组 18/18、源码不变式 3/3 通过，类型检查通过。既有别名授权、大小写及短名相关路径控制保留。删除不再使用的 `matchesScope` helper，并把其失效测试替换为实际搜索循环的源码约束；扩展既有私有依赖用例，不保留两份重复测试。

Windows Sandbox 可用时，给子进程设置 `SUPERPI_SANDBOX_WORKSPACE_ACCEPTANCE=1`，运行：

```powershell
node --experimental-strip-types --test '--test-name-pattern=live unified workspace' tests/sandbox-execution-contract-live.test.ts
```

coding-agent 的 `tsgo -p packages/coding-agent/tsconfig.build.json` 和 `node scripts/build-windows-sandbox-runtime.mjs` 均通过。worker、共享策略及声明文件在源目录与 dist 的 SHA256 一致；源码 live 已实际通过 staging 将共享策略送入 VM。本批未以此替代全部任务结束时要求的最终本地离线构建。

## 热路径、分配与释放

审计链：原生授权 → backend 请求/staging → guest `searchScope → local → search → local/read/grepRows`；候选链为 `capture → catalog/selected → commandChanges/changes → validateChanges → publish → releaseCandidates/close`。共享名称 helper 均为模块函数，无逐条闭包或新正则；固定集合、搜索限额及 readdir 选项位于模块层。没有引入对象池、缓存或常驻异步所有者。

搜索收集器每次调用创建两个本地数组：待访问路径最多 20,000 项、结果最多 200 行，正常结束、截断和异常均在 finally 清空；调用结束后数组不复用或保留。原 `local` 的逐路径组件数组及 Node 路径处理分配仍存在，未声称已消除。目录读取仍使用既有同步文件系统语义；本基准不证明操作系统或 VM 内存上界。

候选链保留既有必要分配：`catalog` 的请求内版本 Map 最多 20,000 个文件，`commandChanges/changes` 返回的候选及 artifact 是交付数据（上限分别 1024/32），`validateChanges` 的两个查重 Set 和 contents 数组随调用释放。捕获的 source Map 由 backend 快照生命周期持有，关闭/丢弃清空，live 验证其归零。`execute` 的检查回调、`publish` 的 FileService/授权/记录回调属于每次实际文件提交生命周期，未移入搜索或候选枚举循环，现有 finally 释放 prepared item、authorization 和 FileService；它们不是逐搜索结果的零分配声明。本批没有改变这些提交生命周期或引入池化。

`sandbox-search.mjs` 执行真实生产 helper，以 201 个文件的合成文件系统运行，每种操作预热 32 次、测量 256 次：

| 操作 | 每次目录枚举 | 每次文件读取 | 每次 stat | 采样字节/调用（含预热） |
| --- | ---: | ---: | ---: | ---: |
| ls | 1 | 0 | 1 | 37,592 |
| find | 1 | 0 | 202 | 876,026 |
| grep | 1 | 201 | 403 | 894,343 |

确定性约束：逐条闭包、Promise、AbortController、选项包装对象均为 0；整工作区 catalog 为 0，输出行上限 200，额外溢出探测 1 行。主要采样来自现有 `path.join/normalize/resolve`、组件数组及结果字符串；数字包含合成夹具开销，不用作 VM 性能或加速结论。四轮受控 GC 后，正常、截断、异常后重试所覆盖的 16 个对象全部释放。搜索是同步调用，不新建取消监听器或跨请求引用；VM 取消/关闭继续由既有 backend owner 处理。

原路径基准 200,000 次检查，采样约 4,167 字节/检查；逐组件闭包、正则、保护名称数组为 0，逐路径组件数组为 1；两项观察引用在受控 GC 后均释放。既有候选散列/收集源码约束通过；本批候选处理没有新增逐条异步所有者、完整结果副本或留存容器。

原始输出与进程身份登记在本任务 `.task-tmp/permission-repair-883e92408b/`，每次 Node 子进程均验证任务级临时目录。live 夹具及 VM 已释放；任务根留给后续阶段，最终按登记清单清理。上述仓库测试、基准及说明是独立于临时日志的稳定复现入口。
