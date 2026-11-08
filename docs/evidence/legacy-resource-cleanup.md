# 旧兼容入口与资源清理核对

## 对照与范围

- 基线：合并 PR #273 后的主分支 `e601bd0333b8ab95de04525f2e244a16fef9dd05`。
- 已有非交互/SDK 配置未指定执行环境时仍创建旧授权控制器；显式原生宿主/沙箱权限跳过旧扩展。不能以“交互界面不再使用”为理由删除整个兼容入口。
- 子代理通过 `--no-extensions` 仅加载 child guard；原生父进程通过受限委派通道执行其工作区工具，子进程不重复加载旧生命周期扩展。
- 浏览器扩展已有浏览器关闭钩子，但默认截图文件清理仍在旧扩展中。原生模式跳过旧扩展时，这项职责缺失。基线中截图已落盘，`agent_settled` 后应消失的断言失败；最终回归使用合成截图数据驱动真实保存路径及真实 Chrome 扩展生命周期，不启动浏览器或调用网络模型。
- 不扩展命令预检，不修改默认权限，不新增指令或备份，不删除 24 个旧项目目录的回滚备份。

## 已核对的维护结果

- 精确清单中的 40 个 `.recovery-*` / `.retired-*` 文件共 99,225 B 已删除，失败 0；三份正式记忆文件的 SHA-256 前后相同。只处理全局记忆目录的已确认文件，按原有 Markdown 修改锁串行执行，删除前复核文件身份和内容摘要。记录不含记忆正文。
- 原生加载矩阵 4/4 通过：旧配置保留旧授权；显式 trusted-host、host-write、sandbox-write 使用原生授权。真实 RPC 子进程 2/2 通过相同对照，未请求网络模型。
- 现有配置及真实子代理回归合计 12 项通过，3 项真实 VM 用例未启用。一次失败来自任务临时目录验证脚本不识别测试自身的独占夹具；校正任务脚本后只复跑受影响项，通过；产品代码未为此修改。

## 修复与验证

- Chrome 扩展在注册自己的截图工具时记录该工具返回的默认临时路径；每个实例独立持有路径集合，结束或关闭时逐项清理。自选保存路径及其他实例/未登记文件不参与清理。
- 失败逐项通知并继续处理其余文件，保留失败路径供下次清理；成功即释放路径引用。浏览器关闭失败时仍尝试清理截图。
- 删除旧扩展中的 `OwnedResourceCleaner`、浏览器依赖、每次工具调用的浏览器标记和全局结果监听。旧授权控制器、命令处理和非交互/SDK 兼容行为不变。
- 新增 2 个行为用例，覆盖无需旧扩展、多实例隔离、显式保存路径、未登记文件、真实文件删除失败、部分成功及重试后引用释放。连同原 shell hook 生命周期及 AST 不变量，相关 22 项通过；没有新增同义命令矩阵或替代授权测试。
- 根类型检查及本地离线构建通过，12/12 包成功；Windows Sandbox 运行时仍打包 41 个文件，本次不启动真实 VM。

## 性能与生命周期

审计链：工具注册 → Chrome screenshot execute → 原截图保存函数 → `agent_settled` / `session_shutdown` → 浏览器关闭及截图删除；旧授权链为 ExtensionRunner → legacy hook → SessionPermissionController → 审批 UI/帧写入 → invocation release。

- 新集合及工具包装仅在扩展创建时分配；只在实际截图成功后登记路径。不新增全局工具结果/进度/流式事件监听，不增加每帧闭包、Promise、AbortController、wrapper 或全量文本/图片复制。旧调用路径减少浏览器名称检查，旧结果监听整段移除。异步截图调用与显式生命周期清理保留所需 Promise，不把它们算作流式热路径的零分配证明。
- 路径集合由扩展实例持有，大小为该实例尚未成功清理的默认截图数；成功删除即释放引用，失败保留并通知，不扫描临时目录、不使用对象池。回归通过在成功清理的原路径放入新文件再触发关闭，确认已释放的路径不会再次删除。
- 既有生产审批基准：预热 10、实测 100，110 次对话、2,200 次 render、220 次缓存构建，最多 12 行 / 4,080 code units。采样 362,480 B（3,624.8 B/实测审批），受控 GC 净变化 +436,976 B；pending timer、活跃对话 owner、被追踪活引用均为 0。该基准覆盖保留的授权/UI 链，不声称截图 I/O 零分配或相对基线提速。

## 复跑

子进程 `TMP/TEMP/TMPDIR` 使用任务独占 `.task-tmp` 目录。真实子代理测试自行创建并登记独占夹具；它的子进程沿用该夹具目录。

```text
npm run check
npm run build:offline
node --experimental-strip-types --test tests/chrome-screenshot-lifecycle.test.ts tests/shell-analysis-hook-lifecycle.test.ts tests/source-invariants.test.ts
node --experimental-strip-types --test tests/execution-environment-config.test.ts tests/subagent-parent-execution.test.ts
node --expose-gc --experimental-strip-types scripts/bench/permission-interaction.ts
```
