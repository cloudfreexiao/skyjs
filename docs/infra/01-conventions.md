# 01 — 命名与通用契约（规范）

本文件是**命名总表与通用契约的唯一定义处**。其它文档只引用本文，不重复定义。

## 1. 标识符与文件命名

- JS 标识符一律 `lowerCamelCase`（类 `UpperCamelCase`、常量 `UPPER_SNAKE_CASE`）。
  项目目标为兼容 Node 代码（LLRT 路线），命名对齐 JS 生态惯例；C 源码内部命名
  （`js_*`/`snjs_*`）保持 C 规范不变。
- **冻结域**（字符串字面量逐字保留）：env/config 键（`jsLoader`、`jsMemLimit`、
  `__json_config`…）；线协议与命令串（skynet 命令、cluster 帧、tls "client"/"server"、
  HTTP/WS header 名）；io.js↔ioservice.js RPC op 串（`"read_file"` 等）；测试验收
  标记串。算子/架构域名词白名单：`iso7816_4`、`x86_64` 等保留原名。
- 禁 `var`；库以 IIFE 组织，仅暴露约定的 `globalThis.<lib>` 与 `__snjs_*` C 契约。
- 文件命名：
  - 客户端库：`js/<lib>.js`。
  - owner service：`service/<cap>-service.js`（如 `fs-service.js`）。
  - C 源：`service-src/js-<cap>.c`（C++ 适配用 `.cc`）。
  - 文档：`docs/infra/NN-topic.md`。

### 1.1 外部兼容面豁免（唯一例外）

`lowerCamelCase` 约束适用于**本项目自有**的库与注入名。以下属于**外部既定契约**，
必须逐字沿用对方命名，不得改写：

| 面 | 命名风格 | 原因 |
|---|---|---|
| 插件 bridge（`songloft.*`、`onHTTPRequest` 等，见 09） | camelCase | 现有插件源码直接调用，改名即破坏兼容 |
| Android JNI / Java 侧（`isRunning`/`getPort`，见 12） | camelCase | Java 语言惯例与宿主客户端约定 |
| Web 标准 API（`AbortSignal`、`TextDecoder`、`ArrayBuffer`…） | 标准原名 | 与 WHATWG/ECMA 对齐 |
| HTTP header 名 | 协议原名 | 线协议 |

移动端 C ABI 仍用 snake_case（`skyjs_start` 等），camelCase 只出现在 Java/Swift 包装层。

## 2. 三层结构与命名映射

| 能力 | 客户端库 `globalThis.<lib>` (js/) | C 注入 `skynetcore.<ns>` | owner service (`.<cap>`) | C 源 |
|---|---|---|---|---|
| 核心运行时 | `skynet`(扩展) / `stream` | 复用现有 bridge | 无（进程内） | 扩展 `snjs.c` |
| SQLite | `db` | `skynetcore.sqlite` | `.sqlite` (`sqlite-service.js`) | `js-sqlite.c` |
| HTTP 应用 | `webapp` | 复用 `socket`/`tls` | 无（库内建） | 复用 |
| HTTP 底层 | `httpd`/`httpc`(扩展) | 复用 | 无 | 复用 `http.js` |
| 文件（异步/流） | `fs` | `skynetcore.fs`(扩展 io) | `.fs` (`fs-service.js`) | 扩展 `js-io.c` |
| 归档 | `archive` | `skynetcore.archive` | `.archive` (owner 可选) | `js-archive.c` |
| 子进程 | `subprocess` | `skynetcore.subprocess` | `.subprocess` (`subprocess-service.js`) | `js-subprocess.c` |
| 密码学 | `crypt`(扩展) | `skynetcore.crypt`(扩展) | 无（同步原语） | 扩展 `js-crypto.c` |
| 媒体 | `media` | `skynetcore.media` | `.media` (`media-service.js`) | `js-media.c` |
| 标签 | `tag` | `skynetcore.tag` | 复用 `.media` 或 `.tag` | `js-tag.cc` |
| 配置 | `config` | 复用 `command`(GETENV) | `.config` (`config-service.js`) | 复用 |
| 日志 | `log` | 复用 `error` | 无（可选 `.log-sink`） | 复用 |
| 指标 | `metrics` | 复用 | `.metrics` (`metrics-service.js`) | 复用 |
| 测试 | `testing` | 无 | 无 | 无 |
| 插件宿主 | `pluginHost` | 受限白名单 | `.pluginManager` | `snplugin` loader |

owner service 是否常驻/懒启由各库文档定义；无 owner 的库（如 `webapp`/`stream`/
`crypt`/`testing`）在调用方服务内直接运行。

## 3. 现有面（保留，不改名）

`skynetcore` 现有注入（见 `service-src/snjs.c` `register_bridge`）：
`send / command / intCommand / genId / now / error / mem / response /
errorResponse / redirect / socket.* / netpack.* / pack / unpack / str /
__load_runtime`，以及 `skynetcore.crypt`、`skynetcore.io`、`skynetcore.tls`(条件)。

