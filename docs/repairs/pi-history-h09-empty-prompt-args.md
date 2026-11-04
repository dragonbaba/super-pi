# H09 — 提示模板保留显式空引号参数

状态：已通过独立 [PR #208](https://github.com/dragonbaba/super-pi/pull/208) 合并。分支 `codex/h09-empty-prompt-args` 基于 H08 merge `3064ce9211b09458bc2d99a4751f87a9dda4f0e6`。任务根 `D:\RMProjects\Pi\.task-tmp\h09-9571131e4d48` 已完整清理，Node 26.13.0，child TMP/TEMP/TMPDIR 已验证。

入口 AgentSession.prompt/steer/followUp → expandPromptTemplate → parseCommandArgs → substituteArgs。根因是用 current 字符串是否非空决定是否提交参数，闭合的单/双空引号没有留下参数已存在的状态；后续位置参数及切片前移。此处为显式用户命令解析，不是 provider delta/frame 路径。

最小方案：一个布尔字段记录已闭合引号片段，即使其正文为空也提交参数；遇到分隔空白后复位。原来容忍未闭合引号的非空正文仍返回正文，只有一个未闭合空引号仍不产生参数，不新增 shell 转义/报错规则。相邻 quoted/unquoted 片段仍拼接。每字符使用同一个模块级空白正则，移除原循环内 /\s/ 重建，不新增 tokenizer、数组遍历、闭包或字符串修复链。substituteArgs 的默认值对空值生效、$@ 空格连接及非递归替换均保持既有规则。

先固定单/双空引号、中间/末尾/连续空参数、Unicode 空白/引号正文、相邻片段、未闭合引号、普通控制与实际 expandPromptTemplate 的位置/default/slice/非递归结果。线性单次扫描；函数无新闭包/Promise/容器，新增状态为一个原始布尔值。

基线 25 项中 **14 通过、11 失败**，实际 `/review "" next ""` 错误展开为 `first=[next] second=[] default=next tail=`。候选 25 项全通过，结果为 `first=[] second=[next] default=none tail=next `，尾部显式空参数由连接空格保留。仅空引号的默认值、$@/$ARGUMENTS、slice 起点 0 和非递归 `$1` 对照均通过；未匹配模板/普通正文原样返回。没有调用 provider 或写入会话。

基线 SHA-256 `2896e4720a27cc489bbc4624366888c3cbeb1d301cf19ead818ace293b9d2a02`，候选 `4cdb5b19c8af580f82d730f62941c6cc13069f719426a05f878a7cb947eb085a`。parseCommandArgs AST：循环 1→1、闭包 0→0、new 0→0、数组字面量 1→1、对象 0→0、函数内 regex 1→0；同一个空白正则移到模块一次初始化，源码总 regex 数未增加。每字符不构造新 RegExp，不引入新输入校验/兜底、异步资源或对象池；显式命令解析是低频边界，未虚构 allocation profile 或 CPU 提速。

`node --experimental-strip-types --test tests/prompt-empty-arguments.test.ts tests/source-invariants.test.ts tests/tui-hot-paths.test.ts`：**47 通过**；`npm run check` 和离线构建通过。生产仅一个布尔状态及原空白 regex 的位置调整；substituteArgs、命令权限/执行和会话持久化未改。

最终 head `a4667880d1f77feb28e1823941b4dfec6051b664` 的 [reviewer](https://github.com/dragonbaba/super-pi/pull/208#issuecomment-6624934221) 已完成且无建议；[CI 41790499158](https://github.com/dragonbaba/super-pi/actions/runs/41790499158) 六分片全部通过。首次推送后没有追加推送。2026-11-04 07:19:57 UTC squash merge `5b798165a20014ecb8a9af423253becaba18ab77`，本地主分支同步，并按精确身份删除远端和本地任务分支。

清理前记录并核对自有进程、121 个文件和 2 个子目录；边界/链接检查后精确删除并确认整个任务根不存在，[最终清理回执](https://github.com/dragonbaba/super-pi/pull/208#issuecomment-6625098397)。没有重试以前被策略拒绝的任务根。
