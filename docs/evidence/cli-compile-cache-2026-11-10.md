# CLI 启用 Node 编译缓存（2026-11-10）

## 问题

CLI 每次启动都重新编译约 1450 个模块，未使用 Node 的 V8 代码缓存。

## 修复

`packages/coding-agent/src/cli.ts` 在加载 `main` 之前调用 `module.enableCompileCache()`。不涉及热路径。

- 独立版本查询（`--version`）不调用，保持原路径。
- 缓存目录用 Node 默认位置（临时目录下的 `node-compile-cache`），可用 `NODE_COMPILE_CACHE` 改位置、`NODE_DISABLE_COMPILE_CACHE=1` 关闭。
- 缓存目录不可用时 Node 返回状态而不抛错；没有该 API 的运行时跳过。
- jiti 加载的扩展不走这份缓存。

## 验证

Node 26.13.0，Windows，p50（15 次，同一构建，用 `NODE_DISABLE_COMPILE_CACHE` 对照）。

| 调用 | 关闭缓存 | 启用缓存 |
| --- | --- | --- |
| `node packages/coding-agent/dist/cli.js --help` | 546 ms | 483 ms |
| `node scripts/superpi.mjs --help` | 1144 ms | 1086 ms |

缓存占用：1748 个文件，约 14 MB。把 `NODE_COMPILE_CACHE` 指向一个普通文件时 `--help` 正常输出并以 0 退出。

首次运行（缓存为空）的写入开销未单独测量。

## 重跑

```powershell
npm run build:offline
node --experimental-strip-types --test tests/cli-version-entry.test.ts tests/cli-args-terminator.test.ts tests/alpha-cli.test.ts
```
