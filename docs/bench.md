# SkyJS vs 原版 Skynet 性能对比压测

对比 SkyJS（QuickJS 服务）与原版 skynet（Lua 服务）的性能基线。工具链：
[tools/run_bench.js](../tools/run_bench.js)（零依赖 harness）+ 两侧逐场景镜像的
bench 脚本。运行方式：`make bench`（等价 `node tools/run_bench.js --phase all --repeat 3`）；
可选 `PHASE=core|cluster|socket`、`REPEAT=N`。

## 方法学（公平性控制项）

1. **同内核**：skynet-src 15/17 源文件同源编译；macOS 上原版 `platform.mk` 默认
   `-DNOUSE_JEMALLOC`（与 skyjs 构建一致），harness 用 `nm` 校验参照节点无
   jemalloc 符号，发现不对齐会在报告标红。
2. **同口径**：双侧 `thread=4`、`profile=true`、相同 N / 包体 / 消息内容；C echo
   服务（`test/service-src/echo.c`，协议无关）两侧复用同一个 .so。
3. **计时权威在进程内**：日志行经 logger 服务异步送达，CPU 打满时会滞后 100ms+，
   所以脚本用进程内单调时钟计时并在 `BENCH case=... ms=` 字段上报（JS 用
   `Date.now`，Lua 用 `skynet.hpc` 纳秒）；harness 跨进程的 `BENCH_BEGIN/END`
   hrtime 只做粗校验（偏差 >3x 告警）。
4. **统计**：每场景先热身；`--repeat` 轮取中位数 + min/max；两节点顺序执行避免
   争抢 CPU。
5. **cluster 对称**：每对组合双向都测（节点 A 先跑，然后经控制通道触发 B 反向）；
   端口 2528/2529，启动前清残留监听（复用 run_tests 的 free_cluster_ports）。
6. **socket 同客户端**：两侧服务端被同一个 node 压测客户端压
   （[tools/bench_socket_client.js](../tools/bench_socket_client.js)，4 连接 ×
   256 在途流水线），只有服务端框架不同。

## 场景矩阵

| 阶段 | 场景 | 内容 |
|---|---|---|
| core | `rt_text_c` | main→C echo（text 20B，N=50000）——内核基线校准 |
| core | `rt_text_self` | main→同语言 echo（text 20B，N=50000）——语言栈全开销 |
| core | `rt_text_s256/s4k/s64k` | 同语言 echo 包体伸缩（256B/4KB/64KB） |
| core | `rt_lua_self` | lua 协议 pack/unpack 10 字段 table RTT（N=20000） |
| core | `send_self` | fire-and-forget（session 0，N=500000，尾部一次 call 排空） |
| core | `conc_self_k1/k8` | K 并发 caller × RTT（N=100000） |
| core | `sp_t10/sp_t1000/sp_s64k` | 进程内 pack/unpack 纯序列化（无内核噪声） |
| core | `startup_c/startup_self` | 创建 500 个 C / 同语言 echo 服务 + 各一次 RTT |
| core | `timer_wake` | 50000 个 10ms 定时器同时到期 |
| core | `mem_report` | 主服务框架内存记账 + harness 采进程 RSS 峰值 |
| cluster | `cl_<pair>_100/40k` | `cluster.call` RTT：pair = jsjs / lualua / mixed（skyjs↔lua 互通回归）；100B 与 40KB（multipart 分帧路径），双向各 N=5000/1000 |
| socket | `sock_64/4096/65536` | TCP echo（字节原样回包）responses/s 与 MB/s |

两侧脚本严格镜像：JS 侧 [test/service/bench_main.js](../test/service/bench_main.js)、
[bench_cluster_a/b.js](../test/service/bench_cluster_a.js)、
[bench_socket_server.js](../test/service/bench_socket_server.js)；Lua 侧
[test/bench_lua/](../test/bench_lua/)（`main.lua` / `cluster_main_a,b.lua` /
`socket_echo.lua`，配置与 clustername 同目录）。

## 基线数据

2026-09-19，Apple M4 Pro，macOS 26.6.2，commit 3fe7704，repeat 3（中位数）。
原始数据在 `build/bench/raw_*.json`，报告在 `build/bench/report.md`。

