# 会话工具提示纠正与验证

日期：2026-11-05。基于 `d67a30f0f0e314191e5673f2826dccc769381088`。用户指定 session `01a1aa6e-a111-7ba4-a440-96ca81c262ca`，本次核对其 154 行记录、60 个子调用。初次 Python 入口诊断见[前一份记录](bash-python-alias-diagnosis-2026-11-05.md)；复现命令、构建日志、源/产物摘要和 AST 计数见[本次证据](session-shell-guidance-2026-11-05.json)。未保存完整会话或素材。

## 会话中的问题

| 证据位置 | 原因与纠正 |
| --- | --- |
| 第 26 行 | python3 命中 WindowsApps 的 PythonRedirector，返回原生 9009 / Bash 49；下一次 python 已成功导入 Pillow。提示要求验证命令身份和所需功能，区分 Python 入口及 Windows 的 convert。 |
| 第 28、72、95、104、118、141 行 | 输出含 traceback，但组合命令最后的 head 返回 0；其中 5 次是 Aseprite 解析器失败。提示明确保存生产命令状态，再查看受限日志并返回该状态，不能据整体 exit 0 判定每个阶段成功。 |
| 第 30 行 | Python glob 使用 Git Bash /d/... 形式，结果无输出；仅凭此不能证明读到任何文件。提示要求将 native 程序或源代码中的路径转换为 Windows 路径，并核对预期输入数量。 |
| 第 42、44 行 | 前导 cd 预检把 /tmp/jrpg 解释为 D:/tmp/jrpg；实际 cygpath 返回用户临时目录。提示要求使用已验证的原生 cwd 和 cygpath 转换。本轮仅修改提示；随后已退役该推测性硬拦，见[预检修复记录](shell-precheck-retirement-2026-11-05.md)。 |
| 第 62、75 行 | 覆盖已有脚本前没有当前 read revision。提示要求读准确目标，发生修改/冲突后重新读，复用任务脚本而非改名循环尝试。 |
| 第 63、65 行 | 把 rd.ref 传给 snapshot，导致 schema pattern 校验失败。ref 是展示/恢复引用；snapshot 是 read 注释中的 snap_ ID。write 可省略 snapshot 使用该目标最新有效 read，显式 ID 仍严格绑定版本，不放宽授权。 |
| 第 86、88 行 | 假设解压后存在 Frames 子目录，实际文件在另一已列出的层级；ls 管道也未挡住后续 Python。提示要求根据实际解压列表确认精确路径。 |
| 多次解析器重写 | 从 3 GB 以上越界偏移到 EOF 后继续读、zlib header 错误，期间反复改猜偏移和脚本名。提示要求优先现有解析器或权威格式规范，先验证边界和单个已知样本。没有改写用户的素材解析器或把这些异常归因为产品进程故障。 |
| 多次结果输出 | 子结果又通过 console.log(content) 打印。Codemode 提示改为原样结果通过 show(ref) 展示一次，console/text 用于计算后的结果。 |

六个被工具明确记录的失败在第 26、42、62、65、75、86 行；其余 traceback 是被命令结构掩盖的生产命令失败。allowFailure 记录“已处理”不表示底层命令成功。

## ImageMagick 定位

找到了 `D:\edgeDownLoad\ImageMagick-7.1.2-7-Q16-HDRI-x64-dll.exe`，24019144 字节，文件描述为 **ImageMagick 7.1.2 Q16-HDRI (64-bit) Setup**，版本 7.1.2.7。这是安装程序，不能当作 magick.exe 运行图片命令。

当前 PATH、常见 Program Files、用户 Local/Programs、WinGet/Chocolatey、D:/Tools、下载位置、agent/bin 和会话工作目录未定位到可运行的 magick.exe；HKLM/HKCU 的已安装程序记录没有匹配。任意自定义便携目录没有穷举，因此结论是“已找到安装包，已查范围未找到安装后的入口”，不能断言整台机器未安装。没有执行安装包或改系统 PATH。

## 修改与验收

生产修改仅涉及四个文件的静态提示/参数描述：Bash 工具指南、Codemode 描述、原生文件工具指南、NativeWriteParameters.snapshot 描述。版本/权限校验、错误分类和路径预检逻辑不变。完整非字符串 AST 比较一致；新增箭头函数、函数表达式、正则字面量、Promise、AbortController 和调用表达式均为 0。没有新增运行时工具探测、全局工具别名或每次请求的动态环境文本。

实际 AgentSession 验收确认嵌套 Bash 和 native write 规则进入系统提示，Codemode 描述包含 snapshot 和退出码规则。100 次重建产生 1 个摘要。文本修改会使更新前后的前缀发生一次预期变化；此测试验证同一配置下重建稳定，不是在线缓存命中率测试。

9 个相关测试文件共 111 项：**105 通过、6 跳过、0 失败**。跳过项为 Windows 不适用的原生 signal、继承管道观察和 Unix 链接夹具。另有五个真实 Git Bash/Python 对照：异常接 head 返回 0；保存日志和生产状态后异常返回 1；成功仍返回 0；空输入显式失败；原生 cwd 和 Python tempfile 目录匹配任务根。

PowerShell **7.6.9** 下执行 npm run check、npm run build:offline、离线 version/help，全部退出 0。构建 **12/12 包、7139 ms、peak=2**。四个源文件和四个编译后 JS 的 SHA256 已归档，编译产物内的新提示已核对。重新启动 Super Pi 后加载该构建；没有为验证提示而重新执行原素材会话或调用模型服务，因此尚无模型端完整重跑的成功率数据。

诊断夹具的失败均保留说明：首次 --import 使用 Windows 路径而非 file URL；AST 夹具最初把移除字符串后的空容器误当叶子；初版 runner 覆盖了嵌套进程记录。分别纠正后重新核对，没有改产品逻辑以让夹具通过。

本次任务根 `.task-tmp/session-shell-guidance-466a1f4f80`；清理前验证精确文件身份、链接边界及登记进程结束状态。此前诊断文档保留。本地验收已完成；提交、审核与 CI 状态以包含本记录的 PR 为准。

清理回执：27 个登记进程均已结束，648 个资源按身份清单验证并删除，35 个直接子项，cleanup PID 34456。任务根已不存在，共享 `.task-tmp` 和离线 dist 保留。
