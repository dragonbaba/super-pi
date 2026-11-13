# 审核后 copy/move 缺失父目录修复

日期：2026-11-13，最终修订 2026-11-14；基线：`3e8b2f5a150e91292c6bd8d7c883dd054c47d390`。

## 问题、复现和最终选择

Native 与 MXC worker manifest 原先对缺失的目标父目录抛原始 `ENOENT ... realpath`。copy/move × 文件/目录源 × 一层/三层缺失父目录的 16 个生产预检回归，在基线上全部因该原始错误失败，最终候选全部通过。

最终采用任务明确允许的回退：两条路径复用 `captureDestinationParent`，只把捕获父目录时的 ENOENT 转成 `[destination_parent_missing]`，提示先用当前授权允许的 shell 建目录再重试；其他错误原样传播。工具描述、单值/数组 destination schema 与当前文档同步说明要求。没有自动建目录、额外审批、脚本解析、命令白名单或新目标数量限制。

回退理由经过实际验证：原自动创建候选复用 write 的 prepareFileCreation / exclusive mkdir 核心，但 mkdir 只接受路径、不返回父目录句柄。审查指出在最后一次 lstat 返回旧身份后、mkdir 前将复用父目录替换为指向工作区外的 junction，仍会在外部创建 deep。把替换时点从第一次身份检查移至第二次（紧邻 mkdir）后，生产 helper 实测 `redirected:true,outsideCreated:true`，也可能在该 helper 内不报错。继续增加检查不能把路径创建与已检查身份原子绑定；现有跨平台/MXC 接口没有 handle-relative mkdir。没有为该任务引入一套新的 native ABI 或更严格命令预检，而是移除整个自动创建扩展，恢复 write、worker执行阶段、审批/ready/回执协议和共享父目录处理至基线。该复现仅解释已撤下候选，不代表最终交付具有自动建目录功能。

全调用预检仍先于任何效果：数组中前面的合法复制以及 file_batch 前面的 write 都不会执行。前一项计划创建的父目录尚未落盘，不能作为后一项 copy/move 的已有父目录；应先单独建目录。dryRun 同样返回明确错误，不创建目录。原 destination_exists、BATCH_CONFLICT、junction、大小写折叠与工作区校验没有改动。

## 验证与边界

- 新增 29 项定向回归通过；含上述 16 项、数组/file_batch/dryRun 无早期效果、worker 工作区逃逸拒绝。
- 最终六个相关测试文件 99 项：98 通过，1 项因没有配置真实跨卷目录而跳过，0 失败。
- 根 `npm run check` 通过；串行完成 `npm run build:offline`，12/12 包，7,290 ms；构建与消费 dist 的测试不并发。
- 生产 TypeScript LSP 对三个变更 TS 源文件收到诊断：0 错误、0 警告、0 提示；两个变更 .mjs 由语法和 worker 执行回归验证。
- 最终改动只在显式调用的只读预检与描述，不触及热路径，跳过分配基准。早先自动创建候选的 109 项及分配数据属于已撤下方案，不能作为最终实现的验证数字。
- 完整根 `npm test` 交由未经修改的原有六个 CI 分片执行；最终 head 的审查和 CI 见本 PR。worker manifest 测试不冒充真实 MXC 会话；未新增真实 MXC / 5 万文件性能结论。

## 重跑

```powershell
npm run check
npm run build:offline
node --experimental-strip-types --test tests/native-file-tree-v3.test.ts tests/mxc-file-mutation-worker-v3.test.mjs tests/file-mutation-v3.test.ts tests/file-sandbox-service-v3.test.ts tests/file-operation-input-v3.test.ts tests/native-file-operations.test.ts
```

LSP 使用当前已配置 TypeScript 路由，提交 native-file-tree.ts、file-operation-input.ts、session-files.ts；JS 的语法/执行验证单独报告。用户原有三个未提交文件不在该 PR。
