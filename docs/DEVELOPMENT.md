# SkyJS 开发手册

AGENTS.md 的详细版：编码规范全文、C/JS 边界、验收测试与排查入口。
遗留事项与已知限制见 [TODO.md](TODO.md)，历史演进与问题归因档案见
[HISTORY.md](HISTORY.md)，验收矩阵速览见根 [README.md](../README.md)，性能基线见 [bench.md](bench.md)。

## 验收测试

自动化验收:`make test`(tools/run_tests.js 逐行断言,覆盖全部场景);
互通双向断言一键化:`make interop`(tools/run_interop.js);改动后跑对应
场景,预期输出对照 `test/service/*.js` 中的标记。

| 场景 | 配置 | 验证点 |
|---|---|---|
| 纯 C 内核 | `test/config.json` | logger + C echo bootstrap |
| JS echo/打断/OOM | `test/config_js_echo.json`、`config_js_deadloop.json`、`config_js_oom.json` | JS↔C 互 call、SIGNAL 打断、memlimit |
| TypeScript 示例 | `./skyjs examples/ts_echo/config.json`(手动,不入套件) | TS 服务经 esbuild 转译后源码加载;text/lua 协议 RTT 与 table→Map 往返断言(TS_ECHO_OK) |
| console 面 | `test/config_js_console.json`(套件 js_console) | 各级别映射日志；递归渲染；printf 格式化(%s/%d/%f/%j/%o/%%)；time/timeLog/timeEnd |
| 异步核心 | `test/config_js_async.json` | 链式 await、并发挂起、PTYPE_ERROR |
| socket 桥 | `test/config_js_socket.json` | TCP echo + nc 互通；per-connection binary（ArrayBuffer） |
| gate/redirect | `test/config_gate.json` | C netpack 分帧/重组、watchdog-agent 绑定、PTYPE_CLIENT redirect、二进制/粘包/拆包回显 |
| lua-seri | `test/seri_tool gen build/seri_ref.bin` + `test/config_js_seri.json` | 字节级 roundtrip |
| cluster 双节点 | `test/config_cluster_a.json` + `config_cluster_b.json` | 跨节点 call（两个终端） |
| cluster 重连语义 | `test/config_cluster_fail.json`(套件 cluster_fail) | 对端宕机→call 立即失败；对端上线→按需重连成功 |
| 对比压测 | `make bench`(三阶段:core/cluster/socket) | SkyJS vs 原版 skynet 全套性能基线，方法学与数据见 [bench.md](bench.md) |
| 基准 | `test/config_bench.json` | 往返吞吐、JS 堆占用 |

与原版 Lua 节点的互通验收方式见根 README「验收状态」表。

## 目录结构

```text
platform/       # 内核替代层：env.c / main.c / lauxlib.h(纯 stub)
service-src/    # snjs.c(QuickJS 服务加载器) / js-seri.c(序列化) / js-netpack.c(gate 帧缓冲) / skyclusterd.c(cluster)
cservice/       # 编译产物 logger.so / snjs.so / skyclusterd.so（gitignore）
js/             # JS 运行时库：skynet.js → socket.js → cluster.js → gateserver.js（按序加载）；
                # skyjs.d.ts 为全局注入面的 TS 类型声明（与库同源维护）
test/           # 验收配置(*.json) + service/ JS 服务脚本 + service-src/ C 测试服务
examples/       # TypeScript 接入示例（ts_echo：构建脚本 + 运行配置）
tools/          # 开发工具：lint.js（零依赖 node 脚本）
docs/           # 项目文档（本目录）
3rd/            # submodule，只读，永不修改
build/          # 中间产物（gitignore）
```

## C/JS 边界（关键 API 面）

`snjs.c` 向 JS 注入全局 `skynetcore` 对象：`send / redirect / command / int_command / gen_id / now /
error / mem / response / error_response / pack / unpack / str / read_file / write_file`，
以及 `skynetcore.socket`（`listen/connect/start/send/close/shutdown/nodelay/netpack_mode`）与
`skynetcore.netpack`（`pop/pack/clear`）。

JS 侧加载顺序（env 键 `js_loader` → `js_socket` → `js_cluster` → `js_gateserver` → 用户脚本）：
`js/skynet.js` 定义 `globalThis.skynet` 与内部路由；`socket.js`/`cluster.js`/`gateserver.js`
通过 `__snjs_set_socket_handler` / `__snjs_set_cluster_handlers` 挂回调。
四个运行时库在 env 值为默认路径时走**内嵌字节码**（`make` 构建期由 qjsc 生成
`build/rt_bc.c`，strip 源码保留行号；源码或 quickjs submodule 变更自动再生），
非默认路径或字节码不可读时回退源码 eval；用户脚本始终走源码。
C 层在用户脚本执行完后用 `__snjs_wrap` 包一次 `globalThis.dispatch`，wrapper 统一负责
RESPONSE/ERROR 回包与 Promise 排空。

