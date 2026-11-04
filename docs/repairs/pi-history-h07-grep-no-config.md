# H07 — 内置 grep 隔离用户 ripgrep 配置

状态：最小修复与本地验收完成，待独立 PR reviewer/CI。分支 `codex/h07-grep-no-config` 基于 H06 merge `c79d75bbf38f82fd1a0a777d2b47dff285e0ab3d`。任务根 `D:\RMProjects\Pi\.task-tmp\h07-c2dd92f8803c`，Node v26.13.0，子进程临时目录已验证。

## 路由、范围与验收

宿主工具注册 tools/index.ts → createGrepToolDefinition/wrapToolDefinition → execute → consumeToolPath → ensureTool → operations.isDirectory → spawn(rgPath,args) → readline JSON match → 格式化/截断 → tool result。注入 GrepOperations 只替换目录判断和 context 文件读取，仍共用这个宿主 rg 进程。授权路径在入口消费，scope/glob/literal/ignoreCase 等显式参数不变。

Sandbox 的 WorkspaceSandboxTools.install 替换同名工具，经 WorkspaceSandboxBackend → workspace-worker.mjs 的 grepRows/indexOf 字面搜索，不启动 rg，也不读取 RIPGREP_CONFIG_PATH。保留其原字面语义/200 行上限，不扩展为宿主 regex 工具；现有 guest entry 测试覆盖两个 Sandbox 模式且断言 search 不 spawn，本轮复跑该入口，不能称为启动真实 VM。

根因：宿主 rg 自动读取子进程继承的 RIPGREP_CONFIG_PATH，工具没有覆盖配置文件的 --fixed-strings。最小方案是在已有启动 args 数组加入静态 --no-config；不修改用户环境/文件，不添加 per-line 校验、闭包或正则。读完整 context 文件的已知大结果成本留给独立 H08；本项只变更冷启动参数，不借机重写流处理或权限边界。

每个离线 fixture 在仓库内 owned root 写入合成 ripgrep 配置/文本，子进程启动前设置 TMP/TEMP/TMPDIR、SP_CODING_AGENT_DIR 和 SP_OFFLINE=1。真实执行宿主/注入 ops × 污染 regex/literal、无配置与 ignoreCase/glob 对照，捕获原 spawn 实参并记录 rg PID/close/管道销毁、abort listener。配置只有 fixture 文件，父进程环境不变；缺 rg 时明确失败。固定开发依赖 @vscode/ripgrep 1.18.0 通过平台可选包提供真实二进制，fixture 仅在子进程 PATH 中加入其目录，CI 沿用 npm ci，无 workflow 改动，不触发生产工具下载或跳过门禁。

验收还包括不触发 context 读取时 readFile=0、注入 context 路由仍调用自定义 readFile、授权绑定只消费一次。AST 对比应只有一个新增静态字符串，闭包/正则/Promise/函数数量不变；普通 JSON 行处理和输出成本未改变，完整性能改造按 H08 单独审计。

## 失败基线

grep.ts SHA-256 `c4ac83bccce6cb2609829bf16e574fa3a356eeb8c62025606809210f51ce948a`。真实 rg 八项中四项通过（literal/无配置 × 宿主/注入），四项失败（regex/ignoreCase × 两路径）：`alpha[0-9]+` 命中了第二行的字面表达式，而不是 alpha42/ALPHA99。初始控制还强制检查尚未实施的参数存在，把四个语义通过的对照也记作失败；最终基线保留污染 regex 场景的精确 args 门禁，对照按结果验证，未改变生产代码。fixture 进程结果类型声明因 assert 将首个 exit code 缩窄为 number 已修正为 number|null，运行行为不变。

## 候选验收

生产仅增加 `--no-config` 一个启动参数，候选 SHA-256 `766908ad44e2879ed842085ea1b96b4059a2f49ae6c93135ef126a7d91dbb2a7`。完整 grep.ts AST arrow/function-expression 27→27、function declaration 8→8、regex 0→0、new Promise 1→1、async 6→6、strings 117→118。无需新增输入校验、状态、fallback；原授权检查在执行入口一次消费，错误和取消仍按原路径传播。静态参数只在进程启动边界生效，逐 JSON 行/上下文/结果/渲染代码未改变；不声称整链零分配或测得提速。

Node 26.13.0 / 固定依赖提供的 ripgrep 15.0.0（rev 3a612f88b8）复现基线 4 通过/4 失败，候选八项全通过；系统 ripgrep 15.2.0 的先行运行结论相同。每项记录一个搜索 PID/启动时间/close 结果，stdout/stderr destroyed，abort listeners=0，authorityChecks=1。宿主 context=0 的 readFile=0；注入 context=1 的 isDirectory/readFile 各 1。regex/literal/no-config 匹配数各 1，ignoreCase 匹配数 2；glob 排除 excluded.log，显式参数/配置文件/父环境保留。每次仅写合成 fixture，测试完成后独立 owned root 验证删除。

验收命令：`node --experimental-strip-types --test tests/grep-config-isolation.test.ts tests/sandbox-search-scope.test.ts tests/source-invariants.test.ts tests/stream-hot-paths.test.ts`，使用固定二进制共 **27 通过**。两个 Sandbox 模式执行完整 guest entry，共 90 次搜索/列举路由，子进程启动数 0；不是真实 VM 验收。类型检查和离线构建通过。开发依赖及平台包锁定 1.18.0，安装脚本关闭；lockfile 没有升级无关依赖或更改 workspace 元数据。

H08 仍负责 context 大文件读取、行数组和流式容量/释放；本项不把该已知成本隐藏在“新增分配为零”的陈述里。最终 head reviewer 与六分片 CI 待完成。
