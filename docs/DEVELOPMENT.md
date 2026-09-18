# SkyJS 开发手册

AGENTS.md 的详细版：编码规范全文、C/JS 边界、验收测试与排查入口。
演进记录与遗留事项见 [TODO.md](TODO.md)，验收矩阵速览见根 [README.md](../README.md)。

## 验收测试

按场景运行 `test/config_*.json` 并人工核对日志输出（无自动断言框架）；
改动后跑对应场景，对比 `test/service/*.js` 中的预期输出。

| 场景 | 配置 | 验证点 |
|---|---|---|
| 纯 C 内核 | `test/config.json` | logger + C echo bootstrap |
| JS echo/打断/OOM | `test/config_js_echo.json`、`config_js_deadloop.json`、`config_js_oom.json` | JS↔C 互 call、SIGNAL 打断、memlimit |
| console 面 | `test/config_js_console.json` | 各级别映射 skynet 日志；Map/BigInt/ArrayBuffer 递归渲染 |
| 异步核心 | `test/config_js_async.json` | 链式 await、并发挂起、PTYPE_ERROR |
| socket 桥 | `test/config_js_socket.json` | TCP echo + nc 互通 |
| lua-seri | `test/seri_tool gen /tmp/seri_ref.bin` + `test/config_js_seri.json` | 字节级 roundtrip |
| cluster 双节点 | `test/config_cluster_a.json` + `config_cluster_b.json` | 跨节点 call（两个终端） |
| cluster 重连语义 | `test/config_cluster_fail.json`(套件 cluster_fail) | 对端宕机→call 立即失败；对端上线→按需重连成功 |
| 基准 | `test/config_bench.json` | 往返吞吐、JS 堆占用 |

与原版 Lua 节点的互通验收方式见根 README「验收状态」表。

## 目录结构

```text
platform/       # 内核替代层：env.c / main.c / lauxlib.h(纯 stub)
service-src/    # snjs.c(QuickJS 服务加载器) / js-seri.c(序列化) / skyclusterd.c(cluster)
cservice/       # 编译产物 logger.so / snjs.so / skyclusterd.so（gitignore）
js/             # JS 运行时库：skynet.js(异步核心+console) → socket.js → cluster.js（按序加载）
test/           # 验收配置(*.json) + service/ JS 服务脚本 + service-src/ C 测试服务
tools/          # 开发工具：lint.js（零依赖 node 脚本）
docs/           # 项目文档（本目录）
3rd/            # submodule，只读，永不修改
build/          # 中间产物（gitignore）
```

## C/JS 边界（关键 API 面）

`snjs.c` 向 JS 注入全局 `skynetcore` 对象：`send / command / int_command / gen_id / now /
error / mem / response / error_response / pack / unpack / str / read_file / write_file`，
以及 `skynetcore.socket`（`listen/connect/start/send/close/shutdown`）。

JS 侧加载顺序（env 键 `js_loader` → `js_socket` → `js_cluster` → 用户脚本）：
`js/skynet.js` 定义 `globalThis.skynet` 与内部路由 `internal_dispatch`；`socket.js`/
`cluster.js` 通过 `__snjs_set_socket_handler` / `__snjs_set_cluster_handlers` 挂回调。
C 层在用户脚本执行完后用 `__snjs_wrap` 包一次 `globalThis.dispatch`，wrapper 统一负责
RESPONSE/ERROR 回包与 Promise 排空。

修改边界时的约定：

- 消息调度模型同构于 `lualib/skynet.lua`：session ↔ `pending_calls`，await = yield；
  每个 await 都挂在外部事件上，保证 dispatch 返回时 pending job 队列已排空。
  **不要引入纯 JS 定时器/微任务挂起导致 worker 线程无法归还的机制。**
- 文本协议（PTYPE_TEXT=0）跨层为字符串；lua 协议（PTYPE_LUA=10）为 `ArrayBuffer`
  （`skynet.pack/unpack`）；int64 经 BigInt 往返，JS number 超 2^53 需用 BigInt；
  TYPE_USERDATA（指针）跨 VM 禁传，unpack 遇到即报错。
- 底层 `TIMEOUT` 命令单位是 **centisecond(10ms)**；`skynet.sleep(ms)` 已做换算。
- `snjs.so` 静态编入 quickjs（`-fvisibility=hidden`），仅导出 `snjs_*` 四个 ABI 符号
  （dlopen 为 RTLD_GLOBAL，防符号冲突）。

## 编码约定

C 代码风格与 `3rd/skynet/skynet-src` 一致：4 空格缩进、`snjs_`/`js_` 前缀、
结构体 `struct xx` 声明风格、函数定义返回类型独立一行。新增 C 文件需同步加入
`Makefile` 对应 SRC 列表（snjs 系需 `-fvisibility=hidden` 与 `-I3rd/quickjs`）。

