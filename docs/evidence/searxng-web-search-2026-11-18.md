# SearXNG 直连搜索

配置 `SP_SEARXNG_URL` 后，`tool_search` 可发现 `web_search`。Codemode 通过现有工具分派把查询以表单 POST 发送到配置的实例。工具返回标题、链接和摘要，遵循调用取消和请求期限。读取从实际响应流计量，上限为 1 MiB。部分上游引擎失败时保留可用结果；接口失败和空结果分别报告。

本机 Windows 使用固定的 SearXNG 源码版本 `b99cf7496`，通过 Waitress 监听 `127.0.0.1:8888`。运行时把 Unix 账户诊断限制在 POSIX 路径，Valkey 保持关闭。DuckDuckGo、Brave、Google 和 Qwant 在现场返回验证码、限流或拒绝访问。最终配置启用实测可用的 Mwmbl 和 GitHub。两次真实搜索各返回所请求的 5 条结果，当次没有引擎失败，端到端耗时约 2.32 秒和 1.71 秒，均使用匿名查询。

本地 HTTP 夹具验证了请求编码、结果去重、错误和取消。同一会话在 60 秒内两次查询相同关键词和结果数，服务只收到一次 POST。显式刷新、超时过期、换会话、换结果数及部分失败都会重新请求。实际 Codemode 分派中，发现工具与返回搜索结果前后的系统提示和工具定义序列化一致。改动只涉及显式搜索、工具发现和进程生命周期，未触及 provider、逐帧渲染或进度热路径。

并发回归先挂起原查询，再让显式刷新提前完成。原查询随后仍返回自己的结果，下一次普通查询复用刷新后的结果，两次上游请求完成后无需第三次 POST。

Windows 本机安装在 `ECONNREFUSED` 时按需启动。等待中的同进程调用共享健康检查，一次取消会结束对应查询的等待。服务使用常驻安装目录和自己的临时路径，接受连接后继续原请求。远程或手动部署的其他地址继续通过配置的 API 访问。

此前的实际 Super Pi CLI 冷启动测试使用 `gpt-6.2-sol`。从环回连接被拒到模型找到工具并返回三条结构化结果，工具耗时约 3.85 秒，完整 CLI 回合约 39.7 秒。服务已启动时，同一查询约 3.03 秒。两次搜索均有一个引擎失败，保留其余结果。

退出回归使用两个离线构建的 Windows RPC CLI，模拟不同项目和配置目录。空闲启动时没有拉起搜索服务。第一个 CLI 退出后，第二个无搜索地址的 CLI 仍保护搜索进程和它的子进程。最后一个正常退出后，两个进程与管理记录全部清理。晚于退出到达的服务启动也被取消。

```text
npm run check
npm run build:offline
node --experimental-strip-types --test tests/searxng-web-search.test.ts tests/tool-search-category.test.ts tests/bundled-extensions.test.ts tests/codemode-default-config.test.ts tests/codemode-session.test.ts
```

Windows 生命周期测试使用 `SP_TEST_WINDOWS_PYTHON` 指向本机 Python 可执行文件，再运行 `node --experimental-strip-types --test tests/searxng-managed-lifetime.test.mjs`。

类型检查、12 包离线构建和 160 项相关测试通过。跨项目回归中，最后一个 CLI 从收到退出请求到搜索进程全部停止耗时 870 毫秒。
