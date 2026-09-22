# 09 — 受限插件宿主（`snplugin` loader + `plugin_host`）

依赖：02、03（db）、04（webapp）、05（fs/archive）、06（subprocess，桌面）、07（crypt）、
08（media/tag）。能力键：`features().plugin_sandbox`。
涉及：新增 `snplugin` 受限 loader（复用 `service-src/snjs.c` 的 VM 生命周期，但**独立
注册面**）、`js/plugin_host.js`（`globalThis.plugin_host`，仅插件管理服务内可见）、
`service/plugin_manager.js`（owner，注册名 `.plugin_manager`）。

## 9.1 安全模型（核心）

- 插件运行在 `snplugin` loader 创建的 VM 中：**不注入** `skynetcore`、`io`、`socket`、
  `db`、`fs`、`subprocess`、`media` 等底层库；只注入白名单的 web polyfill 与 `songloft.*`
  等价的受控 bridge（下称 host bridge）。
- 所有能力经 host bridge → `plugin_manager` → 对应 owner service，**每次调用做权限校验**。
- 一插件一 service（Actor）：插件的消息队列、生命周期、资源配额独立；对齐 Songloft
  `ServiceScheduler` 的 session+mailbox 模型（本身即仿 Skynet），迁移自然。

## 9.2 权限模型

沿用 Songloft manifest 的权限枚举（作为通用能力标签，不含业务语义差异）：

```
storage / persistent-storage /
songs.read / songs.write / playlists.read / playlists.write /
tags.read / tags.write / tags.* /
inter-plugin / command / jsenv / fs / fs:music / net / net:insecure-tls / websocket
```

- host bridge 每个 action 映射到所需权限（前缀匹配），未声明即拒绝（`ERR_PERMISSION`）。
- `command`（子进程）在移动端因平台不支持返回 `ERR_UNSUPPORTED_PLATFORM`（见 06）。
- `net:insecure-tls` 仅在声明后放行 `httpc` 的 `insecure_tls`（见 04）。

## 9.3 `plugin_host` bridge 面（stable，仅插件可见）

对插件暴露的对象命名沿用其生态既有约定（保持插件源码零改动即可运行）：

```js
// 生命周期钩子（插件覆盖）：on_init / on_deinit / on_http_request / on_websocket / on_query_busy
// 事件：events.on_play_event / off_play_event
// 存储：storage.{get,set,delete,keys}         （插件私有目录）
//       persistent_storage.{get,set,delete,keys}（DB 持久化，带配额）
// 数据：songs.* / playlists.* / tags.*         （经 .plugin_manager 校验后转发到业务 owner）
// 平台：plugin.{get_token,get_host_url,get_file_url,get_network_addresses}
// 能力：command.* / fs.* / net.*(udp/tcp) / websocket.* / jsenv.*
// 网络：fetch()（受控 http 客户端，走 04 的 httpc + 权限/SSRF 防护）
// 加密：crypto.{md5,sha1,sha256,sha256_bytes,rc4,aes_encrypt,aes_decrypt,rsa_encrypt,random_bytes}
// 压缩：zlib.{inflate,deflate,raw_inflate}
```

- 上表命名沿用 Songloft 插件 API（`songloft.*`）以保证插件兼容；`plugin_host` 是 SkyJS
  侧提供这些 bridge 的通用宿主实现，内部落到 §前述各库。
- 禁止透出：插件 VM 内 `typeof skynetcore === "undefined"`、无 `io`/`socket`/`db`。

## 9.4 `plugin_manager`（owner，注册名 `.plugin_manager`）

生命周期与运维（对齐 Songloft `Manager`/`HealthChecker`/`HotReloader`/`AutoUpdater`）：

```js
plugin_manager.install(zip_src, opts?) -> Promise<PluginInfo>   // manifest+hash 校验，archive.extract
plugin_manager.load(entry_path) -> Promise<void>                // 起插件 service（懒加载/singleflight 去重）
plugin_manager.unload(entry_path) -> Promise<void>              // 卸 VM（空闲驱逐；provider 记录保留）
plugin_manager.reload(entry_path) -> Promise<void>              // 起新→健康检查→原子切路由→退旧
plugin_manager.enable/disable(entry_path) -> Promise<void>
plugin_manager.health() -> Promise<Status[]>
plugin_manager.list() -> Promise<PluginInfo[]>
```

- **热更新不依赖 inject**：`reload` 用“新旧 service 并存 + 原子切路由”实现（见 00 非目标）。
- 动态路由：插件注册的 HTTP/WebSocket 路由挂到 `webapp`，`reload` 时原子替换 handler。
- 健康检查：周期 ping 插件 `on_query_busy`/健康端点；error 态自愈与空闲驱逐策略可配置。
- 安装/校验：`archive` 限额解压 + manifest hash 校验；`.jsc` 旧字节码不复用（重新编译）。

## 9.5 资源配额

- 每插件：内存（复用 snjs per-service memlimit）、并发进程数（6 章配额）、UDP/TCP socket
  数、持久化存储字节数、WebSocket 连接数、请求超时上限。
- 失控插件：SIGNAL 打断（复用现有 microtask 链打断机制）→ 必要时 KILL 该插件 service，
  不影响宿主与其它插件（对齐 async 调度不变量记忆）。

## 9.6 SDK 完整性（P1 补齐）

当前九个内置插件实测依赖：`storage / songs / playlists / tags / command / fetch /
crypto / zlib / websocket`。以下当前 manifest 未用，作为 SDK 完整性放 P1：
`net`(UDP/multicast)、`jsenv.*`（子 VM/子 service 执行）、入站 `websocket` 事件全集。

## 9.7 错误码

`ERR_PERMISSION`（未声明权限/越权路径/SSRF 私网拦截）、`ERR_UNSUPPORTED_PLATFORM`
（移动端 command 等）、`ERR_LIMIT_EXCEEDED`（配额）、`ERR_NOT_FOUND`（插件不存在）、
`ERR_PROTOCOL`（manifest/包非法）、`ERR_CANCELLED`/`ERR_TIMEOUT`。

## 9.8 验收（对拍现有插件，源码零改动）

- 插件 VM 内 `skynetcore/io/socket/db` 不可见；越权路径、SSRF 私网请求、未授权 command
  全部被拒。
- Miot（storage/songs/playlists/command/websocket/crypto）不改业务源码通过契约测试。
- Cloudflared（command/fs：下载二进制+tar.gz 解压+启动后台进程）通过。
- DAV（fetch/songs/playlists/storage）与 Subsonic（fetch/songs/playlists/fs:music）通过。
- `reload` 原子切换：切换瞬间无请求丢失、无旧 VM 残留 job 复活。
