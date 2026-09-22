# 03 — SQLite 数据服务（`db`）

依赖：02（可取消 RPC、二进制）。构建开关：`SQLITE=1`（见 13）。能力键：`features().sqlite`。
涉及：`js/db.js`（客户端库）、`service/sqlite_service.js`（owner，注册名 `.sqlite`）、
`service-src/js-sqlite.c`（`skynetcore.sqlite` 原生绑定）。

## 3.1 架构：单 owner + 只读副本

- 每个数据库文件由一个 owner service 独占（`skynet.newservice("snjs service/sqlite_service.js <db_path>")`）。
- owner 内部：1 个写连接（串行，Skynet 单服务天然串行化）+ 可选 N 个只读连接（WAL 下并发读）。
- 原生 `skynetcore.sqlite` 只在 owner 内同步调用（prepare/step/finalize）。其它服务
  一律通过 `db` 客户端库异步 `skynet.call` 到 owner，绝不直接持有原生句柄。
- `:memory:` 库强制单连接（语义要求，见 Songloft 现状注释）。

## 3.2 `skynetcore.sqlite`（internal，仅 owner 使用）

同步、非阻塞（本地文件 I/O）原生原语，不对业务暴露：

```
skynetcore.sqlite.open(path, flags) -> handle           // flags: readonly/readwrite/create/memory/wal
skynetcore.sqlite.close(handle)
skynetcore.sqlite.prepare(handle, sql) -> stmt
skynetcore.sqlite.bind(stmt, index, value)              // 类型见 §3.4
skynetcore.sqlite.step(stmt) -> "row" | "done"
skynetcore.sqlite.column(stmt, index) -> value
skynetcore.sqlite.column_meta(stmt) -> [{name, type}]
skynetcore.sqlite.reset(stmt) / finalize(stmt)
skynetcore.sqlite.exec(handle, sql)                     // 无结果批处理
skynetcore.sqlite.last_insert_rowid(handle) -> BigInt
skynetcore.sqlite.changes(handle) -> number
skynetcore.sqlite.errcode(handle) -> {code, msg}
```

## 3.3 `db` 客户端库（stable）

`globalThis.db`。所有方法返回 Promise，均接受可选末参 `{ signal, timeout_ms }`。

```js
db.open(path, opts?) -> Promise<Db>
// opts = { mode?: "rw"|"ro"|"memory", wal?: true, busy_timeout_ms?: 10000,
//          foreign_keys?: true, readers?: 2 }

Db.query(sql, params?) -> Promise<Row[]>          // 读；params 数组或命名对象
Db.get(sql, params?)   -> Promise<Row|null>       // 取首行
Db.run(sql, params?)   -> Promise<{ changes, last_insert_rowid }>   // 写
Db.batch(statements)   -> Promise<Array<Result>>  // 顺序执行多条（非事务）
Db.transaction(fn)     -> Promise<T>              // 见 §3.5
Db.exec(sql)           -> Promise<void>           // 多语句脚本（迁移/初始化）
Db.migrate(dir, opts?) -> Promise<{ from, to, applied: string[] }>  // 见 §3.6
Db.backup(dest_path)   -> Promise<void>           // 只读快照备份
Db.close()             -> Promise<void>

db.version -> string
```

- `params`：数组按 `?` 位置绑定；对象按 `:name` / `$name` 命名绑定。
- `Row`：普通对象，列名→值；类型映射见 §3.4。

## 3.4 类型与整数契约

| SQLite | JS 入参绑定 | JS 出参 |
|---|---|---|
| NULL | `null` / `undefined` | `null` |
| INTEGER | `number`（安全范围）或 `BigInt` | 安全范围 `number`，否则 `BigInt` |
| REAL | `number` | `number` |
| TEXT | `string` | `string` |
| BLOB | `ArrayBuffer` / TypedArray | `ArrayBuffer` |

- 超过 `Number.MAX_SAFE_INTEGER` 的 INTEGER 一律 `BigInt`（对齐 01-conventions §7）。
- 对外 JSON 输出时由上层业务决定是否转字符串；`db` 层不做隐式截断。
- JSON1 函数（`json_each` / `json_extract` / `json_group_array` 等）作为普通 SQL 支持，
  无需特殊 API（Songloft 的 `labels` 查询依赖此项）。

## 3.5 事务契约（关键约束）

- `Db.transaction(fn)`：owner 在**一次调用生命周期内**开启事务，执行 `fn` 提供的
  语句序列，`fn` 抛错→ROLLBACK，正常返回→COMMIT。
- **禁止跨 `await` 外部事件持有事务**：`fn` 内只能调用 `db` 自身的语句方法，不能在事务
  中间 `await` 一个网络/媒体/其它服务调用。这样保证写连接不被长时间占用、不与 Skynet
  串行调度冲突。
- 需要“读中间结果再决定后续写”的复杂事务，用声明式批次形态下沉到 owner：

```js
Db.transaction(tx => {
  const id = tx.run("INSERT INTO t(a) VALUES (?)", [1]).last_insert_rowid;
  tx.run("INSERT INTO u(t_id) VALUES (?)", [id]);
});
// tx.* 为同步接口（在 owner 内同步执行），无 await；跨表原子提交。
```

> Songloft 的 `RunInTx`/`UnitOfWork`（21 处）迁移时映射到此形态；本文件只定义通用契约，
> 不含具体表。

## 3.6 迁移 runner

- `Db.migrate(dir)`：读取 `dir` 下形如 `NNNN_name.sql` 的迁移文件，按序号升序执行未应用项。
- 维护 `schema_migrations(version TEXT PRIMARY KEY, applied_at)`。
- 每个迁移在独立事务内执行；失败即回滚并中止，返回已应用列表与错误。
- 支持 `opts = { target?: version, dry_run?: boolean }`。
- 兼容 Songloft 现有 38 个迁移的“每文件一版本、事务化、失败回滚”语义（goose 风格）。

## 3.7 错误码

- `ERR_BUSY`（SQLITE_BUSY/LOCKED，busy_timeout 用尽）、`ERR_DB_CONSTRAINT`
  （约束冲突，归并到 `ERR_PROTOCOL`）、`ERR_NOT_FOUND`（迁移目录/文件缺失）、
  `ERR_CANCELLED`/`ERR_TIMEOUT`、`ERR_IO`。
- `err.detail` 带 `{ sqlite_code, sql?（脱敏）}`。

## 3.8 资源与安全

- 每个 `Db` 句柄的 stmt 在使用后必须 finalize；owner 在请求结束/取消/异常路径统一回收，
  杜绝 stmt/连接泄漏。
- 参数化查询强制：库不提供字符串拼接执行入口以外的“信任 SQL”后门；`exec` 仅供迁移/初始化。
- 取消：长查询在 `step` 循环的检查点响应 `signal`，尽力中止（`sqlite3_interrupt` 等价）。

## 3.9 验收

- 与 Songloft SQLite fixture 差分：相同 migration + 查询，结果集与
  `last_insert_rowid/changes` 一致。
- 事务回滚：`fn` 抛错后数据无残留；提交路径可见。
- 并发：WAL 下多读一写无 `SQLITE_BUSY` 泄漏；`:memory:` 固定单连接不报 “no such table”。
- 异常/取消路径无 stmt、连接泄漏（长跑 + 计数断言）。
- 64 位主键往返（BigInt）不失真。
