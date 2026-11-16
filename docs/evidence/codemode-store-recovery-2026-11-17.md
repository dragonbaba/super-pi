# CodeMode 存储容量诊断与恢复

基线：`a6c6cfc92b657fb9ca0946bb0690d64c08d0cfeb`。

## 问题与处理

完整 read/search/tool 结果不断存入分支 store，可以达到既有的 1,048,576 个 UTF-16 键名加 JSON 字符上限。此前错误要求删除键，但脚本只能按已知键 `load()`，无法枚举当前键和占用。错误发生前已完成的工具操作仍然真实存在；重跑整个脚本可能重复操作。

新增同步只读 `storeInfo({offset:0,limit:16})`，返回总用量、上限、键数及分页 `{key,chars}`，没有值或工具调用。页大小默认 16，最大沿用已有 4,096 键边界。使用已有序列化字符串长度，不再次解析/序列化大值；本脚本状态含暂存修改，跨脚本无额外索引。容量错误给出实际用量、尝试后的大小和明确恢复步骤。固定工具说明、包 README 和当前使用文档同步指导模型仅存小 ID、路径、游标或摘要，直接展示工具结果。

保留容量、授权、沙箱和事务语义。容量错误仍明确失败；可选缓存可以在脚本中捕获错误后继续使用已有局部结果。未捕获错误不提交任何 store 修改，删除也不会例外。恢复应先在新脚本检查，再单独成功提交已确认无用键的清理。没有自动逐出数据、放宽上限或重放工具。VM 与宿主通过轻量 `@super-pi/codemode/limits` 共用常量，移除宿主重复的数值定义。

## 验证证据

- 真实 worker 复现：4 个 250,000 字符值，总用量 1,000,028，再写 100,000 字符值失败；此前一次工具调用仍成功，失败执行没有 `storeWrites`。
- 同一状态的默认诊断不足 1,000 个 JSON 字符，仅列键和大小；清理和检查不调用工具，成功工具计数保持 1。
- 正确计算 Unicode 的 UTF-16 长度，支持 `__proto__` 键、替换/删除、页面边界、空状态；4,096 键默认只返回 16 项，后续脚本无旧库存。返回元数据的修改不影响 store，host globals 不能覆盖该 helper。
- 实际 AgentSession 验证先写文件成功，再因容量失败；失败清理也不会提交。随后正确清理、reload、导航到旧分支均保持各自快照，文件写入计数始终为 1。
- AST 门禁检查诊断函数不解析/序列化值，不创建逐键回调、Promise 或正则；仅无效参数路径允许创建 TypeError/RangeError。Sandbox 关闭后活动执行为零、启动/停止 worker 计数相等。

本次改动限于显式状态检查、失败诊断、固定指引和共享常量，不触及 provider 增量、工具进度或渲染热路径；不比较分配 benchmark 的性能提升。原有每脚本快照传输成本不变。回归通过真实 worker 及本地生产会话，未修改用户正在运行的 Super Pi 会话。

## 复跑

```sh
npm run check
npm run build:offline
node --experimental-strip-types --test tests/codemode-store-recovery.test.ts tests/codemode-runtime.test.ts tests/codemode-worker-recovery.test.ts tests/codemode-hot-paths.test.ts
node --experimental-strip-types --test --test-name-pattern "full store recovery" tests/codemode-session.test.ts
npm test -- --keep-going
```

当前接口和恢复示例见 [CodeMode 分支状态](../codemode.md#分支状态与限制)。
