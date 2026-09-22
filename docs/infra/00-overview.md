# 00 — 总览

## 目标

把 SkyJS 从“能跑通协议与示例”推进到“能承载生产级本地服务”的通用基建，覆盖
P0（核心必需）与 P1（生产化必需）两档能力。所有能力以**通用库**形式提供，不绑定
任何具体业务。

## 范围（本文档族覆盖）

P0：
- 核心运行时：可取消 RPC、超时、二进制消息、流控（`skynet` 扩展 + `stream`）。
- SQLite 数据服务（`db`）。
- HTTP 应用与流媒体传输（`webapp` + `httpd/httpc` 流式扩展）。
- 文件/归档/子进程/密码学（`fs`、`archive`、`subprocess`、`crypt` 扩展）。
- 跨平台媒体与标签（`media`、`tag`）。
- 受限插件宿主（`snplugin` loader + `plugin_host`）。

P1：
- 配置、日志、指标（`config`、`log`、`metrics`）。
- 测试体系（`testing` + 进程级套件）。
- 移动端可嵌入 ABI（Android AAR / iOS XCFramework）。

## 非目标（本文档族明确排除）

- 不迁移 Songloft 的 handlers/services/约 192 个路由等业务实现。
- 不实现 Redis / MongoDB / Kafka / 服务发现 / 多节点 cluster（当前无实际依赖）。
- 不实现 `sharetable / snax / harbor master-slave / inject`；插件热更新以
  “起新服务→健康检查→原子切路由→退旧服务”实现，不依赖 inject。
- 不改动 `3rd/` 下任何文件（skynet、quickjs 子模块保持零修改）。

## 分层模型

```
业务/插件 JS
    │  Promise API（globalThis.<lib>）
客户端库层  js/<lib>.js
    │  skynet.call → 注册名 ".<cap>"
owner service 层  service/<cap>_service.js   （独占资源、串行化）
    │  skynetcore.<ns>.*（同步原生原语）
C 注入层  service-src/js-<cap>.c  →  编入 snjs 运行时
    │
系统 / 第三方库（SQLite / libav / TagLib / OpenSSL / OS syscalls）
```

设计要点：
- **沉重或阻塞的原生调用只在 owner service 内同步执行**，靠 Skynet 单服务串行调度
  天然串行化；其它服务通过异步 `skynet.call` 访问，绝不在业务服务里直接跑阻塞原语。
- **大数据走二进制消息 + 流控**，不走 lua-seri 大 Map 路径（见 02、TODO.md 待办 3）。
- **平台差异显式化**：能力不支持时 `skynet.features()` 缺失且调用抛 `ERR_UNSUPPORTED_PLATFORM`，
  禁止静默降级。

## Songloft 作为黑盒契约基线

Songloft 不进入任何库接口，仅在各库“验收”小节作为对拍来源：
- SQLite：38 个 migration + JSON1 查询作为差分样例。
- HTTP：Range/HEAD/ETag/multipart/断连取消/反向代理的行为对拍。
- 媒体：既有音频样本的元数据、转码时长/码率、seek、HLS、缩略图差分。
- 插件：现有九个内置插件的 manifest 与 API 调用清单作为兼容目标。

## 平台矩阵（贯穿全部文档）

| 平台 | 目标形态 | 媒体 | 子进程 |
|---|---|---|---|
| Linux x86_64/arm64 | 可执行 + .so | libav 静态 | 支持 |
| macOS arm64/x86_64 | 可执行 + .dylib | libav 静态 | 支持 |
| Windows x86_64 (MinGW) | 可执行 + .dll | libav 静态 | 支持 |
| Android arm64/armv7/x86_64 | AAR（静态库 + JNI） | libav 静态（NDK） | 不支持（`ERR_UNSUPPORTED_PLATFORM`） |
| iOS arm64 (+ simulator) | XCFramework（全静态） | libav 静态 | 不支持（`ERR_UNSUPPORTED_PLATFORM`） |

移动端媒体能力**始终走内嵌 `media` 服务**，不用外部 ffmpeg 进程，因此不受
“子进程不支持”限制。
