# T10：图片编码选择与候选缓冲区所有权

状态：先行设计已落盘，开始实施。T09 #191 最终提交 425b2b91365330e907b2ee05eadf2e2c8be74ea2 复审完成、六 CI 分片通过，已合并并删除两端任务分支。本项从 main 9df902e80d1673ef4d52e762596f0bf151f67198 创建独立分支 codex/t10-image-encoding-selection。当前仅 Node v26.13.0。

## 已核对的根因与完整链

processImage 规范化格式 → resizeImage 创建一次 worker、复制并 transfer caller 输入 → image-resize-worker → resizeImageInProcess/Photon decode/EXIF/resize/encode → worker result → processImage → 既有图片草稿/SDK/provider payload；worker finally terminate/removeAllListeners，core finally 释放 PhotonImage。取消由外层 read/图片 owner 保持拒绝，已运行 worker 完成后释放；本项不增加新的主线程 fallback 或扩大既有 fallback 条件。

当前 tryEncodings 同时编码 PNG 与所有 JPEG 档位并立即全部 base64 化，外层却返回第一个满足额度的候选，PNG 只要能放下就胜出，与注释“取较小者”不一致。候选数组同时保留多个完整 base64；透明 PNG 超限时还可能选 JPEG 丢失 alpha。小图已经符合尺寸/额度的直接返回路径应保持原样。

## 最小实现（先写设计再代码）

1. 只修改 image-resize-core 的候选选择，不改协议或外层图片 owner。每个尺寸只 resize 一次，在 finally 释放该 PhotonImage。先比较 PNG 与用户配置 jpegQuality（默认80）的 JPEG；不透明输入选满足额度且更小的候选，不因为更低质量更小就无条件降质。
2. 只有首选质量无法满足额度时才依次尝试现有较低质量档位；跳过比用户选择更高的档位，不把所有档位编码后再选择。所有候选比较用原始 bytes 的 base64 长度公式，不生成候选 base64 字符串；最多保留当前最优和当前候选两个编码缓冲区。决定最终结果后仅一次 base64，并用 Buffer view 避免复制完整编码 bytes。
3. 使用现有 Photon get_raw_pixels 检查实际 alpha，不另加图像库、PNG 手写解析器或模型白名单。优先在已按目标尺寸缩小的 PhotonImage 上检查，限制这一必需 RGBA 临时副本为当前尺寸；同步 helper 返回后不保留像素数组。存在透明像素的候选只允许 PNG，必要时继续尺寸缩小，不能通过 JPEG 达标而损失透明度。
4. 保留现有尺寸递减直到1x1、编码异常/null 返回、EXIF orientation 和 caller bytes 不被 detach/mutate 的语义。不新增截图分类器、全局图片缓存、对象池或编码失败后的第二套兜底。

## 质量与性能验收

先红灯证明不透明照片型夹具同时满足额度时旧代码仍选更大的 PNG，以及多个 base64 materialization。用确定性 RGBA/PNG 夹具构建照片型渐变纹理、透明图、文字/线条截图；不访问用户照片或网络服务。与同样 Photon resize 的 lossless 参考比较尺寸、alpha、像素误差和文字边缘/对比度，确认字节降低并非透明度或代表性文字质量退化。原有旋转、微小图、维度/字节限制、错误/取消用例继续保留。

新增 scripts/bench/image-encoding-selection.ts：在生产 core 上统计 PNG/JPEG 编码次数、base64 次数、最大同时编码候选字节、原始像素副本尺寸；通过同机串行基线/候选 profile 记录 CPU/p95/heap/external/arrayBuffers，不能把 WASM 保留容量等同于未释放 image。PhotonImage.free 计数/指针清零与受控GC WeakRef 证明确切释放；保留 caller input/result 时请求临时候选/image 引用应释放。真实 worker 测试验证退出、listener 清空、caller 输入完整，外层 read取消不变。所有临时 baseline 按创建时记录的精确路径删除。

先相关图像/worker/source invariants与基准，再 check/build:offline、Node26 全套。完整生产调用链继续 audit，凡有新大缓冲区都要明确 owner/释放点，不以 helper 隐藏分配。独立 PR、主动 Codex review；发现问题修复推送并额外独立 review，最终 head reviewer/六 CI 全过后合并和精确清理，再进入 T11。

## 实施、完整调用链与所有权审计