修改边界时的约定：

- 消息调度模型同构于 `lualib/skynet.lua`：session ↔ `pending_calls`，await = yield；
  每个 await 都挂在外部事件上，保证 dispatch 返回时 pending job 队列已排空。
  **不要引入纯 JS 定时器/微任务挂起导致 worker 线程无法归还的机制。**
- 消息跨层类型契约（text=字符串 / lua 与响应=ArrayBuffer / pack-unpack 类型映射）
  固化于下节「二进制消息协议约定」，修改边界实现前先核对该节。
- 发送缓冲区所有权：C 侧 `skynetcore.send`/`skynetcore.response` 的
  skynet_malloc 缓冲一律以 `PTYPE_TAG_DONTCOPY` 发出（所有权移交内核，由
  接收方 dispatch 后释放）。不带该 tag 时内核会**复制**消息且原缓冲仍归
  调用方——漏 free 即按载荷全量泄漏（js_send 与 cluster 请求转发的既有
  教训）。新增 C 侧发送点二选一：带 tag 移交，或 send 后自行 free。
- **socket 接收缓冲所有权**：`PTYPE_SOCKET` 的 DATA/UDP 事件中，外层
  `skynet_socket_message` 与内部 `sm->buffer` 是两块独立分配；框架在 C 服务
  callback 返回 0 后只释放外层 `msg->data`，**内部 `sm->buffer` 归接收服务**。
  拷贝到 JS / 自有 rx buffer 后必须 `skynet_free(sm->buffer)`；若做 C 层链式
  socketbuffer，则由 push 接管并在 pop/clear 时释放。CONNECT/ACCEPT/ERROR 等
  padding 控制事件 `sm->buffer == NULL`，文本位于 `sm+1` 随外层一并释放。
  漏掉该规则会按累计接收字节全量泄漏（snjs socket / skyclusterd 的既有教训）。
- 底层 `TIMEOUT` 命令单位是 **centisecond(10ms)**；`skynet.sleep(ms)` 已做换算。
- `snjs.so` 静态编入 quickjs（`-fvisibility=hidden`），仅导出 `snjs_*` 四个 ABI 符号
  （dlopen 为 RTLD_GLOBAL，防符号冲突）。

## 二进制消息协议约定

JS 服务跨层收发消息的类型契约。实现锚点：snjs.c `worker_cb`（接收方向）、
`js_send`/`js_response`（发送方向），js/skynet.js `skynet_call`/`__snjs_wrap`。
协议常量同 skynet：PTYPE_TEXT=0、PTYPE_RESPONSE=1、PTYPE_CLIENT=3、PTYPE_SOCKET=6、
PTYPE_ERROR=7、PTYPE_LUA=10。修改 C/JS 边界时不得破坏本节语义。

### 跨层类型规则

接收（C → JS）：dispatch 拿到的 JS 类型由消息协议类型决定：

| 协议类型 | JS 侧类型 | 说明 |
|---|---|---|
| PTYPE_LUA、PTYPE_RESPONSE、PTYPE_CLIENT | `ArrayBuffer` | 原始字节拷贝，C 层不解释内容（binary-safe）；CLIENT 由 gate redirect 给 agent |
| PTYPE_TEXT 及其余全部类型 | UTF-8 字符串 | `JS_NewStringLen` 解码 |
| PTYPE_SOCKET | 预解析对象 `{type, id, ud, data}`，DATA 的 data 为 `ArrayBuffer` | socket.js 按连接选择 UTF-8 解码或原样交付；netpack 模式改为 `{np,event,...}` |

PTYPE_RESPONSE/PTYPE_ERROR 由 skynet.js 运行时路由（pending_calls / 定时器 /
cluster 桥），不会进入用户注册的 dispatch。

发送（JS → C）：`skynetcore.send` / `skynetcore.response` 的消息参数传
`ArrayBuffer` 即二进制载荷原样透传，传字符串按 UTF-8 编码。dispatch 的返回值由
`__snjs_wrap` 原样交回 `response`（string / ArrayBuffer 均可），因此 lua 协议
服务的应答必须返回 `skynet.pack(...)` 打包的 ArrayBuffer（应答体按 seri 流解码），
text 协议服务返回字符串。

响应解码按调用方协议：应答统一以 ArrayBuffer 到达 JS 层，解码方式由
`skynet.call` 发起时的协议决定——`"lua"` 调用保持 ArrayBuffer，由调用方
`skynet.unpack`；text 协议调用由 skynet.js 以 `skynetcore.str` 解码为字符串再
resolve。

