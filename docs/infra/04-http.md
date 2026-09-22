# 04 — HTTP 应用与流媒体传输（`webapp` + `httpd/httpc` 扩展）

依赖：02（stream、取消）、现有 `js/http.js`(httpd/httpc/http_internal)、`js/socket.js`、
`js/sockethelper.js`、`js/websocket.js`。能力键：`features().http_stream`。
涉及：新增 `js/webapp.js`（`globalThis.webapp`）；扩展 `js/http.js`。

设计原则：**保留** `http.js` 的协议解析（`recv_header/parse_header/recv_chunked_body`）
与连接池不动；在其上叠加应用框架与流式能力。现有 `httpd.read_request/write_response`、
`httpc.request` 语义保持兼容，新增能力用新方法名。

## 4.1 `webapp` 应用框架（stable）

`globalThis.webapp`：路由、中间件、参数、统一错误、请求生命周期与取消。

```js
webapp.create(opts?) -> App
// opts = { body_limit?: bytes, trust_proxy?: bool, request_id?: bool }

App.use(mw)                                  // 全局中间件
App.route(prefix) -> Router                  // 子路由组
App.get|post|put|delete|head|patch(path, ...handlers)
App.listen(host, port, opts?) -> Promise<{ port, close() }>   // 基于 socket.listen
App.on_error(handler)                        // 统一错误 → 响应

// 路径参数：/songs/:id、通配 /assets/*rest
```

### Context（`ctx`）

```js
ctx.method / ctx.path / ctx.params / ctx.query / ctx.headers
ctx.req_id                         // request_id 中间件注入
ctx.signal                         // AbortSignal：客户端断开/超时即 abort
ctx.body_text() -> Promise<string>
ctx.body_json() -> Promise<any>
ctx.body_buffer() -> Promise<ArrayBuffer>          // 受 body_limit 限制
ctx.body_stream() -> Readable                      // 流式读请求体（大上传）
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
webapp.mw.recover(opts)            // 捕获 handler 异常 → on_error（对齐 chi Recoverer）
webapp.mw.request_id()             // 生成/透传 X-Request-Id
webapp.mw.compress(opts)           // gzip；作用于文本类 content-type 白名单
webapp.mw.jwt(verify_fn)           // 认证 hook：verify_fn(token, ctx) -> claims|throw
webapp.mw.access_log(log)          // 结合 log 库输出访问日志
```

- `jwt` 只提供校验挂点，不内置具体签发/密钥策略（业务用 `crypt` 自行实现）。

## 4.2 静态文件与 Range（stable）

`ctx.file(path, opts?)`：
- 支持 `Range` / `Content-Range` / 多段拒绝（只实现单区间，Songloft 现状一致）、`HEAD`。
- `ETag`（默认 size+mtime 弱校验）、`Last-Modified`、`If-None-Match`/`If-Modified-Since` → 304。
- `Content-Type` 按扩展名推断，可 `opts.content_type` 覆盖。
- 预压缩：`opts.precompressed` 时优先返回同目录 `.br`/`.gz`（对齐 Songloft `newPrecompressedFS`）。
- 通过 `fs` 流式发送，不整文件读入内存；`ctx.signal` 触发即停止发送（见 §4.4）。

## 4.3 请求体与 multipart

```js
ctx.multipart() -> AsyncIterator<Part>
// Part = { name, filename?, content_type?, headers, stream() -> Readable, text()/buffer() }
```
- 强制 `body_limit` 与单 part 限额；超限 `ERR_LIMIT_EXCEEDED`（映射 413）。
- 二进制 part 以 `ArrayBuffer`/`Readable` 交付，不做 latin1/base64 迂回。

## 4.4 流式响应与背压

- `ctx.stream(readable)`：
  - 有 `content-length` → 定长；否则 `Transfer-Encoding: chunked`。
  - 通过 `stream.pipe` 到 socket，遵守 §2.3 背压：socket 写缓冲高于水位则暂停上游拉取。
  - 客户端断开 → `ctx.signal` abort → 取消 readable（进而取消底层 DB/media/proxy）。
- 明确支持大音频、HLS 切片、实时转码流、反向代理流；**禁止**把整响应缓冲进 JS 堆。

## 4.5 `httpd` 扩展（server 低层，兼容新增）

保留现有 `httpd.read_request/write_response`；新增：

```js
httpd.write_head(write_fn, status, headers)                  // 只写头
httpd.write_stream(write_fn, readable, headers, {signal})    // 异步流式 body（背压感知）
httpd.read_body_stream(reader, headers) -> Readable          // 流式读请求体
```

现有同步 generator 版 `write_response(write_fn, code, body|fn, header)` 不变（小响应仍可用）。

## 4.6 `httpc` 扩展（client 低层，兼容新增）

保留现有 `httpc.request`（缓冲式）；新增流式与策略：

```js
httpc.request_stream(method, url, opts?) -> Promise<{ status, headers, body: Readable }>
// opts = { headers?, body?: ArrayBuffer|Readable, signal?, timeout_ms?,
//          follow_redirects?: number, cookie_jar?, proxy?: url, ca_file?,
//          insecure_tls?: bool, max_body?: bytes }
httpc.cookie_jar() -> CookieJar                 // set/get，供多请求共享
```

- redirect：`follow_redirects` 上限，默认关闭（对齐 X-Fetch-No-Redirect 场景）。
- proxy：通用 HTTP proxy；`insecure_tls` 仅在能力门控下生效（对齐 net:insecure-tls）。
- body/time 限额：`max_body` 超限 `ERR_LIMIT_EXCEEDED`；`timeout_ms` 覆盖含 body 读取的整生命周期。
- 流式：`body` 为 `Readable` 时流式上传；响应 `body` 为 `Readable` 时流式下载，配合 `stream.pipe`。

## 4.7 socket 断连 → 取消映射

- server：每个连接维护 `AbortController`；`on_close/on_error`（见 `js/socket.js`）触发
  `abort(ERR_CANCELLED)`，`ctx.signal` 随之 abort，向下游传播（DB 查询、media 转码、proxy 拉取）。
- 慢客户端：写背压（§4.4）保证不缓冲整首音频；100 并发慢读连接下内存/FD 稳定。

## 4.8 错误码

- `ERR_HTTP_HEADER_TOO_LARGE`(→413/431)、`ERR_LIMIT_EXCEEDED`(413)、`ERR_PROTOCOL`(400)、
  `ERR_TIMEOUT`(408/504)、`ERR_CANCELLED`（连接断开，不发响应）。
- `on_error` 未处理的异常默认 500，并经 `recover` 记录（不泄漏栈到响应体）。

## 4.9 验收（对拍 Songloft 契约）

- Range/HEAD/ETag/304 行为与 Songloft `ctx.file` 等价路径一致。
- multipart 上传（插件包、封面、备份）限额与解析正确。
- HLS/实时转码流：chunked、无 Content-Length、断连即停、内存有界。
- 反向代理流：上游断开/客户端断开双向取消。
- 1 GiB 文件下载 + 100 并发慢客户端：内存、FD 稳定（长跑）。
