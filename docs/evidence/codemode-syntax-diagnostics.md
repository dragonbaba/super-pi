# CodeMode 语法错误诊断

QuickJS 创建脚本函数失败时返回 `SyntaxError` 和 VM 堆栈，宿主原先只把 `message` 放入工具结果。用一段带 CRLF 的合成脚本复现。在第 234 行，嵌入 Python 的反引号提前关闭了外层 `String.raw` 模板。

Worker 将源码作为函数体参数交给 QuickJS 的 `AsyncFunction` 构造器，在调用函数前的异常分支标记执行阶段。诊断扣除构造器的两行签名，使用 UTF-8 字节列截取有界源码片段。宿主在失败结果中生成摘要和片段，TUI 使用已有的完成投影。运行期间主动抛出的 `SyntaxError` 仍按运行失败处理。

真实离线 VM 和会话回归验证了首行、Unicode、`@options`、CRLF、EOF、长行窗口以及运行期异常。解析失败时子调用与 VM 工具调用均为 0。四次折叠状态切换共投影一次完成结果，释放后结果引用和保留文本均为 0。

Windows、Node 26.13.0 上，使用现有工具树基准对同一 4,096 次普通工具卡更新做构建前后的隔离抽样。分组模式的采样分配为 1,606 → 1,703 B/次，P95 为 1.5 → 1.4 µs，峰值堆约 57.5 → 57.4 MB，受控 GC 后约 50.7 → 50.7 MB。主要采样点仍是保留布局的 `render`、`clearPreparedViewportLines` 和 `rebuildViewportBlockHeights`。两次均为 0 事件 Promise、1 次结果投影，释放后无结果、文本、定时器或被跟踪的弱引用残留。这个单次对照用于检查既有渲染路径，未测量新诊断的逐调用成本。

同机已编译 Worker 对照使用 30 次空执行和 100 次桥接调用。函数构造器前后，空执行的中位数为 18.2 → 18.6 ms，P95 为 20.8 → 20.0 ms，宿主侧分配采样为 2.53 → 2.47 MB。两版均完成全部调用，回收 32 个 Worker 和 128 个被跟踪的引用。新增的临时 VM 字符串句柄在函数创建作用域结束时释放。

```powershell
node --expose-gc --experimental-strip-types --test tests/codemode-runtime.test.ts tests/codemode-session.test.ts tests/codemode-tree.test.ts tests/codemode-hot-paths.test.ts
node --expose-gc --experimental-strip-types scripts/bench/codemode-tree.ts --handled-failures
node --expose-gc --experimental-strip-types scripts/bench/codemode-runtime.ts --compiled
```