JS 命名规范（对齐 skynet 生态，非浏览器 JS 惯例）：

- 标识符（变量/函数/参数/公开 API/属性键/回调参数名/C 注入属性名）一律
  lower_snake_case，复合词下划线分隔，**无连写豁免**（如 `find_type`、
  `internal_dispatch`、`set_nodes`、`mem_stat`、`raw_cmd`、`on_data`）。
- 与原版 `skynet.lua` 同名的公开 API 逐字保留（`skynet.register_protocol`、
  `skynet.newservice` 等）。
- 常量 UPPER_SNAKE_CASE（`PTYPE_TEXT`）；禁止 `var`，一律 `const`/`let`；
  字符串双引号；缩进 4 空格。

C/JS 边界：注入到 JS 的属性名同样遵守 JS snake 规范（`int_command`、`gen_id`、
`read_file`、`write_file`、`error_response`），由 snjs.c 的 `JS_SetPropertyStr` 注入，
改名必须 JS/C 同步；C 源码内部函数名（`js_*` 前缀，如 `js_intcommand`）是纯 C 侧
命名，不受 JS 规范管辖。`__snjs_*` 双下划线前缀与 `globalThis.dispatch` 是 C↔JS
调用契约（加载器依赖），JS 侧不得改名或删除。旧连写名（intcommand/genid/
readfile/writefile）已列入 lint 黑名单，勿复用。

运行时库与服务脚本：

- `js/` 运行时库一律 IIFE + `"use strict"` 封装，内部符号不进全局，公开 API 仅挂
  `globalThis.skynet`/`socket`/`cluster`。**运行时零 npm 依赖**、无构建步骤。
- console 调试面（js/skynet.js 纯 JS 实现）：`log/info/debug/warn/error/trace` 全部
  映射 skynet 日志通道（`skynetcore.error`，带服务 handle 前缀进 logger）；参数递归
  渲染——Map 展开为条目、BigInt 带 `n` 后缀（避开 JSON.stringify 对 bigint 抛错）、
  ArrayBuffer/Uint8Array 输出长度+hex 摘要、嵌套对象、深度限 3。
- 服务脚本（`test/service/`）不新增裸全局函数，统一 `skynet.start(() =>
  skynet.dispatch(...))` 范式；`globalThis.dispatch` 直接覆盖是早期同步形式的存量
  写法，勿模仿。未来引入第三方 JS 库保持其原有风格，仅自有代码遵循本规范。

构建与配置：

- C 构建由 Makefile 负责（npm 管不到 C 编译链接）；package.json 管 JS 开发工具链
  （lint、未来 TS 转译），运行时依旧零 npm 依赖，`node_modules/` 不进运行时。
- 配置文件为**扁平 JSON**（`platform/main.c` 内置约百行解析器，不支持 `$VAR`/
  `include`）；新配置键直接写 env，skynet 相关键（thread/cpath/harbor/bootstrap/
  daemon/logger/logservice/profile）映射 `skynet_config`，JS 专属键（如
  `js_memlimit`）由 snjs 读取。
- 提交前跑 `make lint`（或 `npm run lint`）：`tools/lint.js`（零依赖 node 脚本，
  检查范围含自身所在 tools/）静态检查语法/禁 var/snake_case 命名/缩进/旧连写名
  黑名单。
- 注释与文档用中文或英文均可，与所在文件现状保持一致；README.md 的架构表与验收
  矩阵、docs/TODO.md 的演进记录在行为变更后需同步更新。

## 功能边界（未实现清单）

当前无对应物的功能（未实现 ≠ 永久排除，取舍待推敲；如需引入，先与用户确认设计，
勿擅自顺手实现）：harbor 的 master-slave 多节点模式、snlua/launcher/debug_console、
inject 热更新、sharetable、snax、datacenter；cluster 侧未实现 clusterproxy、
cluster.snax、与 gate 复用。

## 排查问题的入口

- 服务日志：stdout 由 `logger.so` 输出；JS 侧用 `console.log/info/debug/warn/
  error/trace`（js/skynet.js 实现，全部映射到 skynet 日志通道），或直接
  `skynetcore.error`。cluster 侧对端未启动时每次请求失败的
  `socket-server error: invalid socket` 是 skynet 内核的固有噪音（每次
  connect 拒绝一条），非故障。
- 内存：per-service memstat（`skynetcore.mem()`），`js_memlimit` 配 OOM 限额，
  OOM 表现为 JS 抛错可被捕获（见 `test/service/js_oom.js`）。
- 死循环：SIGNAL 命令打断机制，见 `test/service/js_deadloop.js` 与 snjs.c 头注释
  （注意：信号到达时若无 JS 在跑，陷阱会滞后到下一条消息）。
- 其余已知限制（socket.start 重复事件、TIMEOUT 单位等）见 [TODO.md](TODO.md)
  「已知限制」一节。
