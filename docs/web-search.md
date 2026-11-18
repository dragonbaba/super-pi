# SearXNG 网页搜索

Super Pi 可以用 `web_search` 直接查询 SearXNG，返回标题、链接和摘要。自建实例的默认搜索接口无需 API Key。部分上游引擎有单独的凭据要求，在 SearXNG 配置中处理。页内操作和登录场景使用浏览器工具。

## 连接实例

Windows 上安装到 `LOCALAPPDATA/SuperPi/SearXNG` 的本机实例会自动注册 `web_search`。`SP_SEARXNG_URL` 可以指定其他地址。

部署独立的 SearXNG 实例后，在它的 `settings.yml` 中启用 JSON。仅在本机使用时，可以将服务端口绑定到环回地址。

```yaml
search:
  formats:
    - html
    - json
```

启动 Super Pi 前，将实例的基址传入 `SP_SEARXNG_URL`。下面是 PowerShell 示例。

```powershell
$env:SP_SEARXNG_URL = 'http://127.0.0.1:8888'
superpi
```

`tool_search({query: "web search"})` 会发现 `web_search`。工具接受 `query` 和可选的 `limit`，默认返回前五个可用结果。查询发送到配置的 SearXNG 实例，由它转交启用的上游引擎。结果文本属于外部内容。

Codemode 脚本可以直接读取 `result.details.results` 中的 `title`、`url` 和 `snippet`。调用 `text()` 时可只选需要的字段，例如只保留链接。

每个会话在内存中保留最近一次完整、非空的搜索结果。60 秒内用相同关键词和 `limit` 查询时可以复用，传入 `fresh: true` 可立即重新请求。工具发现沿用固定的 Codemode 入口，返回的搜索结果追加到对话历史。

Windows 本机实例使用 `http://127.0.0.1:8888`。首次搜索遇到连接被拒时，Super Pi 会尝试启动服务并在健康检查通过后发送搜索请求。本机服务已运行时直接查询。

仍有 Super Pi 会话打开时，受管理的本机搜索服务继续运行，包括其他项目的会话。最后一个 Super Pi 进程正常退出时，服务及其子进程一并关闭。手动启动的服务和远程实例由部署方管理。Windows 强制终止进程时，下一次正常退出会检查遗留的服务。

接口返回 HTTP 403 时，检查实例访问规则和 `search.formats` 是否启用 `json`。如果部分引擎失败但仍有可用结果，工具会保留结果并提示失败数量。

部署和接口文档见 [SearXNG 安装](https://docs.searxng.org/admin/installation) 和 [SearXNG 搜索 API](https://docs.searxng.org/dev/search_api.html)。
