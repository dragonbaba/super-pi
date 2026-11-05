# 沙箱图片读取契约

## 证据与边界

2026-11-05，同一问题会话核对至 824 行：PNG 产物写回成功，但 `read` 返回 `File is not UTF-8 text`。后续 shell base64 绕行返回 32,768 字符，且脚本把裸 base64 传给要求 data URI 的 `image()`，CodeMode 因参数格式报错；即使补上 URI，已截断的数据仍不可用。宿主预览 PNG 为 21,541 字节，contact PNG 为 52,102 字节；这里只记录必要事实，不保存私人会话或图片。

工作对照：普通 `read` 已按文件签名识别图片，经 `processImage` 返回原生 image 内容；沙箱 worker 强制 UTF-8，WorkspaceSandboxTools 仅返回 text。这是读取协议的能力遗漏，与图片是否存在、npm 发布、目录权限或 shell 输出额度无关。

## 执行与验收

1. 共享图片签名识别；沙箱通过独立、有界字节附件返回图片，宿主只处理经校验的来宾附件。
2. 验证文本、图片、二进制拒绝、容量、取消、附件身份/hash、CodeMode `read → show(ref)` 及释放路径。
3. 验证真实 Windows Sandbox 的只读/读写和附加目录，源码与离线构建；更新使用说明。
4. 独立 PR；首推等待 reviewer，后续推送 `@codex review`；最终 head 无待处理意见且全部 CI 通过后合并、回 main、删除精确旧分支。

目录授权、PS7、命令输出上限和写回规则继续有效。遵循热路径分配契约：不引入逐块闭包、正则、无界 base64 或对象池；检查生产调用链、确定性计数和引用释放。临时根为 `.task-tmp/sandbox-image-read-7aa4638c130a/`，子进程临时环境及身份统一登记。

## 实现与所有权

普通读取和来宾读取共用纯签名模块，包含 JPEG、PNG、GIF、WebP 和 BMP；不根据扩展名或 UTF-8 判断来猜图片。构建复制共享模块及声明，VM 工具目录保持模块相对路径。来宾先读取最多 4100 字节识别，图片上限 16 MiB；按 256 KiB scratch 哈希，仅把一个文件附件的名字、长度、hash 和 MIME 放入 JSON。文本仍遵守原 2 MiB/2000 行/32768 字符边界。

宿主绑定附件名到本次请求 ID，禁止图片响应夹带写回/命令结果，并校验尺寸、普通文件、硬链接数、路径、打开前后身份及 SHA-256。读取唯一 payload 后重新识别格式，复用 `processImage` 和缩放 worker；完成后删除附件。错误/撤权/取消走独立 `[SANDBOX_IMAGE]` 诊断并关闭失败快照。宿主不重新打开用户源路径。解码失败沿用普通 read 的图片省略提示；16 MiB 是编码输入界限，不承诺解码器内存也只有 16 MiB。

完整审计链：路径/权限边界 → guest readImage/fileHash → 元数据响应 → backend candidate → 共享签名 → processImage/resize worker/Photon → 原生 image 内容 → CodeMode appendShown/capCodemodeOutput/saveCodemodeImages → provider/TUI 既有图片通道。新增逻辑不在帧、delta、逐字节循环创建闭包/正则/数组。缩放 worker 结束后 terminate 并移除监听器；CodeMode 的 records/shown 在 finally 清空，图片历史与私有展示文件仍由现有会话/结果机制管理，不能把用户需要的展示文件误称为泄漏而删除。

## 本地验收

- 38 项相关回归通过：两档沙箱、主/附加目录、Windows 临时目录别名、扩展名错误、五类图片、文本行窗口、UTF-8 合法的 GIF、超过容量、hash/MIME/长度/文件名篡改、硬链接、文件消失、释放失败、取消，以及 `read → show(ref)` 原生图片链路。
- 全部热路径检查 22 单元/111 项通过；图片编码探针及新增附件分配探针通过。24 × 2 MiB 读取恰好分配 24 个 payload buffer，累计 50,331,648 字节；一次一份，4 轮受控 GC 后 WeakRef 存活 0，交换目录附件 0。累计分配不是峰值，编解码器另由既有图片基准覆盖。
- 源码和最终离线产物均实测 Windows Sandbox：每档权限分别读取主/附加目录的 184,140 字节合成 PNG，逐字节相同，每档复用一个 VM，两次读取后附件 0；关闭后 VM/pending/ownedArtifacts/sourceFiles 均释放。
- `npm run check`、`git diff --check` 通过；最终 `npm run build:offline` 12/12 包、6850ms、峰值并发 2。复现使用 `SUPERPI_SANDBOX_LIVE=1`，产物验收再设 `SUPERPI_SANDBOX_USE_DIST=1`，运行 `tests/sandbox-image-read-live.test.ts`。

README 和执行环境说明已更新。应用需重新启动才能加载本地新核心；`/reload` 仅重建当前进程的运行环境。发布仍以本 PR 最终 head 的 reviewer/CI 为准。

## PR #229 的 CI 跟进

首轮 reviewer 对 `1c0a232a4` 无发现；Windows 第 1 分片的 5 个图片正向用例却报 `Redirected or resized artifact`。新测试用 legacy `fs.realpathSync` 构造 backend 根，而生产 backend 使用 native async realpath；Windows 临时目录别名使两者的字符串不同。已有 [T12-A 路径记录](pi-150-t12a-canonical-path-identity.md) 明确记录了此差异。

在任务临时根 `.task-tmp/pr-image-read-1f781718b122/` 中，将子进程 TMP/TEMP/TMPDIR 设为同目录的大小写别名，修复前复现完全相同的 5/15 失败。夹具改用 `realpathSync.native`，清理复用现有 owned-fixture helper，并增加显式别名回归；修复后别名环境 16/16、定向回归 38/38 及类型检查通过。故障注入用例分别断言具体失败原因，避免路径前置失败掩盖 hash/MIME/撤权等测试。生产路径与附件身份校验保持原实现；本次仅修改测试及此记录，既有离线产物和性能证据继续对应相同生产源码。

后续推送须再次 `@codex review`，首轮无发现不替代新 head 的审查和 CI。