| case | n | skyjs msg/s | lua msg/s | ratio skyjs/lua |
|---|---|---|---|---|
| rt_text_c | 50000 | 416,667 | 344,590 | 1.21 |
| rt_text_self | 50000 | 359,712 | 344,828 | 1.04 |
| rt_text_s256 | 50000 | 349,650 | 334,225 | 1.05 |
| rt_text_s4k | 50000 | 241,546 | 282,486 | 0.86 |
| rt_text_s64k | 10000 | 38,760 | 91,075 | 0.43 |
| rt_lua_self | 20000 | 101,010 | 171,086 | 0.59 |
| send_self | 500000 | 1,718,213 | 661,201 | 2.60 |
| conc_self_k1 | 100000 | 359,712 | 334,225 | 1.08 |
| conc_self_k8 | 100000 | 349,650 | 342,818 | 1.02 |
| sp_t10 | 100000 | 319,489 | 720,461 | 0.44 |
| sp_t1000 | 5000 | 530.1 | 23,958 | 0.02 |
| sp_s64k | 2000 | 40,000 | 42,373 | 0.94 |
| startup_c | 500 | 166,667 | 1,973.9 | 84.43 |
| startup_self | 500 | 3,401.4 | 1,909.1 | 1.78 |
| timer_wake | 50000 | 347,222 | 373,972 | 0.93 |
| cl_jsjs_100 | 5000 | 248.7 | — | — |
| cl_jsjs_40k | 1000 | 312.6 | — | — |
| cl_lualua_100 | 5000 | — | 292.2 | — |
| cl_lualua_40k | 1000 | — | 369.2 | — |
| cl_mixed_100 | 5000 | 256.2 | 265.3 | 0.97 |
| cl_mixed_40k | 1000 | 109.2 | 372.1 | 0.29 |
| sock_64 | 100000 | 71,957 | 73,037 | 0.99 |
| sock_4096 | 50000 | 62,859 | 62,283 | 1.01 |
| sock_65536 | 10000 | 5,877 | 5,516 | 1.07 |

| 内存 | skyjs | stock lua |
|---|---|---|
| bench 主服务框架记账 | 0.9 MB | 4.2 MB |
| 进程 RSS 峰值（含 500 常驻同语言 echo 服务） | 1,025.5 MB | 359.2 MB |

## 解读

1. **内核基线校准通过**：`rt_text_c` 1.21x（同内核，差异来自调用方语言层的
   每次调用开销：JS 的 promise 挂起/恢复略便宜于 Lua 的协程 yield/resume）。
2. **同语言全栈 RTT 持平**（`rt_text_self` 1.04，`conc_*` 1.02-1.08，
   `timer_wake` 0.93）：一问一答路径上两套语言层成本相当。
3. **大包体 JS 变慢**（`rt_text_s64k` 0.43）：JS 侧跨层要 UTF-8 解码（收）+
   再编码（发）+ QuickJS 字符串/ArrayBuffer 拷贝；Lua 只做一次 tostring 拷贝。
4. **seri 是 JS 侧最大短板**：wire 上 0.59（`rt_lua_self`）；纯序列化
   `sp_t10` 0.44；1000 元素数组 `sp_t1000` 0.02 —— 根因是 quickjs 的 Map 为
   链表实现（`map_add` O(n) 查重），1000 次 set 即 O(n²)（实测：纯 JS 建
   100 项 Map 15µs，1000 项 1178µs）；lua table 是哈希表 O(1)。在
   「table→Map」契约 + 不改引擎的约束下此差距不可消除（见「优化记录」）。
5. **fire-and-forget JS 快 2.6x**（`send_self`）：回包被抑制后瓶颈在 echo 端
   每条消息的派发成本——Lua 每条消息起一个 dispatch 协程（skynet.lua 模型），
   JS 只是一次普通函数调用。
6. **服务创建**：`startup_c` 84x 是**结构差异**——skyjs 直接 LAUNCH 命令建 C
   服务（~4µs），原版经 launcher 服务一跳 RTT（~0.5ms），对比的是"各自框架
   的惯用创建路径"。`startup_self` 是实打实的 VM 创建对比（字节码化后
   snjs ~70µs/个，对 snlua+launcher 4.76x，见「优化记录」）。
