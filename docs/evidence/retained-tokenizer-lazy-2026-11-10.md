# 保留消息分词器延迟构建（2026-11-10）

## 问题

`packages/openai-server-compaction/src/remote-compaction.ts` 在模块顶层执行 `getEncoding("o200k_base")`。该扩展随每次启动加载，因此每个会话都付出约 230 ms 启动时间和约 66 MB 常驻堆，而编码器只在远程压缩裁剪保留的用户消息时使用。

另外，分词器默认拒绝特殊 token 文本：用户消息里出现字面量 `<|endoftext|>` 且落在被扫描的范围内时，保留历史构建会抛错。

## 复现

`node scripts/superpi.mjs --help` 的 CPU profile 中 `js-tiktoken` 占约 200 ms；单独测量 `getEncoding("o200k_base")` 为 228–248 ms，构建后堆 +65.8 MB。

## 修复

不涉及热路径分配契约列出的路径（压缩是每次压缩一次的低频路径）。

- 编码器改为首次需要真实 token 数时才构建，并在该次同步裁剪结束后（`finally`）释放。
- 新增字节上界预判：BPE 的每个 token 至少覆盖 1 个 UTF-8 字节，无文本的消息按 1 个 token 计，所以保留消息的字节总和不超过预算时一定不超预算，直接整体保留，不构建编码器。
- 编码时把特殊 token 文本按普通文本计数，不再抛错。

## 验证

| 项目 | 改动前 | 改动后 |
| --- | --- | --- |
| `superpi --help` p50（10 次） | 1152 ms | 912 ms |
| 导入模块后的堆增量（受控 GC） | +104.5 MB | +38.7 MB |
| 一次超预算压缩并 GC 后的堆增量 | +104.7 MB | +38.9 MB |

16 组输入（空、小历史、图片与空文本、字节上界两侧、中文、emoji 代理对、3 万条小消息、2.5 万条空消息、超预算英文与中文、特殊 token）的输出哈希：15 组与改动前逐字节一致；唯一差异是小历史中的 `<|endoftext|>` 由抛错变为正常保留。

超预算时首次裁剪需重建编码表，单次耗时约 190–580 ms（改动前约 0–350 ms，表已在启动时建好）。

## 重跑

```powershell
node --experimental-strip-types --test tests/openai-retained-history.test.ts
node --experimental-strip-types --test tests/provider-contract/openai-remote-compaction-fallback.contract.test.ts tests/provider-contract/openai-compaction-lifecycle.contract.test.ts tests/bundled-extensions.test.ts
```
