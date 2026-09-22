# 05 — 文件（`fs`）与归档（`archive`）

依赖：02（stream、取消）。能力键：`features().fs_async`、`features().archive`。
涉及：新增 `js/fs.js`（`globalThis.fs`）、`js/archive.js`（`globalThis.archive`）；
扩展 `service-src/js-io.c`（流式原语）；owner `service/fs_service.js`(`.fs`)、
`service/archive_service.js`(`.archive`，可选合并进 `.fs`)。

## 与现有 `io` 的分层

- 现有 `globalThis.io`（`js/io.js`）**保留不动**：同步整文件读写 + 同步元数据 +
  经 `ioservice` 的 base64 异步接口。适合小文件/元数据。
- 新增 `globalThis.fs`：**流式、异步、二进制优先**，适合大文件、目录遍历、拷贝、
  临时文件、原子替换。二者共用底层扩展后的 `skynetcore.io`/`skynetcore.fs`，语义分工明确。

## 5.1 `skynetcore.fs`（internal，扩展 `js-io.c`）

在现有 `skynetcore.io`（read_file/write_file/stat/readdir/open/fread/... 见
`service-src/js-io.c`）基础上补：

```
skynetcore.io.fread_into(handle, ab, off, len) -> n     // 读入既有 buffer，零额外拷贝
skynetcore.io.fwrite_from(handle, ab, off, len) -> n
skynetcore.io.ftruncate(handle, size)
skynetcore.io.fsync(handle)
skynetcore.io.realpath(path) -> string
skynetcore.io.chmod(path, mode)
skynetcore.io.symlink(target, linkpath) / readlink(path)
skynetcore.io.mkstemp(dir, prefix) -> {handle, path}
skynetcore.io.statvfs(path) -> {total, free}            // 磁盘空间（对齐 diskspace_*）
```

跨平台：Windows 分支复用 skynet 的 compat 层；`symlink`/`statvfs` 在 Windows 用等价 API。

## 5.2 `fs` 客户端库（stable）

`globalThis.fs`。均接受可选末参 `{ signal, timeout_ms }`。

```js
// 整文件（便捷，内部仍有大小上限保护）
fs.read_file(path) -> Promise<ArrayBuffer>
fs.read_text(path, encoding="utf-8") -> Promise<string>
fs.write_file(path, data) -> Promise<void>             // data: ArrayBuffer|string
fs.write_atomic(path, data) -> Promise<void>           // 写临时文件 + fsync + rename

// 流式
fs.read_stream(path, opts?) -> Readable                // opts = { start?, end? }（Range 支持）
fs.write_stream(path, opts?) -> Writable               // opts = { append?, mode? }

// 元数据 / 目录
fs.stat(path) -> Promise<Stat>                         // {size, mtime, is_dir, is_file, mode}
fs.exists(path) -> Promise<boolean>
fs.readdir(path, opts?) -> Promise<Entry[]>            // opts = { with_types? }
fs.walk(path, opts?) -> AsyncIterator<Entry>           // 递归；opts = { follow_symlinks?, max_depth? }
fs.mkdir(path, opts?) -> Promise<void>                 // opts = { recursive? }
fs.remove(path, opts?) -> Promise<void>                // opts = { recursive? }
fs.rename(old, new) -> Promise<void>                   // 同盘原子
fs.copy(src, dst, opts?) -> Promise<void>              // 流式；跨盘 fallback
fs.move(src, dst) -> Promise<void>                     // rename，EXDEV 时 copy+remove
fs.mktemp(opts?) -> Promise<{ path, close() }>         // opts = { dir?, prefix? }
fs.realpath(path) -> Promise<string>
fs.disk_usage(path) -> Promise<{ total, free }>

// 安全路径
fs.safe_join(base, ...parts) -> string                 // 归一化 + 越界拒绝（throw ERR_PERMISSION）
fs.version -> string
```

### 关键语义

- `write_atomic` / `write_stream({atomic:true})`：写临时文件→`fsync`→`rename`，避免半写。
- `walk` 用 `d_type` 优化，避免逐条 `stat`（对齐 Songloft scanner 的遍历优化诉求）。
- `copy`/`read_stream`/`write_stream` 全部走 `stream`，大文件不进 JS 堆；`signal` 取消即停。
- `safe_join`：所有由外部输入拼接的路径必须经此函数，越出 `base` 抛 `ERR_PERMISSION`。

## 5.3 `archive` 库（stable）

`globalThis.archive`：受限 zip / tar.gz 列举与解压（安装插件包、主题包、二进制包等场景）。

```js
archive.list(src, opts?) -> Promise<Entry[]>
// src: path | ArrayBuffer | Readable；Entry = { name, size, is_dir, mode }

archive.extract(src, dest_dir, opts?) -> Promise<{ files: number, bytes: number }>
// opts = {
//   max_files?: 200, max_bytes?: 500*1024*1024, max_file_bytes?: bytes,
//   strip_prefix?: string,        // 只解某子目录（如 "static/"）
//   allow_prefix?: string[],      // 仅允许这些前缀
//   executable_prefix?: string[], // 这些前缀解压后置 0755（如 "bin/"）
//   signal?, timeout_ms?
// }

archive.read_entry(src, name) -> Promise<ArrayBuffer>   // 取单个成员

archive.version -> string
```

### 安全约束（强制）

- 路径穿越防护：所有成员目标路径必须落在 `dest_dir` 内（`fs.safe_join` 校验），
  绝对路径/`..`/符号链接逃逸一律拒绝（`ERR_PERMISSION`）。
- 压缩炸弹防护：`max_files` / `max_bytes` / `max_file_bytes` 任一超限即中止并清理，抛
  `ERR_LIMIT_EXCEEDED`；解压比异常（高压缩比）触发保护。
- 解压走流式，不将整个归档解入内存。
- 支持 zip 与 tar.gz（对齐 Songloft `readEntryFromZip`/`extractStaticFromZip`/
  `extractBinFromZip` 与 `command.download` 的 tar.gz 解压）。

## 5.4 错误码

`ERR_NOT_FOUND`（路径/成员不存在）、`ERR_PERMISSION`（越界/权限）、
`ERR_LIMIT_EXCEEDED`（大小/数量/磁盘满）、`ERR_IO`、`ERR_CANCELLED`/`ERR_TIMEOUT`、
`ERR_PROTOCOL`（归档格式损坏）。

## 5.5 验收

- 大文件 `copy`/`read_stream`：内存有界、可取消、跨盘 fallback 正确。
- `write_atomic` 崩溃点测试：中断后不留半写文件（临时文件被清理或未 rename）。
- `walk` 深目录：性能与正确性（含 exclude/max_depth）。
- 恶意归档：`../` 逃逸、绝对路径、符号链接、超量文件/字节、压缩炸弹全部被拒绝并清理。
- `safe_join` 单元用例覆盖常见逃逸向量。
