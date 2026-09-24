# 04 — HTTP 应用与流媒体传输（`skyjs/webapp` + Node `http`/`https`）

依赖：02（stream 内核、取消）、`js/internal/http-core.js`（协议解析，原
`js/http.js` 的 `httpInternal`）、`js/internal/net-core.js`（合并 `js/socket.js` +
`js/sockethelper.js`）。能力键：`features().httpStream`。

归层（node-compatibility §16.4.1、ND-33）：

- **引擎内建**：`js/internal/http-core.js`（唯一协议内核）、`js/internal/net-core.js`、
  `js/builtins/http.js` + `js/builtins/https.js` + `js/builtins/net.js`/`tls.js`
  （Node facade）。
- **`@skyjs` 包**：`skyjs/webapp` → `packages/webapp/`（`lib/app.js`、`lib/middleware.js`
  等），`skyjs/websocket` → `packages/websocket/`（`lib/handshake.js`、`lib/frame.js` 等）。

`skyjs/webapp` 与 `skyjs/websocket` 是保留入口名，但引擎内建表不含它们；loader 按
§3.1 层 2 回退 `node_modules/@skyjs/<name>`。两者站在**公开的** `http`/`net`/`stream`
之上，不得 `require('js/internal/http-core.js')`、不得触 `skynetcore.*`（§16.4.1
规则 1）。

设计原则：**一份内核、多个 facade**。`recvHeader/parseHeader/recvChunkedBody` 与连接池
下沉到 `js/internal/http-core.js`，只实现一次；Node `http`/`https` facade 直接用它，
`@skyjs/webapp` 走公开 `http`/`net`/`stream` 面。旧 `httpd`/`httpc`/`httpInternal`
全局随重构移除，不保留兼容层。

## 4.1 `webapp` 应用框架（stable）

`require('skyjs/webapp')`：路由、中间件、参数、统一错误、请求生命周期与取消。

```js
webapp.create(opts?) -> App
// opts = { bodyLimit?: bytes, trustProxy?: bool, requestId?: bool }

App.use(mw)                                  // 全局中间件
App.route(prefix) -> Router                  // 子路由组
App.get|post|put|delete|head|patch(path, ...handlers)
App.listen(host, port, opts?) -> Promise<{ port, close() }>   // 基于 socket.listen
App.onError(handler)                        // 统一错误 → 响应

// 路径参数：/songs/:id、通配 /assets/*rest
```

### Context（`ctx`）

```js
ctx.method / ctx.path / ctx.params / ctx.query / ctx.headers
ctx.reqId                         // requestId 中间件注入
ctx.signal                         // AbortSignal：客户端断开/超时即 abort
ctx.bodyText() -> Promise<string>
ctx.bodyJson() -> Promise<any>
ctx.bodyBuffer() -> Promise<ArrayBuffer>          // 受 bodyLimit 限制
ctx.bodyStream() -> Readable                      // 流式读请求体（大上传）
ctx.multipart() -> AsyncIterator<Part>             // 见 §4.3

ctx.status(code) -> ctx
ctx.set(name, value) -> ctx
ctx.send(body)                     // string | ArrayBuffer | object(JSON)
ctx.json(obj)
ctx.stream(readable, opts?)        // 异步流式响应（chunked 或已知长度）
ctx.file(path, opts?)              // 静态文件：Range/HEAD/ETag/Last-Modified/304，见 §4.2
ctx.redirect(url, code?)
```

### 内置中间件（可选装配）

```js
webapp.mw.cors(opts)               // Access-Control-*；等价 Songloft 现 CORS 语义
webapp.mw.recover(opts)            // 捕获 handler 异常 → onError（对齐 chi Recoverer）
webapp.mw.requestId()             // 生成/透传 X-Request-Id
webapp.mw.compress(opts)           // gzip；作用于文本类 content-type 白名单
webapp.mw.jwt(verifyFn)           // 认证 hook：verifyFn(token, ctx) -> claims|throw
webapp.mw.accessLog(log)          // 结合 log 库输出访问日志
```

- `jwt` 只提供校验挂点，不内置具体签发/密钥策略（业务用 `crypt` 自行实现）。

## 4.2 静态文件与 Range（stable）

`ctx.file(path, opts?)`：
- 支持 `Range` / `Content-Range` / 多段拒绝（只实现单区间，Songloft 现状一致）、`HEAD`。
- `ETag`（默认 size+mtime 弱校验）、`Last-Modified`、`If-None-Match`/`If-Modified-Since` → 304。
- `Content-Type` 按扩展名推断，可 `opts.contentType` 覆盖。
- 预压缩：`opts.precompressed` 时优先返回同目录 `.br`/`.gz`（对齐 Songloft `newPrecompressedFS`）。
- 通过 `fs` 流式发送，不整文件读入内存；`ctx.signal` 触发即停止发送（见 §4.4）。

