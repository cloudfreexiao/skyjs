# 06 — 子进程（`subprocess`）

依赖：02（stream、取消）。能力键：`features().subprocess`。
平台：仅桌面/服务器（Linux/macOS/Windows）；**移动端不支持**，调用抛 `ERR_UNSUPPORTED_PLATFORM`。
涉及：新增 `js/subprocess.js`（`globalThis.subprocess`）、`service/subprocess_service.js`
（owner，注册名 `.subprocess`）、`service-src/js-subprocess.c`（`skynetcore.subprocess`）。

## 6.1 架构

- 子进程句柄由 owner service 独占管理；stdio 管道读循环在 owner 内运行，通过
  `stream` + 二进制消息把 stdout/stderr 流式推给调用方。
- 每个调用方（尤其插件）有独立命名空间与配额；owner 统一在取消/超时/服务退出时
  `kill` 并回收，杜绝孤儿进程（对齐 Songloft `Cleanup`/`managedProcess` 语义）。

## 6.2 `skynetcore.subprocess`（internal，仅 owner）

```
skynetcore.subprocess.spawn(program, args, opts) -> { pid, stdin_fd, stdout_fd, stderr_fd }
// opts = { cwd, env(array), stdin: "pipe"|"ignore", stdout/stderr: "pipe"|"ignore" }
// POSIX: posix_spawn；Windows: CreateProcess
skynetcore.subprocess.wait(pid) -> { exited, code, signal }   // 非阻塞轮询或事件
skynetcore.subprocess.kill(pid, sig)
skynetcore.subprocess.write(fd, ab, off, len) -> n
skynetcore.subprocess.read(fd, ab, off, len) -> n | "eof"
skynetcore.subprocess.close(fd)
```

移动端构建不编入该模块；`features().subprocess.available === false`。

## 6.3 `subprocess` 客户端库（stable）

`globalThis.subprocess`。

```js
// 一次性执行，收集输出（有上限）
subprocess.exec(program, args, opts?) -> Promise<{ code, stdout, stderr }>
// opts = { cwd?, env?, stdin?: string|ArrayBuffer, timeout_ms?, signal?,
//          max_output?: 10*1024*1024, encoding?: "utf-8"|"binary" }

// 流式：长任务 / 大输出（转码、下载器）
subprocess.spawn(program, args, opts?) -> Child
// Child = {
//   pid,
//   stdin:  Writable,        // 关闭即 EOF
//   stdout: Readable,
//   stderr: Readable,
//   wait() -> Promise<{ code, signal }>,
//   kill(sig?) -> void
// }

// 后台常驻进程管理（命名，防重复，配额）
subprocess.start(name, program, args, opts?) -> Promise<{ pid }>
subprocess.stop(name) -> Promise<void>
subprocess.is_running(name) -> Promise<boolean>
subprocess.list() -> Promise<Array<{ name, pid }>>

subprocess.version -> string
```

### 约束

- `max_output`：`exec` 累计 stdout/stderr 超限 → 截断并标记（或抛 `ERR_LIMIT_EXCEEDED`，
  按 opts 决定）；对齐 Songloft `limitedBuffer`（默认 10MB）与 `maxExecTimeout`（300s）。
- 配额：单调用方最大并发进程数（默认 10，对齐 `maxProcessesPerPlugin`）。
- 取消/超时：`signal`/`timeout_ms` 触发 → `kill` 子进程（先 TERM 后 KILL）并回收管道。
- 安全：`program` 解析与允许目录由调用方（如插件宿主）在上层限制；本库不隐式扩展 PATH。
- Windows：信号语义映射（无 POSIX signal 时用 TerminateProcess）；退出码/超时一致对外。

## 6.4 错误码

`ERR_UNSUPPORTED_PLATFORM`（移动端）、`ERR_NOT_FOUND`（program 不存在）、
`ERR_TIMEOUT`/`ERR_CANCELLED`、`ERR_LIMIT_EXCEEDED`（输出/进程数超限）、
`ERR_PERMISSION`（上层沙箱拒绝）、`ERR_IO`。
`err.detail` 可带 `{ exit_code, signal, hint }`（如 ELF interpreter 缺失提示）。

## 6.5 验收

- ffmpeg/ffprobe 管道：`spawn` 流式读取 stdout，取消后进程被 kill、管道回收、无孤儿。
- `exec` 输出上限与超时：超限截断/报错语义正确。
- 后台进程：`start/stop/is_running`，服务退出时全部清理。
- 移动端构建：`features().subprocess.available === false`，调用抛 `ERR_UNSUPPORTED_PLATFORM`。
- 长跑：反复 spawn/kill 无 fd/进程泄漏。
