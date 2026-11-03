# T12：Windows路径等价性，分入口复现与分批交付

状态：T12-A #194和T12-B #195已合并，各最终head均获completed/no findings与六CI通过，两端任务分支已删除。B合并为0cc64d3be615386134c7be8fe3932aa1dba35a2f；[T12-C](pi-150-t12c-local-package-identity.md)已在同步main上独立复现并进入验收，D仍待实施。用户只要求当前Node26；POSIX行为在既有Node26 Linux CI验证。

## 已观察到的共同边界

当前Windows Node26同一实际目录不同大小写的stat dev/ino一致，但fs.realpathSync保留输入大小写，fs.realpathSync.native返回一致实际名称。utils/paths.canonicalizePath目前使用前者、失败原样返回。已有canonical消费者20处，需要逐个审计；不能假定换helper已修复session、package或所有containment。

严格保持：不全局toLowerCase，不用裸字符串prefix猜目录包含，不替换旧session目录编码规则，不把缺失路径猜成已存在对象，不修改用户真实信任库或扫描删除用户目录。所有实验只在记录身份的测试临时目录；junction/symlink在finally删除其链接及所属测试目录。Windows大小写敏感目录若平台支持则做真实测试，否则明确skip并以POSIX同名不同对象对照，不用skip冒充验证。

## 执行顺序与PR边界

1. **T12-A：已有路径canonical及trust/Skills共同根因。** 先红灯：trust set/get跨大小写、已保存旧格式非canonical键的拒绝、parent继承；同Skill文件大小写别名/junction去重；不同文件同名仍应collision。核对custom目录相关消费者。最小候选为canonicalizePath使用native realpath。只有确实需要时为旧trust键提供读取兼容；同实际对象的矛盾授权不能猜测覆盖，需明确报冲突并保留原文件，不能默默扩大授权。若兼容逻辑与共享helper不能清晰一起验收，进一步拆PR。缺失路径保留既有原样规则，不能为所有路径增加递归查找/fallback。
2. **T12-B：session resume与自定义sessionDir。** 独立复现共享session目录里header.cwd只因大小写/junction不同导致list/continueRecent找不到。保留默认session目录历史命名和其他project过滤，只在现有路径比较边界消费canonical身份。一个显式list/resume扫描的query身份只求一次；若同header.cwd重复出现，先计数再决定是否需要扫描owner的短生命去重，禁止长期索引或每条高频进度重复I/O。缺失cwd按明确词法等价规则处理；绝不能因无法解析而接纳其他项目会话。
3. **T12-C：local package remove匹配。** 复现settings侧相对scope base和输入侧cwd解析后实际同目录但字符串不等。修复match-key边界，保持两端原本不同的相对基准与npm/git语义；local remove只删配置条目，不删除项目包目录。覆盖存在、缺失、junction、相似prefix但不同对象及拒绝信任项目。输入身份每次命令一次，不反复在filter每个条目做同一I/O。
4. **T12-D：自定义资源目录来源归属（只有独立复现成立才开）。** skills.getSource与resource-loader.isUnderPath仍使用resolve+startsWith，可能与实际身份不一致；先明确source影响权限还是展示。针对实际存在的路径做基于目录关系的比较，不能靠全局大小写折叠混淆大小写敏感目录。无复现入口记录排除，不为了统一风格重写全部路径工具。

每批先补独立详细方案和根因证据，再最小实现，检查此前已读的hot-path-allocation-contract。路径解析仅在启动/显式加载/配置/会话扫描边界；高频lookup必须复用已得到的身份。记录canonical/stat次数、正常/缺失/失败路径和短生命引用释放；无对象池，无新的常规delta/frame工作。若改动触及高频路径，则补对应AST/source invariants、allocation benchmark、受控GC全链证据，不能仅跑路径单测。

补充共同helper热路径审计：SessionList.render每可见行调用isCurrentSessionPath→canonicalizePath；buildSessionTree在filter重建时也会解析session/parent路径。ConfigSelector.getResourceItemKey用于继承开关查询，需核对其调用是否来自render。修改共同helper前必须实测这些生产消费者的baseline/candidate，不得把它们错记成纯启动路径。现有逐行解析属于必须记录的基线成本；如果为满足本项约束调整缓存位置，应先在独立方案定义列表/资源owner、刷新/销毁失效和删除前重新核对身份，不能为了消除渲染I/O让删除安全检查使用陈旧结果。不扩展成无关的整个选择器重写。

旧trust记录的优先兼容方向（仍需红灯核对）：readTrustFile保持原始key/value和文件不变，在getEntry的低频读取边界把已有绝对路径解析成实际身份，以最近ancestor取决定；同身份true/false冲突明确失败，不随机先到先得。null是无决定，不能覆盖boolean拒绝。不要把旧的相对/无效键新解释为当前cwd授权。setMany有明确用户选择时，只清理被该次更新指向的实际同目录旧alias键并写入新决定；其他记录保持原样，普通读取不迁移文件。记录key数量与native调用数，避免在每级ancestor再次解析整份trust库。实现若复杂度超出本草案，先调整详细方案再写代码。

## 验收与交付

按相关trust/Skills/session/resource/package测试最小开始；保留Windows和POSIX对照、UNC/drive/分隔符的可实际验证范围。check/build:offline/Node26全套和六CI必过。每批单独PR并主动Codex review；发现问题修复推送后额外独立@codex review，等待最终head完成。无问题后merge、按recorded branch/head删除两端分支、同步main，再开始下一批。F01–F06仍是未获采纳的产品候选，不作为本轮自动实施项。
