# 05 — 文件（Node `fs` + `skyjs/fsx`）与归档（`skyjs/archive`）

依赖：02（stream 内核、取消）。能力键：`features().fsAsync`、`features().archive`。
归层（node-compatibility §16.4.1、ND-33）：

- **引擎内建**：`js/builtins/fs/`（Node facade：`require('fs')` / `require('fs/promises')`）、
  `js/builtins/skyjs/fsx.js`（自有流式 API）、`js/internal/fs-core.js`（共享组合逻辑）、
  `service-src/js-fs.c`（原 `js-io.c`）、owner `service/fs-service.js`(`.fs`)。
  `fsx` 与 `fs` 共用同一条 owner/内核，拆出去会让默认构建不自洽。
- **`@skyjs` 包**：`skyjs/archive` → `packages/archive/`（`lib/zip.js`、`lib/targz.js`、
  `lib/limits.js`；可选 `native/src/js-archive.c` 作 C 桥加速，默认纯 JS）。引擎内建
  表不含 `archive`，loader 按 §3.1 层 2 回退 `node_modules/@skyjs/archive`。

包内不得 `require('js/internal/fs-core.js')`、不得触 `skynetcore.*`；`@skyjs/archive`
只用公开面（`fs`/`fs/promises`/`zlib`/`stream`/`skyjs/fsx`，见 §16.4.1 规则 1）。
包依赖**其它 L4 公开入口**是允许的，被禁止的只有 `js/internal/*` 与 `skynetcore.*`
这两个私有面。包能力的 owner（若有）随包放 `packages/<name>/service/`。

## 与旧 `io` 的分层

旧 `globalThis.io`（`js/io.js`）与 `js/ioservice.js` **随重构移除**，不保留第二套入口：

- Node 语义走 `require('fs')` / `require('fs/promises')`，覆盖 Node 20 `fs` 公开 API。
- SkyJS 自有语义走 `require('skyjs/fsx')`（原 `io.js` 的便捷/流式扩展，如
  `readText`/`writeAtomic`/`walk`/`copy`/`move`/`safeJoin`）。
- 两者共享 `js/internal/fs-core.js` 与 `skynetcore.fs` 原语；异步/binary 路径统一经
  `.fs` owner + 二进制 envelope，旧 base64 RPC 废弃。

## 5.1 `skynetcore.fs`（internal，`js-fs.c`）

原 `skynetcore.io`（`service-src/js-io.c`）整体更名为 `skynetcore.fs`（`js-fs.c`），
现有 readFile/writeFile/stat/readdir/open/fread/... 原语保留语义并在此基础上补：

```
skynetcore.fs.freadInto(handle, ab, off, len) -> n     // 读入既有 buffer，零额外拷贝
skynetcore.fs.fwriteFrom(handle, ab, off, len) -> n
skynetcore.fs.ftruncate(handle, size)
skynetcore.fs.fsync(handle) / fdatasync(handle)
skynetcore.fs.realpath(path) -> string
skynetcore.fs.chmod(path, mode) / fchmod(handle, mode)
skynetcore.fs.chown(path, uid, gid) / fchown(handle, uid, gid)
skynetcore.fs.utimes(path, atime, mtime) / futimes(handle, atime, mtime)
skynetcore.fs.link(old, new) / symlink(target, linkpath) / readlink(path)
skynetcore.fs.mkstemp(dir, prefix) -> {handle, path}
skynetcore.fs.statvfs(path) -> {total, free}            // 磁盘空间（对齐 diskspace_*）
skynetcore.fs.watch(path, opts) -> watcher              // 原生 watcher（平台能力门控）
```

所有原语必须返回结构化 errno（供 JS 侧映射 Node `err.code`/`err.errno`/`err.syscall`/
`err.path`），而不是只抛文本错误。跨平台：Windows 分支复用 skynet 的 compat 层；
`symlink`/`statvfs` 在 Windows 用等价 API。

## 5.2 Node `fs` facade（stable）

`require('fs')` / `require('fs/promises')`，**完整覆盖 Node 20 `fs` 公开 API**
（callback/sync/Promise、`FileHandle`、`createReadStream`/`createWriteStream`、
`watch`/`watchFile`、`Stats`/`Dirent`/`constants`），边界与验收见
[../node-compatibility.md](../node-compatibility.md) §8。错误对象优先暴露 Node 字段。

## 5.3 `skyjs/fsx` 自有库（stable）

`require('skyjs/fsx')`：原 `globalThis.io` 的便捷/高级语义，均接受可选末参
`{ signal, timeoutMs }`。这一面不是 Node `fs`，命名与返回类型按 SkyJS 自有风格。