### skynet.pack / skynet.unpack 与 lua-seri 的兼容关系

`skynet.pack(...)` 返回 ArrayBuffer；`skynet.unpack(buf)` 返回按 seri 流顺序排列
的值数组（buf 亦接受字符串，按其 UTF-8 字节流解）。js-seri.c 与原版 lua-seri
字节级兼容（验收：`test/seri_tool` 对拍 + `test/config_js_seri.json` roundtrip），
pack 产物可跨 JS/Lua 节点互通。

JS → seri（pack）类型映射：

| JS 类型 | seri 编码 |
|---|---|
| `null` / `undefined` | nil |
| `boolean` | boolean |
| `number` | 精确整数（绝对值 ≤ 2^53 且无小数部分）走整数编码（同 Lua 整数路径），其余 double |
| `BigInt` | 整数编码，按值选最小宽度（zero/byte/word/dword/qword），与同值 number 产物一致 |
| `string` | UTF-8 字符串，上限 0x7fffffff 字节 |
| `Array` | table 数组部分（键 1..n，Lua 1-based） |
| `Map` / 普通对象 | table hash 部分（对象取可枚举自有属性） |
| 其余（function、symbol 等） | 报错 "unsupported type" |

seri → JS（unpack）类型映射：

| seri 类型 | JS 类型 |
|---|---|
| nil | `null` |
| boolean | `boolean` |
| 整数 qword（超出 int32 表达范围，即 Lua 侧 64 位整数） | `BigInt` |
| 整数 zero/byte/word/dword、real | `number` |
| string | `string` |
| table (array-only) | `Array`（0-based；Lua 1-based 键隐含；附带 Map 兼容方法 `.get(k)`/`.has(k)`/`.size`，k 为 1-based） |
| table (mixed/hash)  | `Map`（数组部分展开为键 1..n，Lua 1-based） |
| userdata | **unpack 直接抛 TypeError**（指针跨 VM 禁传，与原版语义一致） |

### 边界行为备忘

- int64 经 BigInt 往返：Lua 侧 64 位整数 unpack 恒为 `BigInt`（不回退 number）；
  JS 侧表达超过 2^53 的整数必须自觉用 BigInt（number 在 pack 前已丢精度）。
  int32 范围内的整数双向均为 number，`BigInt(5)` 与 `5` 的 pack 产物一致。
- table 往返区分处理：seri table 的纯数组部分（无 hash）解为 0-based JS `Array`，含
  hash 部分的表解为 `Map`（数组键 1..n）。pack 方向不变：JS Array 写入数组部分，
  Map/对象写入 hash 部分。轮回结果：pack([1,2,3]) → unpack → [1,2,3] (Array)；
  pack({a:1}) → unpack → Map{"a"→1}。
- 嵌套深度超过 32 层 pack 报 "pack too deep"。

## Gate / netpack / redirect

`js/gateserver.js` 对齐原版 `snax/gateserver.lua` 的核心连接状态机，使用
`service-src/js-netpack.c` 处理 2 字节大端长度帧。netpack 队列为 per-service 单例：
DATA 到达时 C 层直接接管 `sm->buffer`，单包/分片按 fd 重组，多包进入 ring queue；
`netpack.pop()` 把完整包复制为 ArrayBuffer 后释放 C 缓冲，`netpack.clear()` 与
`snjs_release` 释放所有 queued/uncomplete 缓冲。gate 服务退出前无需 JS 手动析构，
但业务主动重置队列时应调用 clear。

`socket.start(..., {binary:true})` 使指定连接的 `on_data` 接收 ArrayBuffer；默认仍通过
`skynetcore.str` 解码为字符串，保持既有 API。socket 写入接受 string、ArrayBuffer 与
TypedArray view。

`skynet.redirect(dest, source, typename, session, msg)` 可伪装 source，C 层为新分配缓冲
加 `PTYPE_TAG_DONTCOPY` 后移交内核。gate 将完整包以 PTYPE_CLIENT 转给 agent，session
携带 fd；CLIENT dispatch 禁止 `__snjs_wrap` 自动回包，agent 直接向 fd 写响应。验收场景
`test/config_gate.json` 覆盖 watchdog→agent 绑定、二进制载荷、粘包与拆包。

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
  ArrayBuffer/Uint8Array 输出长度+hex 摘要、嵌套对象、深度限 3。首参为含 `%` 的
  字符串时启用 printf 格式化（%s/%d/%i/%f/%j/%o/%%，未知/缺参占位符原样，多余
  参数追加尾部）；`time/timeLog/timeEnd` 用 Date.now 墙钟计时，纯观测不挂
  dispatch（方法名保持标准 console API 面，同 console.log）。