7. **常驻内存 JS 显著更重**：RSS 峰值 1026MB vs 359MB，主要来自 500 个常驻
   snjs 服务——每个 QuickJS runtime（含 atom 表、已加载运行时库）约 1.4MB，
   而 snlua echo 服务约 0.2MB。单服务粒度上 JS 服务内存 ≈ Lua 的 5-7 倍。
8. **cluster 小包 RTT 被 TCP Nagle 绑死**：~250-345 msg/s（2.9-4ms/次）与实现
   无关——两侧的**响应方向**都不设 TCP_NODELAY（原版 clusteragent 裸
   socket.write；skyclusterd accepted socket 同样），串行一问一答时响应小段
   被 Nagle 拖住。40KB 大包满段绕过 Nagle，双侧同口径（~2.7-3.7ms）。
   发送方向已对齐原版 clustersender.lua 的 `nodelay = true`（见 TODO.md）；
   对齐前 jsjs_40k 曾达 1382 msg/s（Nagle 合并效应），属与原版的实现偏差。
9. **cluster RTT 与 payload 大小/分帧无关**（payload 扫描实测：100B、8KB、
   20KB 单帧与 40KB/80KB 分帧全部落在同一个 ~3-4ms 平台）——分帧实现无差异，
   一切被 Nagle 平台主导。注意 `cl_*_40k` 各轮方差极大（如 lualua 258..1241），
   **单轮对比不可靠**，必须多轮取中位数。
10. **socket 吞吐持平**（0.99-1.07）：echo 路径由共享内核 socket 机制主导，
    JS socket 桥（字符串跨界）与 lualib socket（阻塞读）成本相当。

## 已知限制

- 单机自压（客户端/服务端同机），绝对值受机器与系统状态影响，结论看相对值
  与多轮中位数；换机器重跑即得新基线。
- **机器状态漂移可达 1.5x**：跨时段的绝对值对比无效（lua 参照列同步涨跌），
  必须同机同时段 A/B 或用 lua 列归一化。
- cluster 小包串行 RTT 被 Nagle 主导，实现差异被掩盖；要测纯实现开销需补
  pipelined（多在途请求）cluster 场景。
- 仅 macOS/arm64 实测；Linux（epoll 路径）未验证。
- RSS 采样粒度 250ms（`ps` 轮询），瞬时尖峰可能低估。

## 优化记录（2026-09-19，基于本基线）

以下均为**同机同时段 A/B 对照**（lua 参照列归一化）后确认的净变化：

| 优化项 | case | before | after | 净收益 |
|---|---|---|---|---|
| js-seri 连续写缓冲 + AB 零拷贝 | `sp_s64k` | 0.94（64KB 字符串 pack/unpack，旧路径块链 + 2 次全量拷贝） | 4.05 | **~4x** |
| 同上（大消息路径） | `rt_text_s4k/s64k` | 0.86/0.43 | 0.85/0.41 | 持平（text 协议不走 seri） |
| 运行时库字节码化 | `startup_self` | 1.50（~208µs/个） | 4.76（~70µs/个） | **~1.9x** |
| unpack 平铺数组 + buildmap | `sp_t10/sp_t1000` | 0.44/0.02 | 0.41/0.02 | 持平——被 Map O(n²) 主导 |

定性结论：

1. **quickjs 的 Map 是链表实现**，`Map.set` O(n) 查重导致大表 unpack 为
   O(n²)（纯 JS 复现：100 项 15µs → 1000 项 1178µs）。在「table→Map」契约与
   不改 3rd/ 的双重约束下 `sp_t1000` 类场景无优化空间；若未来要突破，路径是
   契约变更（数组型 table 解为 Array）或引擎 patch，均需另行立项评估。
2. **mixed 40KB skyjs→lua 方向的 109 msg/s 为运行瞬态**，复测 535 msg/s
   （与 lua→lua 同量级）；payload 扫描证明 RTT 与包大小/分帧无关。
3. 运行时库字节码由 `make` 构建期生成（qjsc，strip 源码保留行号），snjs 对
   默认路径走 `JS_ReadObject` + `JS_EvalFunction`，非默认路径/字节码损坏时
   回退源码 eval；源码移除后场景照常通过（证明字节码真实生效）。
