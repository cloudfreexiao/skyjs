# SkyJS vs 原版 Skynet 性能对比压测

对比 SkyJS（QuickJS 服务）与原版 skynet（Lua 服务）的性能基线。工具链：
[tools/run_bench.js](../tools/run_bench.js)（零依赖 harness）+ 两侧逐场景镜像的
bench 脚本。运行方式：`make bench`（等价 `node tools/run_bench.js --phase all --repeat 3`）；
可选 `PHASE=core|cluster|socket|mem`、`REPEAT=N`。内存扩容曲线单跑：`make bench PHASE=mem`
（可用 `--counts 0,100,500` 或 `MEM_COUNTS` 覆盖档位、`--settle` 覆盖稳态等待）。

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
7. **每服务内存用专用节点稳态 RSS**：mem 阶段每档服务数各起一个干净节点，拉起
   N 个空闲 echo 服务并各发一次 RTT（强制惰性加载），等 `settle_ms`（默认 1000ms）
   让分配器/GC 落定后以 100ms 间隔采 6 次 `ps rss` 取中位数；减 N=0 基线得净增量与
   每服务斜率，避免 core 负载污染，比 core 末尾的整节点 RSS 峰值口径更干净。

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
| mem | `mem_scale_<N>` | 每档 N 个空闲 echo 服务的专用节点稳态 RSS（N=0/100/500/1000/3000/5000/10000）——每服务内存 footprint 与斜率 |

两侧脚本严格镜像：JS 侧 [test/service/bench_suite_main.js](../test/service/bench_suite_main.js)、
[bench_cluster_a/b.js](../test/service/bench_cluster_a_main.js)、
[bench_socket_main.js](../test/service/bench_socket_main.js)、
[bench_mem_main.js](../test/service/bench_mem_main.js)；Lua 侧
[test/bench_lua/](../test/bench_lua/)（`main.lua` / `cluster_main_a,b.lua` /
`socket_echo.lua` / `mem_main.lua`，配置与 clustername 同目录）。

## 基线数据

2026-09-21，Apple M4 Pro，macOS 26.6.2，commit 8b4c524，repeat 3（中位数）。
原始数据在 `build/bench/raw_*.json`，报告在 `build/bench/report.md`。cluster/socket
阶段易受残留端口与 TIME_WAIT 影响偶发 `no BENCH records`，重跑前先清 2528/2529/2530
（`make bench` 已内置 free_cluster_ports，仍偶发时手动 `pkill -f "skyjs .*bench"`
后等待 TIME_WAIT 释放再跑）。

### core 阶段

| case | skyjs msg/s | lua msg/s | ratio skyjs/lua |
|---|---|---|---|
| rt_text_c | 574,713 | 533,618 | 1.08 |
| rt_text_self | 505,051 | 535,906 | 0.94 |
| rt_text_s256 | 505,051 | 515,464 | 0.98 |
| rt_text_s4k | 396,825 | 435,920 | 0.91 |
| rt_text_s64k | 78,740 | 141,243 | 0.56 |
| rt_lua_self | 129,032 | 262,467 | 0.49 |
| send_self | 2,617,801 | 1,016,880 | 2.57 |
| conc_self_k1 | 507,614 | 526,870 | 0.96 |
| conc_self_k8 | 487,805 | 538,503 | 0.91 |
| sp_t10 | 398,406 | 1,128,668 | 0.35 |
| sp_t1000 | 31,250 | 36,792 | 0.85 |
| sp_s64k | 250,000 | 61,728 | 4.05 |
| startup_c | 250,000 | 2,900 | 86.20 |
| startup_self | 7,042 | 2,698 | 2.61 |
| timer_wake | 495,050 | 529,101 | 0.94 |

### cluster 阶段（cluster.call RTT，双向）

| case | n | skyjs msg/s | lua msg/s | ratio skyjs/lua |
|---|---|---|---|---|
| cl_jsjs_100 | 5000 | 304.2 | n/a | n/a |
| cl_jsjs_40k | 1000 | 471.7 | n/a | n/a |
| cl_jsjs_pipe | 5000 | 31,746 | n/a | n/a |
| cl_lualua_100 | 5000 | n/a | 342.0 | n/a |
| cl_lualua_40k | 1000 | n/a | 810.2 | n/a |
| cl_lualua_pipe | 5000 | n/a | 38,455 | n/a |
| cl_mixed_100 | 5000 | 308.0 | 320.0 | 0.96 |
| cl_mixed_40k | 1000 | 1136.4 | 498.4 | 2.28 |
| cl_mixed_pipe | 5000 | 37,879 | 32,092 | 1.18 |

### socket 阶段（TCP echo，responses/s）

| case | n | skyjs msg/s | lua msg/s | ratio skyjs/lua |
|---|---|---|---|---|
| sock_64 | 100000 | 139,770 | 142,121 | 0.98 |
| sock_4096 | 50000 | 89,831 | 88,841 | 1.01 |
| sock_65536 | 10000 | 9,090 | 8,861 | 1.03 |