```text
// 整文件（便捷，内部仍有大小上限保护）
fsx.readFile(path) -> Promise<ArrayBuffer>
fsx.readText(path, encoding="utf-8") -> Promise<string>
fsx.writeFile(path, data) -> Promise<void>            // data: ArrayBuffer|string
fsx.writeAtomic(path, data) -> Promise<void>          // 写临时文件 + fsync + rename

// 流式
fsx.readStream(path, opts?) -> Readable               // opts = { start?, end? }（Range 支持）
fsx.writeStream(path, opts?) -> Writable              // opts = { append?, mode? }

// 元数据 / 目录
fsx.stat(path) -> Promise<Stat>                        // {size, mtime, isDir, isFile, mode}
fsx.exists(path) -> Promise<boolean>
fsx.readdir(path, opts?) -> Promise<Entry[]>           // opts = { withTypes? }
fsx.walk(path, opts?) -> AsyncIterator<Entry>          // 递归；opts = { followSymlinks?, maxDepth? }
fsx.mkdir(path, opts?) -> Promise<void>                // opts = { recursive? }
fsx.remove(path, opts?) -> Promise<void>               // opts = { recursive? }
fsx.rename(old, new) -> Promise<void>                  // 同盘原子
fsx.copy(src, dst, opts?) -> Promise<void>             // 流式；跨盘 fallback
fsx.move(src, dst) -> Promise<void>                    // rename，EXDEV 时 copy+remove
fsx.mktemp(opts?) -> Promise<{ path, close() }>        // opts = { dir?, prefix? }
fsx.realpath(path) -> Promise<string>
fsx.diskUsage(path) -> Promise<{ total, free }>

// 安全路径
fsx.safeJoin(base, ...parts) -> string                // 归一化 + 越界拒绝（throw ERR_PERMISSION）
fsx.version -> string
```

### 关键语义

- `writeAtomic` / `writeStream({atomic:true})`：写临时文件→`fsync`→`rename`，避免半写。
- `walk` 用 `dType` 优化，避免逐条 `stat`（对齐 Songloft scanner 的遍历优化诉求）。
- `copy`/`readStream`/`writeStream` 全部走 `streamCore`，大文件不进 JS 堆；`signal` 取消即停。
- `safeJoin`：所有由外部输入拼接的路径必须经此函数，越出 `base` 抛 `ERR_PERMISSION`。
  Node `fs` facade 的路径权限校验也复用同一函数，保证两种入口边界一致。

## 5.4 `skyjs/archive` 库（stable）

`require('skyjs/archive')`：受限 zip / tar.gz 列举与解压（安装插件包、主题包、
二进制包等场景）。

```js
archive.list(src, opts?) -> Promise<Entry[]>
// src: path | ArrayBuffer | Readable；Entry = { name, size, isDir, mode }

archive.extract(src, destDir, opts?) -> Promise<{ files: number, bytes: number }>
// opts = {
//   maxFiles?: 200, maxBytes?: 500*1024*1024, maxFileBytes?: bytes,
//   stripPrefix?: string,        // 只解某子目录（如 "static/"）
//   allowPrefix?: string[],      // 仅允许这些前缀
//   executablePrefix?: string[], // 这些前缀解压后置 0755（如 "bin/"）
//   signal?, timeoutMs?
// }

archive.readEntry(src, name) -> Promise<ArrayBuffer>   // 取单个成员

archive.version -> string
```

### 安全约束（强制）

- 路径穿越防护：所有成员目标路径必须落在 `destDir` 内（`require('skyjs/fsx').safeJoin`
  校验；`fsx` 是引擎内建公开入口，包可以依赖），
  绝对路径/`..`/符号链接逃逸一律拒绝（`ERR_PERMISSION`）。
- 压缩炸弹防护：`maxFiles` / `maxBytes` / `maxFileBytes` 任一超限即中止并清理，抛
  `ERR_LIMIT_EXCEEDED`；解压比异常（高压缩比）触发保护。
- 解压走流式，不将整个归档解入内存。
- 支持 zip 与 tar.gz（对齐 Songloft `readEntryFromZip`/`extractStaticFromZip`/
  `extractBinFromZip` 与 `command.download` 的 tar.gz 解压）。

## 5.5 错误码

`ERR_NOT_FOUND`（路径/成员不存在）、`ERR_PERMISSION`（越界/权限）、
`ERR_LIMIT_EXCEEDED`（大小/数量/磁盘满）、`ERR_IO`、`ERR_CANCELLED`/`ERR_TIMEOUT`、
`ERR_PROTOCOL`（归档格式损坏）。

## 5.6 验收

- 大文件 `copy`/`readStream`：内存有界、可取消、跨盘 fallback 正确。
- `writeAtomic` 崩溃点测试：中断后不留半写文件（临时文件被清理或未 rename）。
- `walk` 深目录：性能与正确性（含 exclude/maxDepth）。
- 恶意归档：`../` 逃逸、绝对路径、符号链接、超量文件/字节、压缩炸弹全部被拒绝并清理。
- `fsx.safeJoin` 单元用例覆盖常见逃逸向量。
- Node `fs` 与 `skyjs/fsx` 对同一路径的权限判定一致（共用 `internal/fs-core`）。
