# 02 — 核心运行时：可取消 RPC、二进制消息、stream

依赖：无（最底层）。被依赖：几乎所有库。
涉及文件：扩展 `js/skynet.js`、`service-src/snjs.c`、`js/socket.js`；新增 `js/stream.js`。

## 2.1 `skynet` 扩展（stable）

在不破坏现有 `call/send/dispatch/timeout/sleep/fork/...` 语义的前提下新增：

```js
// 可取消 + 超时 call。opts 可选。
skynet.callEx(addr, typename, msg, opts?) -> Promise<reply>
// opts = { signal?: AbortSignal, timeoutMs?: number, binary?: boolean }
//  - signal 触发   → reject(ERR_CANCELLED)，并向对端发送 cancel 通知
//  - timeoutMs 到 → reject(ERR_TIMEOUT)
//  - binary=true  → 不解码，reply 原样为 ArrayBuffer

skynet.features() -> object          // 见 01-conventions §5
skynet.abortController() -> AbortController   // WHATWG 对齐；引擎缺失时用内建 polyfill
skynet.deadline(timeoutMs) -> AbortSignal     // 定时自动 abort 的便捷 signal
```

现有 `skynet.call` 保持不变（等价 `callEx` 不带 opts）。

### late-response 处理

- `pendingCalls` 现以 `session -> {resolve, reject}` 路由（见 `js/skynet.js`）。
- 扩展：取消/超时后从 `pendingCalls` 删除该 session，并登记到 `abandonedSessions`
  （带过期时间的集合）。后到的 `PTYPE_RESPONSE/PTYPE_ERROR` 命中 `abandonedSessions`
  时静默丢弃，不得错配到新请求，也不得抛 “No dispatch”。
- owner service 侧提供 `cancel(session)` 约定消息类型，收到后尽快释放资源。

### cancel 传播协议

- 请求消息头（lua payload 首字段或约定 envelope）携带 `reqId`。
- 取消时向 owner service 发送 `{op:"cancel", reqId}`；owner 侧据 `reqId` 找到在途
  原生任务并中止。未实现 cancel 的服务至少要在结果产出后被丢弃（由上面 late-response 兜底）。

## 2.2 二进制消息 wrapper（stable）

- service 间大块二进制统一用 `ArrayBuffer` 直传：`skynet.send(addr, "lua", ab)` /
  `skynet.callEx(..., {binary:true})`，避免 base64（见现状：`js/io.js` 异步走 base64）。
- 提供 envelope 助手，用固定小头 + 二进制体，避免把大 buffer 塞进 lua-seri Map：

```js
skynet.frameEncode(headerObj, bodyAb?) -> ArrayBuffer   // 小头 JSON + 长度前缀 + body
skynet.frameDecode(ab) -> { header, body }                // body 为 ArrayBuffer 视图（零拷贝尽力而为）
```

- 约定：header 只放小的控制字段（op、reqId、offset、eof、code…），大数据永远在 body。

## 2.3 `stream` 库（stable）

`globalThis.stream`，统一可读/可写/管道/取消/背压语义，供 `fs`/`webapp`/`subprocess`/
`media`/`db blob` 复用。基于 credit-based 流控，防止大流打爆 JS 堆。

### 数据类型

- chunk 一律为 `ArrayBuffer`（二进制优先）；文本由上层用 `TextDecoder` 处理。

### readable

```js
stream.readable(source) -> Readable
// source = {
//   pull(n, ctx) -> Promise<ArrayBuffer|null>,  // 返回 null 表示 EOF
//   cancel(reason)?,                              // 被取消时释放底层资源
//   highWaterMark?: number                      // 缓冲字节上限，默认 1 MiB
// }
Readable.read(n?) -> Promise<ArrayBuffer|null>
Readable.iterator() -> AsyncIterator<ArrayBuffer>
Readable.pipe(writable, opts?) -> Promise<void>      // opts = { signal?, end?: boolean }
Readable.cancel(reason?) -> Promise<void>
Readable.closed -> boolean
```

### writable

```js
stream.writable(sink) -> Writable
// sink = {
//   write(ab, ctx) -> Promise<void>,   // 返回的 Promise 未 resolve 即形成背压
//   close()?  -> Promise<void>,
//   abort(reason)? -> Promise<void>
// }
Writable.write(ab) -> Promise<void>       // resolve 表示已被下游接收（可继续）
Writable.end() -> Promise<void>
Writable.abort(reason?) -> Promise<void>
Writable.needDrain -> boolean            // 水位标志
```

### pipe / 组合

```js
stream.pipe(readable, writable, { signal?, timeoutMs? }) -> Promise<void>
stream.pipeline(...stages, { signal? }) -> Promise<void>   // 任一环失败→全链取消
```

### 跨 service 流

- 生产者服务与消费者服务之间用 credit 协议：消费者先发 `credit(nBytes)`，生产者按
  credit 发 chunk（`frameEncode` 头含 `seq/eof`），消费者处理完再补 credit。
- 消费者断开（socket close / 取消）→ 立即向生产者发 `cancel`，生产者停止拉取并释放。

### 错误与取消

- 取消：`ERR_CANCELLED`；超时：`ERR_TIMEOUT`；下游拒收超上限：`ERR_LIMIT_EXCEEDED`。
- 任何一端出错，另一端在下一次 read/write 时收到同一错误对象（或其 `code`）。

## 2.4 与现有 socket 的衔接

`js/socket.js` / C socket bridge 增补（供 `webapp`/流控使用）：
- 连接关闭通知：已有 `onClose/onError`；补充“写缓冲水位/可写”信号（`onWritable`）与
  暂停/恢复读取（`socket.pause(id)` / `socket.resumeRead(id)`）。
- 写队列水位查询：`socket.sendbuffer(id) -> bytes`（映射 skynet 的 sendbuffer 概念），
  供 `stream.writable` 判定背压。

> 注：具体 C 侧信号实现细节在实现批次定；本文件只固定 JS 侧契约名与语义。

## 2.5 错误码

`ERR_CANCELLED / ERR_TIMEOUT / ERR_LIMIT_EXCEEDED / ERR_PROTOCOL / ERR_INTERNAL`
（定义见 01-conventions §4）。

## 2.6 验收

- 1 GiB 流经 `stream.pipe` 传输：JS 堆稳定（缓冲不超过 highWaterMark × 常数）。
- 消费者断开后 1 秒内生产者停止拉取并释放底层 fd/资源。
- `callEx` 超时/取消后：`pendingCalls` 无残留；随后到达的迟到响应被丢弃且不告警为错配。
- 与现有 `test/config-async.json` 场景不回归（链式 await、并发挂起、双 session 隔离）。
