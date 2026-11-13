# copy/move 自动创建目标父目录

基线 main 3e8b2f5a1，恢复自448a7270e的共享 executeFileCreationDirectories。copy/move 的缺失父目录不再直接报错，而是进入与write共用的只读计划、授权和非递归mkdir/身份记录链。清单进入预检与审批；数组及file_batch复用前项已创建的身份；dryRun只预览；后续复制失败报告partial和保留目录，不删除、不重放。createdDirectoryCount/createdDirectories/createdDirectoriesOmitted沿用write的有界汇总。旧错误分支、专用helper和“父目录必须已存在”的描述及测试已移除。

## 边界与复现

最后一次lstat到mkdir之间的并发替换窗口与write相同；本任务按用户指定的防误操作口径接受，不作并发对抗承诺，也不增加锁、审批或数量上限。.git/.sp、原授权、源链接与冲突检查不变。

恢复候选曾单独拒绝Native工作区外缺失父目录，而write的预检允许准备同样的路径并标记workspace_escape；生产FileService复现后移除这条额外限制。现在Native同样准备祖先并把全部目标交给原授权路径；MXC的write/copy/move均拒绝越出已分配工作区，跨已授权工作区仍按目标索引绑定。默认host-write实测write工作区外创建成功，copy/move要求其既有授权，未改变工具级授权规则。

## 验证

- 10个代表回归及对照，不做笛卡尔矩阵：Native/worker单值copy缺1层、目录move缺3层及已有父目录对照；Native copy数组/MXC move数组共用父目录；双方write→copy→目录move；dryRun与apply；建目录后源变化的partial、保留2个目录及下一独立项成功；双方工作区外行为与write对照。公共目录的两条结果按item index核对创建数2/0。
- 最终6个相关文件80项：79通过，1个未配置真实跨卷目录的场景跳过。根check通过；offline build12/12、6930ms，之后才跑消费dist的测试。生产LSP对7个变更TS源文件0错误/0警告/0提示。
- 32层缺失目录实测：共享executeFileCreationDirectories执行阶段lstat561次、非递归mkdir32次、创建身份32个。范围排除了只读prepare与目标文件I/O；计数为初始祖先1 + 每层祖先32 + 已创建目录复核496 + 新身份32。O(n²)来自write既有循环，路径长度等既有边界使数量有界；该显式文件操作不在通知/进度热路径，本次只记录，不改算法、不跑无关分配基准。
- 完整npm test使用未修改的原有六个CI分片。worker fixture经过生产manifest/权限/回执链，但不冒充真实MXC会话或大规模性能测试。

## 重跑

```powershell
npm run check
npm run build:offline
node --experimental-strip-types --test tests/native-file-tree-v3.test.ts tests/mxc-file-mutation-worker-v3.test.mjs tests/file-mutation-v3.test.ts tests/file-sandbox-service-v3.test.ts tests/file-operation-input-v3.test.ts tests/native-file-operations.test.ts
```

计数重跑：在owned临时目录准备32层plan，mock fs.promises.lstat/mkdir并syncBuiltinESMExports后只调用executeFileCreationDirectories，finally恢复两个函数；assertPathAllowed返回准备的canonicalTarget。所有手动探针和测试子进程的TMP/TEMP/TMPDIR均指向任务临时目录。
