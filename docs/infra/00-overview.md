# 00 — 总览

## 目标

把 SkyJS 从“能跑通协议与示例”推进到“能承载生产级本地服务”的通用基建，覆盖
P0（核心必需）与 P1（生产化必需）两档能力。所有能力以**通用库**形式提供，不绑定
任何具体业务。

## 范围（本文档族覆盖）

P0：
- 核心运行时：可取消 RPC、超时、二进制消息、流控（`skynet` 扩展 + `stream` 内核）。
- SQLite 数据服务（`skyjs/db`，包 `@skyjs/db`）。
- HTTP 应用与流媒体传输（`skyjs/webapp` 包 `@skyjs/webapp` + Node `http`/`https` facade）。
- 文件/归档/子进程/密码学（Node `fs` + 引擎内建 `skyjs/fsx`/`subprocess`/`crypt` +
  包 `@skyjs/archive`）。
- 跨平台媒体与标签（包 `@skyjs/media`、`@skyjs/tag`）。
- 受限插件宿主（`snplugin` loader + 引擎内建 `skyjs/pluginHost`）。

P1：
- 配置、日志、指标（包 `@skyjs/config`、`@skyjs/metrics` + 引擎内建 `skyjs/log`）。
- 测试体系（引擎内建 `skyjs/testing` + 进程级套件）。
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
    │  require('<module>') 公开 API
L4 公开面  Node 面：js/builtins/*（仅内建）
           SkyJS 面：js/builtins/skyjs/*（8 个引擎内建入口）
                   + packages/<name>/（8 个 @skyjs 包入口，经 node_modules/@skyjs/* 解析）
           + Node 规范全局（01-conventions §3；归层判据见 node-compatibility §16.4.1）
    │  共享逻辑下沉
L3 能力内核  js/internal/<name>-core.js   （仅引擎；私有、可重构，包不得 require）
    │  skynet.call → 注册名 ".<cap>"
L2 owner service 层  引擎 service/<cap>-service.js（.fs/.subprocess/.pluginManager）
                     包 packages/<name>/service/<cap>-service.js（.sqlite/.media/.tag/.config/.metrics）
    │  skynetcore.<ns>.*（引擎，同步原生原语）；包内走自带 C 桥
L1 C 注入层  service-src/js-<cap>.c  →  编入 snjs 运行时（引擎）
             +  包内 C 桥 packages/<name>/native/src/*（package.json#skyjs.native → extpath / 静态链入）
    │
系统 / 第三方库（SQLite / libav / TagLib / OpenSSL / OS syscalls）
```

设计要点：
- **引擎层精简到可枚举**：引擎只有 `js/`（`bootstrap`/`loader`/`internal`/`builtins`
  /`types`）、`include/`、`service/`（3 个 owner）、`service-src/`、`platform/`、
  `test/`+`tools/`（不进产物）。领域能力、第三方依赖与原生产物一律随 `@skyjs/<name>`
  包分发。收口标准：删掉 `packages/` 后引擎仍能构建、启动、跑通自验证用例。
  引擎逐文件清单见 [../node-compatibility.md](../node-compatibility.md) §16.4.2，
  逐包实现清单见 §16.4.3.1，边界检查清单见 §16.4.4。
- **"JS 调 C"只有一种形状：C 桥模块。** 首方 C 桥编进 `snjs.so`，第三方按
  `package.json#skyjs.native` 在 `extpath` 非空时动态装载、移动端静态链入；
  没有签名编组、没有通用 FFI，也不把普通 `.so` 直接暴露给 JS
  （node-compatibility §3.4–3.5）。
- **沉重或阻塞的原生调用只在 owner service 内同步执行**，靠 Skynet 单服务串行调度
  天然串行化；其它服务通过异步 `skynet.call` 访问，绝不在业务服务里直接跑阻塞原语。
- **大数据走二进制消息 + 流控**，不走 lua-seri 大 Map 路径（见 02、TODO.md 待办 3）。
- **平台差异显式化**：能力不支持时 `skynet.features()` 缺失且调用抛 `ERR_UNSUPPORTED_PLATFORM`，
  禁止静默降级。
- **CommonJS 是运行时自身的模块格式**：`js/` 源码同样经 `require` 组织，不使用
  IIFE 全局注入；新增模块靠构建期目录清单收录，不再维护 C 侧懒加载表。

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
