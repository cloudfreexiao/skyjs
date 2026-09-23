# SkyJS 通用基建文档（docs/infra）

本目录规范化 SkyJS 的 P0/P1 通用基建：统一库名、全局命名面、C 注入命名、
owner service 命名、接口签名、错误码与能力清单。**当前批次只写文档，不写实现代码，
也不迁移任何业务**（Songloft 仅作为黑盒契约来源，用于验收对拍）。

与既有文档的关系：
- 编码规范、C/JS 边界、验收入口见 [../DEVELOPMENT.md](../DEVELOPMENT.md)。
- 遗留事项与已知限制见 [../TODO.md](../TODO.md)。
- 历史演进与问题归因见 [../HISTORY.md](../HISTORY.md)，性能基线见 [../bench.md](../bench.md)。
- 本目录只描述**新增/扩展的通用能力**；不重复既有库的实现细节。

## 阅读顺序

1. [00-overview.md](00-overview.md) — 范围、非目标、分层模型。
2. [01-conventions.md](01-conventions.md) — **命名总表（唯一定义处）**、错误码、能力探测、通用契约。
3. 各能力库：
   - [02-core-runtime.md](02-core-runtime.md) — `skynet` 扩展、二进制消息、`stream`。
   - [03-sqlite.md](03-sqlite.md) — `db`。
   - [04-http.md](04-http.md) — `webapp` + `httpd/httpc` 流式扩展。
   - [05-fs-archive.md](05-fs-archive.md) — `fs` + `archive`。
   - [06-subprocess.md](06-subprocess.md) — `subprocess`。
   - [07-crypto.md](07-crypto.md) — `crypt` 扩展。
   - [08-media-tag.md](08-media-tag.md) — `media` + `tag`。
   - [09-plugin-host.md](09-plugin-host.md) — `snplugin` loader + `pluginHost`。
   - [10-config-log-metrics.md](10-config-log-metrics.md) — `config` + `log` + `metrics`。
   - [11-testing.md](11-testing.md) — `testing`。
   - [12-mobile.md](12-mobile.md) — 移动端可嵌入 ABI。
4. 工程化：
   - [13-build-ci.md](13-build-ci.md) — 构建开关与 CI 矩阵。
   - [14-integration-release.md](14-integration-release.md) — 差分/门禁/发布。
   - [15-roadmap-estimates.md](15-roadmap-estimates.md) — 批次、依赖、估算、决策门。

## 三层结构（详见 01-conventions）

| 层 | 命名 | 职责 |
|---|---|---|
| C 注入层 | `skynetcore.<ns>` | snjs 运行时内的原生绑定，JS 可直接调用（同步、非阻塞原语） |
| owner service 层 | `service/<cap>-service.js`，注册名 `.<cap>` | 独占持有原生资源，串行化访问，对外收发消息 |
| 客户端库层 | `js/<lib>.js` → `globalThis.<lib>` | Promise API，`skynet.call` 到 owner service，供业务使用 |

## 命名总表（速查，规范定义在 01-conventions.md）

客户端库：`db / stream / webapp / fs / archive / subprocess / media / tag /
config / log / metrics / testing / pluginHost`。

现有库（保留不改名）：`skynet / socket / crypt / sockethelper / cluster /
gateserver / httpd / httpc / httpInternal / websocket / io / console`。

## 交付约束

- 本批只产出本目录下 17 份 Markdown（README + 00~15）。
- 不新增或修改任何 `.c / .cc / .js / Makefile` 实现文件。
- 命名总表在 [01-conventions.md](01-conventions.md) 唯一定义，其它文档只引用，不重复定义。
- 所有库按“通用能力”设计，接口层不得出现 Songloft 业务名词（songs/playlist 等仅可作为
  黑盒验收样例出现在验收小节，不进入库接口）。
