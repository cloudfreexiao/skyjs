# 09 — 受限插件宿主（`snplugin` loader + `pluginHost`）

依赖：02、03（db）、04（webapp）、05（fs/archive）、06（subprocess，桌面）、07（crypt）、
08（media/tag）。能力键：`features().pluginSandbox`。
涉及：新增 `snplugin` 受限 loader（复用 `service-src/snjs.c` 的 VM 生命周期，但**独立
注册面**）、`js/plugin-host.js`（`globalThis.pluginHost`，仅插件管理服务内可见）、
`service/plugin-manager.js`（owner，注册名 `.pluginManager`）。

## 9.1 安全模型（核心）

- 插件运行在 `snplugin` loader 创建的 VM 中：**不注入** `skynetcore`、`io`、`socket`、
  `db`、`fs`、`subprocess`、`media` 等底层库；只注入白名单的 web polyfill 与 `songloft.*`
  等价的受控 bridge（下称 host bridge）。
- 所有能力经 host bridge → `pluginManager` → 对应 owner service，**每次调用做权限校验**。
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
- `net:insecure-tls` 仅在声明后放行 `httpc` 的 `insecureTls`（见 04）。

## 9.3 `pluginHost` bridge 面（stable，仅插件可见）

对插件暴露的对象**逐字沿用现有插件生态的 camelCase 命名**（外部兼容面豁免，见
[01-conventions.md](01-conventions.md) §1.1），保证现有插件源码零改动即可运行：

```js
// 生命周期钩子（插件在 globalThis 上覆盖）
onInit / onDeinit / onHTTPRequest / onWebSocket / onQueryBusy / onPlayEvent

// 存储
songloft.storage.{get,set,delete,keys}                    // 插件私有目录
songloft.persistentStorage.{get,set,delete,keys}          // DB 持久化，带配额

// 业务数据（经 .pluginManager 权限校验后转发到业务 owner）
songloft.songs.{list,getById,search,create,update,delete,download,
                setAutoDownload,organize,organizePreview,refreshMetadata}
songloft.playlists.{list,getById,getSongs,search,create,update,delete,
                    addSongs,removeSongs,reorder}
songloft.tags.{list,getById,create,update,delete,getSongTags,bindSongs,unbindSongs}

// 平台
songloft.plugin.{getToken,getHostUrl,getFileUrl,getNetworkAddresses}
songloft.log.{info,warn,error}
songloft.events.{onPlayEvent,offPlayEvent}
songloft.lyrics.{registerProvider,unregisterProvider}
songloft.covers.{registerProvider,unregisterProvider}

// 能力
songloft.command.{exec,start,stop,isRunning,download,deleteBin,listBin,exists}
songloft.fs.{readFile,writeFile,appendFile,readdir,unlink,exists,mkdir,stat,rename}
songloft.net.{udpBind,udpSend,udpClose,udpJoinMulticast,udpLeaveMulticast,
              udpGetLocalAddr,onData,tcpConnect}
songloft.comm.{call,onMessage}                            // inter-plugin
songloft.jsenv.{create,execute,executeWait,executeParallel,destroy,list}

// Web 标准面（polyfill）
fetch() / WebSocket / console / btoa / atob / TextEncoder / TextDecoder
crypto.{md5,sha1,sha256,sha256Bytes,rc4,aesEncrypt,aesDecrypt,rsaEncrypt,randomBytes}
zlib.{inflate,deflate,rawInflate}
```

- 这些 camelCase 名是**对外兼容契约**；SkyJS 内部实现（`pluginHost` 模块自身、host
  services、各 owner）遵循本规范 camelCase，无需名称映射层（风格已一致）。
- 各 bridge 内部落到前述通用库：`storage`→`fs`、`persistentStorage`→`db`、
  `command`→`subprocess`、`fetch`→`httpc`、`crypto`/`zlib`→`crypt`。
- 禁止透出：插件 VM 内 `typeof skynetcore === "undefined"`，无 `io`/`socket`/`db`/`fs`/
  `subprocess`/`media` 等底层库。

## 9.4 `pluginManager`（owner，注册名 `.pluginManager`）

生命周期与运维（对齐 Songloft `Manager`/`HealthChecker`/`HotReloader`/`AutoUpdater`）：

```js
pluginManager.install(zipSrc, opts?) -> Promise<PluginInfo>   // manifest+hash 校验，archive.extract
pluginManager.load(entryPath) -> Promise<void>                // 起插件 service（懒加载/singleflight 去重）
pluginManager.unload(entryPath) -> Promise<void>              // 卸 VM（空闲驱逐；provider 记录保留）
pluginManager.reload(entryPath) -> Promise<void>              // 起新→健康检查→原子切路由→退旧
pluginManager.enable/disable(entryPath) -> Promise<void>
pluginManager.health() -> Promise<Status[]>
pluginManager.list() -> Promise<PluginInfo[]>
```

- **热更新不依赖 inject**：`reload` 用“新旧 service 并存 + 原子切路由”实现（见 00 非目标）。
- 动态路由：插件注册的 HTTP/WebSocket 路由挂到 `webapp`，`reload` 时原子替换 handler。
- 健康检查：周期 ping 插件 `onQueryBusy`/健康端点；error 态自愈与空闲驱逐策略可配置。
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
