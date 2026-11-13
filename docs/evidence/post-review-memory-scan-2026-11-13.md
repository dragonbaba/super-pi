# 审核后记忆扫描竞态与无用符号修复

基线：`3e8b2f5a150e91292c6bd8d7c883dd054c47d390`；日期：2026-11-13。

## 问题、复现和修复

“所有项目”列表在 `readdir` 之后逐个 `lstat`，项目目录在这两个调用之间消失时会令整个列表失败。回归通过实际删除已枚举的空目录复现：修复前抛 ENOENT；修复后只跳过该目录，继续返回其他项目。注入同一位置的 EACCES 仍按原对象向外抛出，存活项目字节保持不变。

删除 worker 的三个无用导入、扩展的 `MutationStatus` 类型导入，以及 `FileResultReader.proofRequestHash` 私有槽位和四处声明/赋值。该槽位从未读取、未序列化；原始调用的 requestHash、锚点、分支、ready/intent 和游标校验继续由原有协议字段完成。

显式项目扫描不属于热路径。Reader 变动仅移除未读槽位，仍按热路径要求核对完整 file_result 调用 → Reader 分支证明/分页 → dispose 链；没有新增回调、Promise、AbortController、缓存或对象池。

## 本机验证

- 新回归：修复前 1 失败，修复后 1 通过，覆盖 ENOENT 继续、EACCES 传播及未修改数据。
- 根目录 `npm run check`、memory `npm run check` 通过；串行 `npm run build:offline -- --jobs 1` 为 12/12，10,726 ms。
- memory 原有 `npm test` 命令：29/29；Reader/owner、提交源码不变量和 worker 回归：29/29。
- memory lifecycle：注册 1.7000 ms、启动 3.7994 ms、关闭 1.0606 ms，4 个工具；原有 smoke:rpc 完成 12/12 构建和真实 RPC 命令查询，仅注册 memory。
- 同机 Node 26.13.0，基线与候选各对同一 200 条结果做 2 次预热、5 次完整读取：均为 135 页、3,010 条记录、1,000 条终态，无遗漏。HeapProfiler 采样字节为 23,101,440 / 22,800,560；采样前/后 heap 为 20,732,240 / 27,171,944 和 20,786,032 / 27,135,200；dispose 后为 21,527,016 / 21,569,080。RSS 高水位 114,028,544 / 115,068,928；CPU user/system 微秒 125,000/15,000 与 94,000/16,000。受控 GC 下两者均有 0 个保留 session、page 和 source call。小样本只证明等价覆盖与释放，不据此宣称性能改善。
- LSP 使用实际生产 runner/pool，三个变更的 TS 源文件均收到诊断：0 错误、0 警告、0 提示。最初混合五个 JS/TS 文件的冷请求遇到 8 秒未确认，复查也未收到管理测试 `.mjs` 的发布；不把这些未确认请求算通过。两个 `.mjs` 另经 `node --check`、memory 和 worker 回归验证。完整根测试由未改动的原有六个 CI 分片执行，最终审查和 CI 必须对应当前 PR head。

## 重跑

```powershell
npm run check
npm run check --workspace packages/memory
npm run build:offline -- --jobs 1
npm test --workspace packages/memory
node --experimental-strip-types --test --test-concurrency=1 tests/file-result-v3.test.ts tests/file-result-owner-v3.test.ts tests/committed-file-revision-hot-paths.test.ts tests/mxc-file-mutation-worker-v3.test.mjs
npm run benchmark:lifecycle --workspace packages/memory
npm run smoke:rpc --workspace packages/memory
```

LSP 对 `memory-bulk-cleanup.ts`、`file-result-store.ts`、扩展 `file-batch.ts` 使用当前 TypeScript 路由；两个 `.mjs` 使用语法检查和实际回归。所有候选固定后重跑，build:offline 不与消费 dist 的测试并发。