## 4.3 请求体与 multipart

```js
ctx.multipart() -> AsyncIterator<Part>
// Part = { name, filename?, contentType?, headers, stream() -> Readable, text()/buffer() }
```
- 强制 `bodyLimit` 与单 part 限额；超限 `ERR_LIMIT_EXCEEDED`（映射 413）。
- 二进制 part 以 `ArrayBuffer`/`Readable` 交付，不做 latin1/base64 迂回。

## 4.4 流式响应与背压

- `ctx.stream(readable)`：
  - 有 `content-length` → 定长；否则 `Transfer-Encoding: chunked`。
- 通过 `streamCore.pipe` 到 socket，遵守 §2.3 背压：socket 写缓冲高于水位则暂停上游拉取。
  - 客户端断开 → `ctx.signal` abort → 取消 readable（进而取消底层 DB/media/proxy）。
- 明确支持大音频、HLS 切片、实时转码流、反向代理流；**禁止**把整响应缓冲进 JS 堆。

## 4.5 `internal/http-core`（server 侧内核，internal）

`js/internal/http-core.js` 是 server 低层原语，只给 `builtins/http.js`/`https.js`
使用，不对外暴露（包不得 require）。`@skyjs/webapp` 走公开 `http`/`net`/`stream`
面。原 `httpd.*` 能力下沉到这里：

```js
httpCore.readRequest(reader) -> { method, url, headers, body }
httpCore.writeHead(write, status, headers)                  // 只写头
httpCore.writeStream(write, readable, headers, {signal})    // 异步流式 body（背压感知）
httpCore.readBodyStream(reader, headers) -> Readable        // 流式读请求体
```

`builtins/http.js` 在此之上实现 Node 语义的 `createServer`/`Server`/
`IncomingMessage`/`ServerResponse`；`@skyjs/webapp` 在同一公开 facade 之上实现自有
`ctx` 模型。

## 4.6 `internal/http-core`（client 侧内核，internal）

原 `httpc.request` 的客户端能力同样下沉到 `internal/http-core.js`，供 Node
`http`/`https` facade 与 `builtins/fetch.js` 复用：

```js
httpCore.request(method, url, opts?) -> Promise<{ status, headers, body: Readable }>
// opts = { headers?, body?: ArrayBuffer|Readable, signal?, timeoutMs?,
//          followRedirects?: number, cookieJar?, proxy?: url, caFile?,
//          insecureTls?: bool, maxBody?: bytes }
httpCore.cookieJar() -> CookieJar              // set/get，供多请求共享
```

- Node `http.request`/`https.request` 与 `fetch` 各自做语义适配；缓冲式便捷接口
  建在流式内核之上，不反向依赖。
- redirect：`followRedirects` 上限，默认关闭（对齐 X-Fetch-No-Redirect 场景）。
- proxy：通用 HTTP proxy；`insecureTls` 仅在能力门控下生效（对齐 net:insecure-tls）。
- body/time 限额：`maxBody` 超限 `ERR_LIMIT_EXCEEDED`；`timeoutMs` 覆盖含 body 读取的整生命周期。
- 流式：`body` 为 `Readable` 时流式上传；响应 `body` 为 `Readable` 时流式下载，配合 `streamCore.pipe`。

## 4.7 socket 断连 → 取消映射

- server：每个连接维护 `AbortController`；`onClose/onError`（见 `js/internal/net-core.js`）触发
  `abort(ERR_CANCELLED)`，`ctx.signal` 随之 abort，向下游传播（DB 查询、media 转码、proxy 拉取）。
- 慢客户端：写背压（§4.4）保证不缓冲整首音频；100 并发慢读连接下内存/FD 稳定。

## 4.8 错误码

- `ERR_HTTP_HEADER_TOO_LARGE`(→413/431)、`ERR_LIMIT_EXCEEDED`(413)、`ERR_PROTOCOL`(400)、
  `ERR_TIMEOUT`(408/504)、`ERR_CANCELLED`（连接断开，不发响应）。
- `onError` 未处理的异常默认 500，并经 `recover` 记录（不泄漏栈到响应体）。

## 4.9 验收（对拍 Songloft 契约）

- Range/HEAD/ETag/304 行为与 Songloft `ctx.file` 等价路径一致。
- multipart 上传（插件包、封面、备份）限额与解析正确。
- HLS/实时转码流：chunked、无 Content-Length、断连即停、内存有界。
- 反向代理流：上游断开/客户端断开双向取消。
- 1 GiB 文件下载 + 100 并发慢客户端：内存、FD 稳定（长跑）。