现有 `globalThis` 库：`skynet / socket / crypt / sockethelper / cluster /
gateserver / httpd / httpc / httpInternal / websocket / io / console`。

现有库加载 env 键（`snjs.c` `optstring` 默认值）：`jsLoader`(skynet.js) /
`jsSocket` / `jsCrypt` / `jsSockethelper` / `jsCluster` / `jsGateserver` /
`jsHttp` / `jsWebsocket` / `jsIo`，加内部 `ioservice`。新库沿用同一 env 键机制，
键名 `js<Lib>`（如 `jsDb`、`jsStream`、`jsWebapp`），默认 `./js/<lib>.js`。

新库的懒加载登记（`lazy_setup_js` 的 `F` 表：`g`=暴露的全局名，`d`=依赖路径）需
同步扩展，保证按需加载与依赖顺序。

## 4. 错误契约

- 所有异步 API 失败时 `reject(Error)`；同步 API `throw Error`。
- `Error` 附带：
  - `err.code`：字符串枚举（见下）。
  - `err.detail`：可选，结构化补充（原生错误码、路径、statement 等，脱敏后）。
- 核心错误码枚举（跨库统一）：

| code | 含义 |
|---|---|
| `ERR_CANCELLED` | 被 `AbortSignal`/取消触发中止 |
| `ERR_TIMEOUT` | 超过 deadline |
| `ERR_UNSUPPORTED_PLATFORM` | 当前平台不提供该能力 |
| `ERR_PERMISSION` | 权限/沙箱拒绝 |
| `ERR_LIMIT_EXCEEDED` | 超过大小/数量/配额上限 |
| `ERR_NOT_FOUND` | 目标不存在 |
| `ERR_BUSY` | 资源忙/锁冲突（如 SQLITE_BUSY） |
| `ERR_PROTOCOL` | 协议/格式非法 |
| `ERR_IO` | 底层 I/O 失败 |
| `ERR_INTERNAL` | 未归类的内部错误 |

各库可定义带前缀的子码（如 `ERR_DB_CONSTRAINT`、`ERR_HTTP_HEADER_TOO_LARGE`），
但必须能归并到上表之一（通过 `err.code` 前缀或 `err.detail.class`）。

## 5. 能力探测

新增 `skynet.features() -> object`，返回当前运行时的能力表，例如：

```js
{
  version: "0.2.0",
  sqlite:        { available: true,  version: "3.46.0" },
  httpStream:   { available: true },
  fsAsync:      { available: true },
  archive:       { available: true },
  subprocess:    { available: false, reason: "ERR_UNSUPPORTED_PLATFORM" },
  media:         { available: true,  backend: "libav", codecs: ["mp3","aac","flac"] },
  tag:           { available: true,  backend: "taglib" },
  cryptExt:     { available: true },
  pluginSandbox:{ available: true }
}
```

- 不支持的能力：`available: false` 且 `reason` 为对应错误码；对应库调用抛该码。
- 每个客户端库额外暴露 `<lib>.version`（字符串常量），用于跨版本诊断。

## 6. 取消与超时通用契约

- 统一用 `AbortSignal`（QuickJS-ng 若无内置则由 `stream`/核心库提供最小 polyfill，
  语义与 WHATWG 对齐：`signal.aborted`、`signal.reason`、`addEventListener('abort')`）。
- 约定：任何可能长耗时的 API 接受可选 `{ signal, timeoutMs }`：
  - `signal` 触发 → `reject(ERR_CANCELLED)`，并向下游（DB/进程/媒体/流）传播取消。
  - `timeoutMs` 到期 → `reject(ERR_TIMEOUT)`，同样触发下游中止。
- owner service 侧：收到取消后必须尽快释放原生资源（statement、fd、子进程、libav ctx）。
- late response（请求已取消但响应姗姗来迟）必须被 `skynet` 扩展层丢弃，不得错配
  （详见 02-core-runtime）。

## 7. 二进制与大数据契约

- service 间大块二进制统一用 `ArrayBuffer` 直传（不经 base64、不经 lua-seri 大 Map）。
- 需要分片流式时用 `stream` 库的 chunk 协议（credit-based，见 02）。
- 整数：跨边界的 64 位整数用 `BigInt`；对外 JSON 序列化时，超过
  `Number.MAX_SAFE_INTEGER` 的值显式转字符串（各库在文档内标注具体字段）。

## 8. 版本与稳定性

- 文档族版本随 `skynet.features().version` 对齐。
- 接口标注稳定级别：`stable` / `experimental` / `internal`；`internal`（如 `__snjs_*`、
  `skynetcore.__load_runtime`）不对业务/插件暴露。
- 破坏性变更须同步更新本表、对应库文档，并按 [../DEVELOPMENT.md](../DEVELOPMENT.md)
  的三处文档同步约定处理。