- 服务脚本（`test/service/`）不新增裸全局函数，统一 `skynet.start(() =>
  skynet.dispatch(...))` 范式；`globalThis.dispatch` 直接覆盖是早期同步形式的存量
  写法，勿模仿。未来引入第三方 JS 库保持其原有风格，仅自有代码遵循本规范。

构建与配置:

- **三平台构建**：Makefile 根据 `uname`/`OS` 判断平台，三分支产出相同结构：
  - macOS (arm64/x86_64)：`-dynamiclib`，`-ldl -lpthread -lm`
  - Linux (x86_64/aarch64)：`--shared`，`-ldl -lpthread -lm -lrt`
  - Windows (MinGW-w64)：`--shared`，`-lws2_32 -lgdi32 -lpthread -lm -static-libgcc`；
    通过 `-I` 和 `-include` 引用 skynet 自带的 `3rd/compat-mingw/`（`compat.h`），
    不新建额外兼容层文件。
  - Windows 功能退化：daemon 化（空操作）、pidfile 锁定（不生效）、SIGHUP 日志重开（不生效）。
  - `platform/main.c` 中 SIGPIPE 处理已用 `#ifndef _WIN32` 条件编译保护。
  - CI 通过 GitHub Actions 矩阵自动构建三平台(`.github/workflows/build.yml`)；
    Windows 测试套件暂未启用（依赖 POSIX 信号等工具链）。
- C 构建由 Makefile 负责（npm 管不到 C 编译链接）;package.json 管 JS 开发工具链
  （lint、TS 转译），运行时依旧零 npm 依赖，`node_modules/` 不进运行时。
- **TypeScript 接入**：运行时全局注入面的类型声明在 [js/skyjs.d.ts](../js/skyjs.d.ts)
  （与三个运行时库同源维护，**改注入面必须同步更新**）；TS 服务写好后用
  `examples/ts_echo/build.sh` 同款 esbuild 参数转译（`--bundle --format=iife
  --platform=neutral --target=es2022`，esbuild 仅构建期工具，npx 按需拉取），
  产物交 snjs 以源码模式加载（用户脚本始终走源码 eval，无模块包装）。完整
  流程见 `examples/ts_echo/`（tsc --noEmit 可选强检查）。
- 配置文件为**扁平 JSON**（`platform/main.c` 内置约百行解析器，不支持 `$VAR`/
  `include`）；新配置键直接写 env，skynet 相关键（thread/cpath/harbor/bootstrap/
  daemon/logger/logservice/profile）映射 `skynet_config`，JS 专属键（如
  `js_memlimit`）由 snjs 读取。
- 提交前跑 `make lint`（或 `npm run lint`）：`tools/lint.js`（零依赖 node 脚本，
  检查范围含自身所在 tools/）静态检查语法/禁 var/snake_case 命名/缩进/旧连写名
  黑名单。
- 注释与文档用中文或英文均可，与所在文件现状保持一致；README.md 的架构表与验收
  矩阵、docs/HISTORY.md 的演进记录在行为变更后需同步更新。

## 功能边界（未实现清单）

当前无对应物的功能（未实现 ≠ 永久排除，取舍待推敲；如需引入，先与用户确认设计，
勿擅自顺手实现）：harbor 的 master-slave 多节点模式、snlua/launcher/debug_console、
inject 热更新、sharetable、snax、datacenter；cluster 侧未实现 clusterproxy、
cluster.snax，也未与 gateserver 复用监听。

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
- **KILL/跨服务命令参数是 `:hex` 格式**：内核 `tohandle()` 只认 `:十六进制`
  与 `.名字`，传十进制 handle 会被拒（仅一行 `Can't convert N to handle` 日志，
  极易淹没在噪音里导致操作静默失效）。正确写法
  `skynetcore.command("KILL", ":" + h.toString(16))`；若「内存随服务数线性增长」
  先 grep `Can't convert` 确认销毁是否真执行过，再查泄漏。
- 服务参数 `snjs_param` 在用户脚本 eval 完成后才注入（snjs.c post-JS_Eval），
  `skynet.start` 回调内（同步启动阶段）读到 undefined；需在首个 await 之后再读，
  或用 driver kick 模式（见 `test/service/bench_main_trim.js`、`longrun_main.js`）。
- 长跑稳定性与 memstat/RSS 对账：`make longrun`（`DURATION=N` 分钟，默认 30），
  harness 汇总 js_mem 与 RSS 的增长量（memstat 盲区）并落盘 `build/longrun/`。
- 其余已知限制（socket.start 重复事件、TIMEOUT 单位等）见 [TODO.md](TODO.md)
  「已知限制」一节。
