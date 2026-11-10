# 接入 Blender MCP 暴露的桥接问题（2026-11-10）

## 问题

把 Blender 官方 MCP 服务（26 个工具）接入 `mcp-bridge` 后，一次真实会话里出现四个问题：

1. 连接直接失败。工具名截断到 32 个字符后，4 对工具重名（如 `get_blendfile_summary_of_linked_libraries` 与它的 `_for_cli` 版本），桥接层因重名拒绝整个服务器。
2. 失败原因不可见。`/mcp-status` 只显示 `MCP connection failed (protocol-error).`。
3. `mcp_search_tools` 把整句当作一个子串匹配，`blender scene execute python` 查不到任何工具，`blender` 才能查到。
4. 每个结果在 Codemode 里出现三遍：服务器给的 JSON 文本、`structuredContent` 的预览、`structuredContent` 的完整序列化。

## 复现

用桥接层自己的客户端和传输连接 `blender-mcp` 1.0.3：握手和 `tools/list` 成功，注册阶段抛出 `MCP tool-name collision`。会话记录中同一份结果 JSON 连续出现三次，第二、三份之间没有换行。

## 修复

工具注册与显式搜索属于冷路径；结果归一化和 Codemode 大结果交付属于热路径，遵守 `docs/performance/hot-path-allocation-contract.md`，不能因为“每次结果只调用一次”就豁免。

- `piToolName`：被截断的名字追加 8 位哈希；32 个字符以内的名字不变。
- 连接失败时，仅本地 `McpCatalogError`（重名、目录或 schema 超限）写入状态文本；不通过文字前缀识别来源。远端伪造相同前缀不会显示其任意载荷。
- `searchTools`：按空白拆词，逐词计分，命中词多的排前。
- `convertMcpResult`：先执行既有结构校验，再比较不超过 50 KiB 的完整预览与唯一 JSON 文本块；相同时只保留文本块。大对象不为比较而完整序列化，原有恢复和总量边界继续生效。无恢复预算时，单份可容纳的重复内容不会因为重复计算两份而误拒。
- `boundCodemodeResult`：结构化块只写完整序列化，不再先写预览。

## 验证

| 项目 | 改动前 | 改动后 |
| --- | --- | --- |
| Blender 26 个工具注册 | 0（连接被拒） | 26，无重名 |
| 同一结果在 Codemode 输出中的份数 | 3 | 1 |
| `blender execute python` 类多词查询 | 无结果 | 命中 |

份数对照针对可完整内联、内容相同的结构化 JSON；不同数据或超出内联限额的结构化源继续保留。

`mcp-content-matrix`、`mcp-pagination`、`mcp-source-hashing`、`codemode-output`、`codemode-r2-retention` 共 69 项通过。已先复现再修复：去重绕过非 JSON 值校验、执行 `toJSON` 钩子，以及远端文字伪装成本地错误。1 MiB 结构化源与小文本比较时，完整源序列化计数为 0。

热路径审计链：桥接 `execute → callRemoteTool → convertMcpResult → previewMcpStructured/createMcpTypedSource → presentation owner`；嵌套调用 `Codemode.invoke → boundCodemodeResult → appendText/OutputAccumulator → 有界 ChildRecord → 淘汰/调用结束`。新增回调、Promise、AbortController、对象池均为 0；去重候选最多产生两份 50 KiB 内 JSON 解析图，归当前同步调用所有，比较结束或抛错即释放，无共享缓存。CodeMode 只省去重复预览，仍由原有 accumulator 关闭/失败丢弃路径释放文件资源。

AST 门禁覆盖上述新增比较函数和结果交付函数。Node 26.13.0 / Windows x64 基准：24 KiB 重复结果归一化 p50/p95 为 0.112/0.128 ms，1 MiB 不同结果为 5.861/6.044 ms。包含回收对象的 HeapProfiler 抽样分别约 135,014 / 287,513 字节每次（12 次，含投影与测量开销，不代表精确分配量）；主要分配点为有界 JSON 比较、预览字符串和 token 扫描。两个场景的投影记录最多 1 条，dispose 后为 0；受控 GC 后 6/9 个弱引用均全部释放。没有引入对象池。

## 重跑

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/mcp-pagination.test.ts tests/mcp-content-matrix.test.ts tests/mcp-source-hashing.test.ts tests/codemode-output.test.ts tests/codemode-r2-retention.test.ts tests/codemode-hot-paths.test.ts
node --expose-gc --experimental-strip-types scripts/bench/mcp-output-bounds.ts timing
# allocation / gc 两种模式分别运行 duplicate / different 场景。
node --expose-gc --experimental-strip-types scripts/bench/mcp-output-bounds.ts allocation duplicate
node --expose-gc --experimental-strip-types scripts/bench/mcp-output-bounds.ts gc different
```
