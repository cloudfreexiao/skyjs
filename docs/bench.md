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

2026-09-20，Apple M4 Pro，macOS，commit 7cc9350（post-P0 优化），repeat 3（中位数）。
原始数据在 `build/bench/raw_*.json`，报告在 `build/bench/report.md`。

### core 阶段

| case | skyjs msg/s | lua msg/s | ratio skyjs/lua |
|---|---|---|---|
| rt_text_c | 574,713 | 514,933 | 1.12 |
| rt_text_self | 500,000 | 520,833 | 0.96 |
| rt_text_s256 | 500,000 | 504,032 | 0.99 |
| rt_text_s4k | 390,625 | 426,621 | 0.92 |
| rt_text_s64k | 79,365 | 136,426 | 0.58 |
| rt_lua_self | 132,450 | 260,756 | 0.51 |
| send_self | 2,577,320 | 999,400 | 2.58 |
| conc_self_k1 | 512,821 | 504,796 | 1.02 |
| conc_self_k8 | 492,611 | 518,672 | 0.95 |
| sp_t10 | 462,963 | 1,085,776 | 0.43 |
| sp_t1000 | 31,250 | 35,663 | 0.88 |
| sp_s64k | 250,000 | 59,172 | 4.22 |
| startup_c | 250,000 | 2,657 | 94.10 |
| startup_self | 8,197 | 2,610 | 3.14 |
| timer_wake | 515,464 | 519,211 | 0.99 |

### 内存

| 指标 | skyjs | lua |
|---|---|---|
| 框架记账（结束态） | 1.0 MB | 4.2 MB |
| 进程 RSS 峰值 | 256.7 MB | 270.3 MB |

## 解读

1. **小/中包消息传递与 lua 基本持平**：`rt_text_c` 1.12、`rt_text_self` 0.96、
   `rt_text_s256` 0.99、`rt_text_s4k` 0.92、`conc_*` 0.95-1.02、
   `timer_wake` 0.99——一问一答路径上两套语言层成本相当。
2. **fire-and-forget JS 快约 2.6x**（`send_self` 2.58）：Lua 每条消息起 dispatch
   协程，JS 只是普通函数调用。
3. **大包（64KB）与 lua 互通路径有序列化开销**：`rt_text_s64k` 0.58、
   `rt_lua_self` 0.51——JS 跨层需 UTF-8 编解码 + QuickJS 字符串拷贝，
   包体越大差距越明显。
4. **大 table 序列化已大幅优化**：`sp_t1000`（1000 元素 Array pack+unpack）
   ratio 从 0.02 提升至 0.88（优化前 Map 构建路径存在 O(n²) 瓶颈，
   已改为 C 层 Array 直接构建 + Map 兼容方法包装）。`sp_s64k`（大包序列化）
   skyjs 约 4x 快，受益于 js-seri 零拷贝。
5. **启动速度 skyjs 仍显著快于 lua**：`startup_c` 94x、`startup_self` 3.1x，
   得益于字节码预编译 vs lua require 加载路径（该指标绝对值受轮次波动影响较大）。
6. **内存面框架记账 skyjs 优于 lua**：记账 1.0 vs 4.2MB；进程 RSS 峰值
   256.7 vs 270.3MB（RSS 受 macOS 内存压缩与系统状态影响，轮次间波动大）。
7. **绝对值跨时段可漂移**（机器状态、macOS 内存压缩等），ratio 更可靠。

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