### 内存

| 指标 | skyjs | lua |
|---|---|---|
| 框架记账（结束态） | 1.0 MB | 4.2 MB |
| 进程 RSS 峰值 | 206.2 MB | 276.9 MB |

### 内存扩容（mem 阶段，空闲 echo 服务，每档专用节点稳态 RSS）

2026-09-21 基线（同上环境，repeat 3 中位数）。每档一个专用节点，N 个空闲 echo 服务。

| services | skyjs RSS MB | lua RSS MB | ratio skyjs/lua |
|---|---|---|---|
| 0 | 13.9 | 13.8 | 1.01 |
| 100 | 54.6 | 19.3 | 2.84 |
| 500 | 215.5 | 40.1 | 5.38 |
| 1000 | 416.6 | 66.2 | 6.29 |
| 3000 | 1220.8 | 170.5 | 7.16 |
| 5000 | 2025.1 | 275.0 | 7.36 |
| 10000 | 3223.0 | 536.0 | 6.01 |
| per-service (KB, slope vs N=0) | 328.6 | 53.5 | 6.15 |

## 解读

1. **小/中包消息传递与 lua 基本持平**：`rt_text_c` 1.08、`rt_text_self` 0.94、
   `rt_text_s256` 0.98、`rt_text_s4k` 0.91、`conc_self_k1` 0.96、`conc_self_k8` 0.91、
   `timer_wake` 0.94——一问一答路径上两套语言层成本相当。
2. **fire-and-forget JS 快约 2.6x**（`send_self` 2.57）：Lua 每条消息起 dispatch
   协程，JS 只是普通函数调用。
3. **大包（64KB）与 lua 互通路径有序列化开销**：`rt_text_s64k` 0.56、
   `rt_lua_self` 0.49——JS 跨层需 UTF-8 编解码 + QuickJS 字符串拷贝，
   包体越大差距越明显。
4. **table 序列化随 LuaTable 无损映射微调**：`sp_t1000`（1000 元素表 pack+unpack）
   ratio 0.85；`sp_t10`（10 元素表，10 万次）ratio 0.35，unpack 现统一构造 `LuaTable`
   （含 Map + 类实例），小表的对象分配成本占比更高，这是无歧义映射的既定权衡（换取
   空表不再塌缩、索引基准不再翻转）。`sp_s64k`（大包序列化）skyjs 约 4x 快（4.05），
   受益于 js-seri 零拷贝。
5. **cluster 互通与 lua 基本持平**：`cl_mixed_100` 0.96；`cl_mixed_40k` 2.28、
   `cl_mixed_pipe` 1.18——串行 40k 受 Nagle/RTT 主导且轮次波动极大（见 min..max），
   pipe 8 路并发流水下 skyjs 略领先。cluster.call 载荷为字节串，未走 LuaTable 路径，
   与本次改造无关。
6. **socket 三档与 lua 持平**：`sock_64` 0.98、`sock_4096` 1.01、`sock_65536` 1.03。
7. **启动速度 skyjs 仍显著快于 lua**：`startup_c` 86x、`startup_self` 2.6x，
   得益于字节码预编译 vs lua require 加载路径（该指标绝对值受轮次波动影响较大）。
8. **内存面框架记账 skyjs 优于 lua**：记账 1.0 vs 4.2MB；进程 RSS 峰值
   206.2 vs 276.9MB（RSS 受 macOS 内存压缩与系统状态影响，轮次间波动大）。
9. **每服务内存 JS 显著高于 lua**：每服务斜率约 329 KB vs 53 KB（约 6x），10000 档
   skyjs 约 3.2 GB vs lua 536 MB——每个 snjs 服务持有独立 QuickJS runtime，snlua 仅
   一个 lua_State 复用共享 C 运行时；服务数越多差距越显著，空闲 footprint 是 JS Actor
   密集部署的主要成本项。
10. **绝对值跨时段可漂移**（机器状态、macOS 内存压缩等），ratio 更可靠。

## 已知限制

- 单机自压（客户端/服务端同机），绝对值受机器与系统状态影响，结论看相对值
  与多轮中位数；换机器重跑即得新基线。
- **机器状态漂移可达 1.5x**：跨时段的绝对值对比无效（lua 参照列同步涨跌），
  必须同机同时段 A/B 或用 lua 列归一化。
- RSS 采样粒度 250ms（`ps` 轮询），且受 macOS 内存压缩影响轮次间波动大
  （见解读第 7 条）；内存归因用单用例专用节点工具链
  （test/service/bench_trim_main.js、test/bench_lua/main_trim.lua +
  tools/rss_trim*.sh）。
- 仅 macOS/arm64 实测；Linux（epoll 路径）未验证。
- mem 阶段每服务稳态 RSS 同样受 macOS 内存压缩影响，绝对值轮次间波动，**每服务斜率
  比单档绝对值更可靠**；高档位（尤其 10000）单节点内存/耗时较高，跑正式基线时注意
  机器可用内存（per-node 超时按档位放大，10000 档 ≥ 300s）。
