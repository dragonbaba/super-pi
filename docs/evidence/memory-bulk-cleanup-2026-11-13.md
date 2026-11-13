# 记忆批量清理验证

日期：2026-11-13；基线：A 的合并提交 `5df268b5568266508461e62c8b29044b4f1c7648`。C 在 [PR #298](https://github.com/dragonbaba/super-pi/pull/298) 交付；本记录说明本机验证，最终 head 的审核、六个原有 CI 分片及合并状态以该 PR 为准。

## 行为与边界

`/memory` 新增“批量清理记忆”，范围覆盖用户偏好、全局/当前项目记忆与纠错、全部哈希项目目录。日期筛选仅预选，未知日期可手动勾选；临时失败快捷筛选沿用创建日期注入窗口并排除 correction。列表按最后修改日期排序一次，显示来源、类别、创建/修改日期、字符数与有界首行摘要；Delete 后仍须确认条目、文件和字符总数。无界面、非 TUI 与取消都不删除，不注册新斜杠命令、模型 bulk-remove 或自动过期。

列表只保留片段元数据，不保留文件正文。选择绑定真实文件路径、原始序号/片段 SHA-256、整文件 SHA-256 及父目录身份。写锁内重读，文件已变化则整体跳过，不重匹配或重试；连续选择组对应互不重叠的原始字节区间，未选字节不重新编码。全选写空文件。复用现有同目录候选、独占发布、移位文件核验与冲突恢复；普通 memory 写入仍按原流程规整，当前启动摘要保持冻结。发布后的刷新失败会失效缓存指纹，下一次普通写入不能复活被删条目。

全部项目包含只有 failures.md 的哈希目录以及原项目根已不存在的目录；不从哈希猜测原根，不读取链接文件/目录或旧式目录，旧目录仅计数。全局/当前项目经既有观察器对账；其他项目仅对本次改过的文件调用共用项目对账。任务自己持有写锁协调器连接，临时 store 清空缓存时不关闭活动 store 的共享连接。搜索索引失败不回滚 Markdown，报告原因及 `/memory → 同步搜索索引` 的恢复方法。

## 复现与验证

- 五片段的 32 种选择组合覆盖头尾、相邻组、隔项和全选，含首尾空白、非 ASCII 与非 UTF-8 字节；逐字节比较未选内容。同文不同日期只删除所选一条。
- 实际发布覆盖确认后外部改写、独占 link 竞争及不重试；下一次普通 memory 增改不会恢复已删除条目，包括提交后刷新读取失败的故障。
- 两个故障注入夹具曾按临时目录词法路径匹配，Windows CI 的目录别名使注入失效。真实 junction 临时目录复现两项失败；改为匹配 snapshot 的 canonical 路径后，两项故障都实际触发并保持原断言。链接排除和活动协调器夹具也绑定真实路径；产品和 CI/runner 未为此修改。
- 全局、当前项目、其他项目的真实 SQLite 搜索与 Markdown 对账；链接目录/文件、旧目录、过期列表文件、failure-only 项目及其他项目原索引不被广泛重扫。注入索引不可用后 Markdown 已删、搜索仍旧，手动同步后恢复。
- 实际构建的 dist 注册/无界面菜单不加载 bulk UI 或共享选择器；真实组件工厂、按键和渲染验证无界面、范围取消、列表 Esc、确认 Esc 和确认删除。取消路径写锁获取次数为 0。
- 编译后的真实 jiti 加载器显式加载会话管理扩展，曾将内部 UI 名称误拼到 index.js 后。补齐已编译组件目录的内部别名，现有隔离启动器回归增加该扩展，避免只验证原生 dist import 而漏掉源码扩展加载路径。
- 宿主兼容声明与实际依赖对齐：迁移时的 Super Pi 0.84.1 导出表（207141a27）不提供 session-lease 或共享 UI 内部接口。隔离包保留该真实导出表，三项 Node import 均复现 ERR_PACKAGE_PATH_NOT_EXPORTED；当前管理器自 8696e0950 的 1.0 集成起已依赖宿主 lease。修正会话管理器遗留的 0.84 peer/版本声明为匹配的 1.x 宿主，同步 lockfile、提示和说明；其他扩展的旧宿主兼容范围保持，现有兼容检查与真实当前宿主加载回归分别验证。
- 保留一个活动共享连接和租约，其他项目清理只关闭自己的一个协调器连接，活动连接身份与租约保持。

`packages/memory`：`npm run check` 通过；原有 `npm test` 命令的三个文件共 28 项通过；`npm run benchmark:lifecycle` 注册/启动/关闭为 2.3121 / 3.2888 / 0.9846 ms；`npm run smoke:rpc` 完成 12/12 包构建及真实 RPC 状态/命令查询，仅注册 memory。相关共享选择器回归 7 项、TUI 源码约束与 bundled extension 检查 16 项通过。根目录 TypeScript 检查通过。环境的 typescript-language-server 仅有失效 shim，启动返回 command not found；未声称完成 LSP 诊断。

## 热路径与资源证据

比较了同包技能管理组件与会话管理的有界选择器。技能组件每次过滤/绑定技能动作，不适合原样传入记忆行；有界选择器迁移至 coding-agent 编译组件，保留源码扩展兼容入口，通过动态 loader 供 memory 与会话管理复用。memory 的 rootDir、编译配置和包内 `.js` 导入保持。审计链：菜单动态 import → 行准备/排序 → custom UI 工厂 → selector 输入/渲染 → TuiAltScreen overlay/布局 → 帧写入 → 关闭/取消/dispose。渲染与输入循环只增加已准备的标题字段读取，没有逐键排序/过滤、回调、Promise 或整份行表副本。

明确的低频分配边界为 listBulkMemory、prepareBulkMemoryRows、selectRows/confirmRows/showWarnings、组件 constructor/enableMultiSelect、显式提交选择和关闭；文件读取、发布、锁与索引同步属于显式管理操作。普通逐键/帧路径复用已有回调，画面只生成有界 viewport。每个组件只有当前选择/宽度的详情缓存，dispose 清空记录、缓存、回调和新增标题字段。

同机 Node 26.13.0、8 次交互、1 次预热/1 次采样的迁移前后比较：66 次 render、1,386 行、4 次详情 wrap、22 次 frame、44,648 个 frame UTF-16 code units、最大单帧 2,185、9 次显式选择检查全部相同。两组件的 12 个既有持有字段清空，两个 owner 和两组各两个旧/新详情缓存全部回收。候选 selector 分配采样估计 4,191,152 字节，主要位于 truncateToWidth、graphemeWidth 和 ANSI 分词；runner 采样最高 heap 32,731,920、结束 heap 24,124,888，进程 RSS 高水位 108,253,184 字节；fixture CPU user/system 31,000/0 µs。基线采样 4,287,056 字节、最高 heap 74,166,096；模块导入图发生变化，且样本很小，不据此声称应用性能改善。

另一个实际 dist 行准备/组件探针只用 32 条合成记忆：准备 1 次、render 33 次、checkbox 输入 32 次，最多 20 行、详情 wrap 1 次。dispose 后组件仍保持存活，66 个行/条目/文件/快照 WeakRef 受控 GC 后存活为 0。采样估计 5,574,320 字节；三次观测最高 heap/RSS 21,945,160 / 83,316,736，GC 后 heap 16,621,608 字节，CPU user/system 31,000/0 µs。此探针不是提供方或完整终端会话测量；完整帧链由前述既有 benchmark 覆盖。采样字节不是精确累计分配，三次观测不是连续内存峰值。

## 重跑

```text
# 在 packages/memory
npm run check
npm test
npm run benchmark:lifecycle
npm run smoke:rpc

# 在仓库根目录；显式小样本，不进入默认测试发现
node --expose-gc --experimental-strip-types scripts/bench/session-clean-timeout-boundaries.ts --iterations 8 --warmup 1 --runs 1 --sample --lifecycle
node --experimental-strip-types --test --test-concurrency=1 --test-name-pattern="selector|checkbox|ordinary Alt|fixed regexes" tests/session-clean-timeout-boundaries.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/tui-hot-paths.test.ts tests/bundled-extensions.test.ts
```

没有运行本地完整根测试或大型文件/会话矩阵。CI、测试运行器、分片、并发、Node 选项及命令/脚本预检与 A 基线保持一致；最终 PR 审核和原有 CI 仍是交付门槛。