生产只改 `image-resize-core.ts`。`hasTransparency` 是同步像素扫描；`selectEncoding` 用 PNG 与请求质量 JPEG 比较字节数，接受前不产生 base64，超限才尝试固定较低质量档位。透明图只编码 PNG。删除每调用的嵌套编码闭包、Set/Array.from、候选数组和每候选包装；仅接受的候选返回一个 bytes/mime 包装，最终结果用 Buffer view 转一次 base64。没有对象池、缓存、第二图像库或新增兜底。

审计入口覆盖 `main.buildInitialMessage` → `processFileArguments` 的 CLI 图片；`read.execute` → `processImage` 的文件图片；`AgentSession` result hook → `normalizeToolResultImages` → `processImage` 的扩展/MCP 图片。后续共同经过格式规范化、worker copy/transfer、core decode/EXIF/resize/encode、worker result、ImageContent/会话历史/provider payload。TUI 图像 codec 在既有准备边界解码；render 没有新增编码/解码或调用。既有失败语义保持：core 编码失败返回 null，processImage 产生 omitted 文本；tool-result 的既有失败保留原块行为未扩展。read 的取消拒绝不能被迟到 worker 结果覆盖。

每个尺寸最多原始/缩放两个活动 PhotonImage；缩放图由循环内 finally 释放，原始/旋转图由既有 finally 释放。编码 helper 最多两个 bytes 槽，所有权上界可用 `2*largestEncodingBytes` 保守估计；这是可达槽的上界，不代表 GC 立即回收已经不可达的缓冲区。alpha 必须读取一次目标尺寸 RGBA，临时副本上界为 `4*width*height`，helper 返回后不保留。默认最大2000×2000时该副本最多16,000,000字节；显式更大配置按其目标尺寸计算。EXIF旋转原有像素副本仍在既有边界，不声称本项消除。已满足限制的小图路径不扫描 RGBA、不重编码，保留原始数据和一次既有 base64。

原有每图 async Promise、worker生命周期 Promise/监听器和输入完整副本继续存在，用于不 detach caller 输入；它们不在候选/像素循环中。新 helper 的闭包、Promise、AbortController、临时数组均为0；固定 JPEG 质量表仅模块初始化一次。最后的 ImageContent/base64 是 caller owner，不作为待清理临时对象。worker finally terminate/removes listeners，外层取消保持原行为，不新增控制器或跨请求共享状态。

## 实测结果

先红灯3项：旧实现返回较大 PNG；透明超限尝试 JPEG；质量60还编码85/70。修复后定向17/17、已有图片/SDK/TUI回归67/67、check、build:offline通过。质量夹具均与同尺寸 Lanczos3 lossless参考比较：照片 JPEG RGB RMSE **3.695**，文字/线条 JPEG **6.729**、强文本/背景分类保留 **100%**；透明 PNG RMSE **0** 且每个alpha及RGB字节相同。另验证小型纯色图 PNG 更小则仍选PNG，低质量只在额度要求时尝试。这些确定性合成夹具不等同于所有真实照片或OCR准确率保证。

同机三组串行 baseline/candidate，预热3、计时16、profile8、HeapProfiler间隔1024。最大夹具输入1024×768、输出512×384：PNG编码1→1、JPEG5→1、base646→1；最终base64字符552680→44376。采样分配中位数 **730201→48211 bytes/image**，p95 **75.644→50.961ms**，CPU **71250→48812.5μs/image**。精确编码输出bytes542235→447790，但新增alpha RGBA副本786432字节；因此不能声称所有native/ArrayBuffer分配都下降。采样peak external/arrayBuffers与受控GC后内存一并记录，WASM容量保留不等同于image泄漏。

正常、PNG失败、JPEG失败、alpha读取失败、不可能满足的额度及小图路径均验证 Photon 创建/释放相等、free后指针为0，保留caller input/result时临时image/encoded/RGBA对象WeakRef在受控GC后均为0。真正worker的成功/null/错误/提前退出/post失败/取消read用例验证退出且message/error/exit listener归零。基线临时文件按记录的绝对路径删除。Node26全量408/408执行单元成功，5482 tests / 5384 pass / 98 skip / 0 fail / 0 cancelled。最终review/CI待验收；原始结果在 `.git/pi150-t10`，[结构化证据](../evidence/pi-150-t10-image-encoding-selection.json)包含三组原始profile、质量指标及生命周期计数。
