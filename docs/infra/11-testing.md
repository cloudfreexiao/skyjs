# 11 — 测试体系（`testing`）

依赖：无（可独立使用）。能力键：常驻可用。
涉及：新增 `js/testing.js`（`globalThis.testing`）；进程级集成沿用现有
`tools/run-tests.js`；新增 sanitizer / 泄漏 / long-run 套件约定。

## 11.1 分层

| 层 | 载体 | 覆盖 |
|---|---|---|
| 单元测试（进程内） | `testing` 库 + 专用测试 service | 纯函数、库逻辑、mock 依赖 |
| 集成测试（进程级） | `tools/run-tests.js` + `test/config-*.json` | 端到端、日志断言、崩溃检测（现状） |
| 原生 sanitizer | ASan/UBSan 构建 + 定向用例 | C/C++ 模块内存/未定义行为 |
| 泄漏/长跑 | 计数断言 + 30 分钟 long-run | fd/内存/statement/进程泄漏 |

## 11.2 `testing` 库（stable）

`globalThis.testing`。在测试 service 内运行，输出可被 `run-tests.js` 断言标记捕获。

```js
testing.suite(name, fn)
testing.test(name, fn)                    // fn 可 async；抛错即失败
testing.before/after/beforeEach/afterEach(fn)

// 断言
testing.assert(cond, msg?)
testing.eq(a, b, msg?) / testing.ne(a, b, msg?)
testing.deepEq(a, b, msg?)               // 结构化深比较（含 Map/BigInt/ArrayBuffer）
testing.throws(fn, code?) -> Promise      // 断言抛出，可校验 err.code
testing.approx(a, b, eps)

// mock / fake
testing.mock(obj, method, impl) -> restore     // 方法替身
testing.spy(fn) -> { fn, calls }
testing.fakeClock() -> { advance(ms), restore }   // 配合 skynet.timeout/sleep
testing.tempDir() -> { path, cleanup() }          // 临时目录，自动清理
testing.memoryDb() -> Promise<Db>                 // :memory: 库（见 03），自动 migrate/清理

testing.run() -> Promise<{ passed, failed, report }>   // 汇总；打印机器可解析标记
testing.version -> string
```

- 输出约定：每个用例打印 `TEST_OK <suite>::<name>` / `TEST_FAIL <...>`，供 `run-tests.js`
  逐行断言（与现有套件风格一致）。
- `fakeClock` 与 Skynet 定时器对接：`advance` 触发到期 timer，避免真实等待。
- `memoryDb` 固定单连接（见 03 §3.1），避免 “no such table” 陷阱。

## 11.3 进程级集成（现状扩展）

- 沿用 `tools/run-tests.js`（`--repeat`/`--filter`），新增能力场景配置：
  `config-db.json / config-webapp.json / config-media.json / config-plugin.json` 等。
- 新增 `make test-asan`（ASan/UBSan 构建后跑定向 C 用例）、`make longrun`（已存在，纳入
  fd/内存/statement 计数断言）。

## 11.4 泄漏与稳定性断言

- 每类原生资源提供计数查询（owner service 暴露 `stat`：open handles / stmts / procs /
  sockets / libav ctx）；用例在操作前后对比，回到基线才算通过。
- 长跑：反复 open/close、spawn/kill、transcode/cancel、plugin load/unload；RSS 与句柄数
  无单调增长（对齐现有 long-run + memstat 思路）。

## 11.5 验收

- `testing` 能在测试 service 内跑通 suite/断言/mock/fakeClock/tempDir/memoryDb，
  并被 `run-tests.js` 正确判定成败。
- ASan/UBSan 在 SQLite/media/subprocess/archive 定向用例下零告警。
- 各 owner service 的资源计数在长跑后回到基线（无泄漏）。
