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
| cluster | `cl_<pair>_pipe` | 同 100B payload，8 路并发 caller（Promise.all / skynet.fork fork-join）保持多在途请求，绕开串行 Nagle 平台，测纯实现开销；双向各 N=5000 |
| socket | `sock_64/4096/65536` | TCP echo（字节原样回包）responses/s 与 MB/s |

两侧脚本严格镜像：JS 侧 [test/service/bench_main.js](../test/service/bench_main.js)、
[bench_cluster_a/b.js](../test/service/bench_cluster_a.js)、
[bench_socket_server.js](../test/service/bench_socket_server.js)；Lua 侧
[test/bench_lua/](../test/bench_lua/)（`main.lua` / `cluster_main_a,b.lua` /
`socket_echo.lua`，配置与 clustername 同目录）。

## 基线数据

2026-09-20，Apple M4 Pro，macOS 26.6.2，commit 9aaf0ac，repeat 3（中位数）。
原始数据在 `build/bench/raw_*.json`，报告在 `build/bench/report.md`。
本基线包含发送路径与 socket 接收缓冲两处所有权修复之后的完整代码
（修复过程与旧基线作废说明见 [HISTORY.md](HISTORY.md) §2）。

| case | n | skyjs msg/s | lua msg/s | ratio skyjs/lua |
|---|---|---|---|---|
| rt_text_c | 50000 | 617,284 | 541,126 | 1.14 |
| rt_text_self | 50000 | 537,634 | 535,332 | 1.00 |
| rt_text_s256 | 50000 | 537,634 | 526,316 | 1.02 |
| rt_text_s4k | 50000 | 427,350 | 444,840 | 0.96 |
| rt_text_s64k | 10000 | 80,000 | 144,718 | 0.55 |
| rt_lua_self | 20000 | 142,857 | 265,604 | 0.54 |
| send_self | 500000 | 2,762,431 | 1,032,844 | 2.67 |
| conc_self_k1 | 100000 | 540,541 | 522,739 | 1.03 |
| conc_self_k8 | 100000 | 534,759 | 524,934 | 1.02 |
| sp_t10 | 100000 | 448,430 | 1,090,513 | 0.41 |
| sp_t1000 | 5000 | 822.6 | 36,603 | 0.02 |
| sp_s64k | 2000 | 250,000 | 63,291 | 3.95 |
| startup_c | 500 | 500,000 | 3,211.3 | 155.70 |
| startup_self | 500 | 14,286 | 2,702.7 | 5.29 |
| timer_wake | 50000 | 500,000 | 558,659 | 0.90 |
| cl_jsjs_100 | 5000 | 299.5 | — | — |
| cl_jsjs_40k | 1000 | 371.5 | — | — |
| cl_jsjs_pipe | 5000 | 36,905 | — | — |
| cl_lualua_100 | 5000 | — | 347.7 | — |
| cl_lualua_40k | 1000 | — | 384.3 | — |
| cl_lualua_pipe | 5000 | — | 40,701 | — |
| cl_mixed_100 | 5000 | 305.6 | 320.8 | 0.95 |
| cl_mixed_40k | 1000 | 397.6 | 376.4 | 1.06 |
| cl_mixed_pipe | 5000 | 43,860 | 35,638 | 1.23 |
| sock_64 | 100000 | 128,399 | 131,368 | 0.98 |
| sock_4096 | 50000 | 87,140 | 87,176 | 1.00 |
| sock_65536 | 10000 | 9,240 | 9,134 | 1.01 |

| 内存 | skyjs | stock lua |
|---|---|---|
| bench 主服务框架记账（结束态） | 0.8 MB | 4.2 MB |
| core 阶段进程 RSS 峰值（含 500 常驻同语言 echo 服务） | 85.8 MB（3 轮 51.0..164.0） | 280.2 MB（279.8..353.7） |
| socket 服务端 RSS 峰值（64B echo） | 13.9 MB | 14.4 MB |
| socket 服务端 RSS 峰值（4096B echo） | 18.3 MB | 17.5 MB |
| socket 服务端 RSS 峰值（65536B echo，约 15s） | 28.3 MB（27.9..34.8） | 34.8 MB（29.4..37.5） |

## 解读

1. **内核基线校准通过**：`rt_text_c` 1.14x（同内核，差异来自调用方语言层的
   每次调用开销：JS 的 promise 挂起/恢复略便宜于 Lua 的协程 yield/resume）。
2. **同语言全栈 RTT 持平**（`rt_text_self` 1.00、`conc_*` 1.02-1.03、
   `timer_wake` 0.90）：一问一答路径上两套语言层成本相当。
3. **大包体 JS 变慢集中在 64KB**（`rt_text_s64k` 0.55；4KB 已持平 0.96）：
   JS 侧跨层要 UTF-8 解码（收）+ 再编码（发）+ QuickJS 字符串/ArrayBuffer
   拷贝；Lua 只做一次 tostring 拷贝。包体放大后拷贝次数差异才开始主导。
