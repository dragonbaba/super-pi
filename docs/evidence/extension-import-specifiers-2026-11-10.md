# 源码加载扩展的相对引用后缀（2026-11-10）

## 问题

内置扩展经 jiti 从 TypeScript 源码加载。`goal`、`plan-mode`、`chrome-devtools`、`lsp`、`tui-kit` 以及 `packages/extensions` 中的少量文件用 `./x.js` 引用实际为 `./x.ts` 的文件。jiti 对每个这样的 import 要先探测约 60 个候选路径（多个基准目录 × 10 种后缀 × `index` 变体），全部失败后才把 `.js` 换成 `.ts`。

## 复现

在生产加载器里只加载 `packages/goal/src/index.ts` 并统计同步文件系统调用：6,489 次，其中 6,384 次是失败的 `statSync`；CPU profile 中 `stat`、jiti 解析代码和构造 `NodeError` 占该扩展加载时间的大部分。

曾验证并排除的其他解释：把扩展编译到 `dist`（`goal` 仅 89 → 56 ms）、延迟加载 `tui-kit` 的 highlight.js（无变化）、宿主后台任务干扰（无变化）。

## 修复

不涉及热路径。

- 把这些包里指向 `.ts` 文件的相对引用后缀改为 `.ts`：74 个文件、274 处，纯后缀替换。
- `goal`、`lsp` 的 tsconfig 不继承 `tsconfig.base.json`，补上 `allowImportingTsExtensions`。
- `tests/bundled-extensions.test.ts` 新增用例：从各扩展入口沿 import 图遍历，发现 `.js` 后缀指向 `.ts` 文件即失败。`AGENTS.md` 增加对应规则。

- 三个测试按旧的 `.js` 名字引用或桩接这些模块（`codemode-session`、`lsp-validation-scope`、`chrome-screenshot-lifecycle`），同步改为 `.ts`。jiti 按引用名缓存，`runtime.js` 与 `runtime.ts` 会成为两份状态独立的模块实例。

没有加构建步骤，改扩展源码后仍然无需重新构建。

## 验证

Node 26.13.0，Windows，生产加载器加载全部 24 个内置扩展（不含宿主自身模块），3 次取值。

| 项目 | 改动前 | 改动后 |
| --- | --- | --- |
| 24 个扩展总加载 | 600–605 ms | 410–423 ms |
| `goal` | 89 ms | 11 ms |
| `plan-mode` | 80 ms | 10 ms |
| `chrome-devtools` | 47 ms | 低于 8 ms |
| 加载 `goal` 的文件系统调用 | 6,489 | 153 |

总加载里约 240 ms 是 `openai-server-compaction` 构建分词器表，由另一项改动处理。

各扩展注册的工具、命令、参数、事件处理器名称在改动前后逐项一致。

## 重跑

```powershell
node --experimental-strip-types --test tests/bundled-extensions.test.ts
```