4. **seri 是 JS 侧最大短板**：wire 上 0.54（`rt_lua_self`）；纯序列化
   `sp_t10` 0.41；1000 元素数组 `sp_t1000` 0.02 —— 根因是 quickjs 的 Map 为
   链表实现（`map_add` O(n) 查重），1000 次 set 即 O(n²)。在
   「table→Map」契约 + 不改引擎的约束下此差距不可消除；突破需契约变更
   （数组型 table 解为 Array）或引擎 patch，均需另行立项评估。
5. **fire-and-forget JS 快 2.67x**（`send_self`）：回包被抑制后瓶颈在 echo 端
   每条消息的派发成本——Lua 每条消息起一个 dispatch 协程（skynet.lua 模型），
   JS 只是一次普通函数调用。
6. **服务创建**：`startup_c` 156x 是**结构差异**——skyjs 直接 LAUNCH 命令建 C
   服务（~4µs），原版经 launcher 服务一跳 RTT（min..max 250000..500000 受
   计时粒度粗化）。`startup_self` 5.29x：snjs ~70µs/个（字节码化，见
   HISTORY.md §3.9）vs snlua 经 launcher ~370µs/个。
7. **内存面持平或略优**：
   - 框架记账 0.8MB vs 4.2MB（结束态；JS 为 QuickJS 堆记账，Lua 为 gc count）。
   - core RSS 峰值 85.8 vs 280.2MB（中位数）。主要构成（单用例专用节点分解，
     tools/rss_trim*.sh）：skyjs = 500 常驻 snjs ~127MB（0.25MB/个）+
     timer_wake 5 万挂起 Promise ~70MB + 基线 ~14MB，余下为大包 RTT 的
     分配器高水位；lua = 50k timer 协程 ~90MB + 500 snlua ~27MB +
     基线 ~14MB，余下同为各场景 churn 高水位。该分解与整套件 RSS 采样
     分属不同口径（专用节点单用例 vs 250ms 轮询峰值）。
     单服务基线 snjs ~0.25MB vs snlua echo ~0.054MB（~4.6x，QuickJS 堆
     0.148MB/个）。剩余压缩空间已量化但均低优先级（见 [TODO.md](TODO.md)
     待办）。
   - **socket 服务端 RSS 三档均与 lua 同级**（64B 13.9 vs 14.4、4096B 18.3 vs
     17.5、65536B 28.3 vs 34.8MB，中位数）。历史上的数量级差距（64KB 时
     ~900MB）源于 `PTYPE_SOCKET DATA` 接收缓冲所有权泄漏，已修复
     （根因与过程见 [HISTORY.md](HISTORY.md) §2.2）；单纯消除 UTF-8 编解码
     对 RSS 无可测收益，不再作为内存优化方向。
   - RSS 轮次波动大（本轮 skyjs 51.0..164.0MB）来自 macOS 内存压缩时机，
     对比看中位数与多轮，勿用单轮。
8. **cluster 小包 RTT 被 TCP Nagle 绑死**：~295-385 msg/s（约 2.6-3.4ms/次）与
   实现无关——两侧的**响应方向**都不设 TCP_NODELAY（原版 clusteragent 裸
   socket.write；skyclusterd accepted socket 同样），串行一问一答时响应小段
   被 Nagle 拖住（skyjs 同语言 299.5 vs lua 347.7，同在 Nagle 平台内）。
   40KB 大包满段绕过 Nagle，双侧同口径。发送方向已对齐
   原版 clustersender.lua 的 `nodelay = true`。**pipelined 场景
   （`cl_*_pipe`，8 路并发在途）已证实这一点**：多在途请求下两侧均跳到
   3 万+ msg/s（串行的 ~100x），Nagle 平台被并发填满窗口摊薄；mixed 双向
   对比 skyjs 侧比 lua 侧高 ~23%，是 cluster 路径目前唯一观察到的实现
   差异。双侧 nodelay 的评估以 cl_pipe 残余差距为依据，另行讨论。
9. **cluster RTT 与 payload 大小/分帧无关**（payload 扫描实测：100B、8KB、
   20KB 单帧与 40KB/80KB 分帧全部落在同一个 ~3-4ms 平台）——分帧实现无差异，
   一切被 Nagle 平台主导。注意 `cl_*_40k` 各轮方差极大（如本轮 lualua
   268.9..742.1），**单轮对比不可靠**，必须多轮取中位数。
10. **socket 吞吐持平**（0.98-1.01）：echo 路径由共享内核 socket 机制主导，
    JS socket 桥（字符串跨界）与 lualib socket（阻塞读）成本相当。

## 已知限制

- 单机自压（客户端/服务端同机），绝对值受机器与系统状态影响，结论看相对值
  与多轮中位数；换机器重跑即得新基线。
- **机器状态漂移可达 1.5x**：跨时段的绝对值对比无效（lua 参照列同步涨跌），
  必须同机同时段 A/B 或用 lua 列归一化。
- RSS 采样粒度 250ms（`ps` 轮询），且受 macOS 内存压缩影响轮次间波动大
  （见解读第 7 条）；内存归因用单用例专用节点工具链
  （test/service/bench_main_trim.js、test/bench_lua/main_trim.lua +
  tools/rss_trim*.sh）。
- 仅 macOS/arm64 实测；Linux（epoll 路径）未验证。
