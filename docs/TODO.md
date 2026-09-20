# SkyJS 遗留事项与后续计划

> 状态基线:v0.1 — Task 0-7 全部验收通过(macOS/arm64)。
> 验收矩阵见根目录 [README.md](../README.md)。

## 版本控制与部署

- **独立主工程**:skyjs 是 git 主仓库,不再依附原 skynet 工作目录(该目录
  废弃);首次提交包含全部源码与两个 submodule 引用。
- **submodule URL 均指向上游 GitHub**:`3rd/skynet` → cloudwu/skynet,
  `3rd/quickjs` → quickjs-ng;两者绑定的 commit 均在各自 origin 分支可达,
  全新环境 `git clone` + `git submodule update --init` 即可完整恢复。
- **原版构建产物未跟踪**:与原版互通验收需在 `3rd/skynet` 内执行
  `make`(生成 `./skynet`、luaclib/、cservice/ 等,均为未跟踪文件),不影响
  “skynet 源码零修改”承诺;清理用 submodule 内 `make clean`。
- **quickjs-ng 已转 submodule**:`3rd/quickjs/` 以 shallow 方式添加
  (`--depth 1`),固定于构建验证过的上游 commit;`.gitmodules` 与 gitlink
  均已就位。上游前进后用 `git submodule update --remote` 跟进,换版本时
  重跑 `make` 并冒烟验证即可。
- **`.gitignore` 已补**:忽略 `/skyjs` 主程序二进制、`build/`、`cservice/*.so`、
  `test/cservice/*.so`、`test/seri_tool` 与 `*.dSYM`(submodule 与源码目录全部
  纳入版本控制)。

## 平台与稳定性

- **Linux 验证未做**:目前仅在 macOS/arm64 全链验证。Makefile 已有 Linux 分支
  (`-lrt --shared`),待实测点:epoll 路径的 socket_server.c、动态库链接参数差异。
- **长跑与统计对账已落地**(2026-09):`make longrun`(tools/run_longrun.js,
  `DURATION` 分钟,默认 30)持续混合负载(多协议 RTT + fire-and-forget +
  定时器 + 每 tick 创建/销毁 2 个临时服务的生命周期 churn),服务侧每秒打
  tick(JS 堆记账)+ harness 侧 1s RSS 序列,结束时对账 js_mem 与 RSS 增长量
  (memstat 盲区,quickjs 内部缓存若存在会在盲区中显形)并落盘
  build/longrun/*.json。**30 分钟基线结论**(M4 Pro,2026-09-20):1801 tick /
  ~42 万 ops 吞吐零漂移(基于进程内 elapsed_ms 分段计时,首尾均 233 ops/s);
  js_mem 全程平坦(0.3MB,增长 0);RSS 15.3MB→4.5MB(峰值 15.4MB,负增长为
  macOS 内存压缩归还页)——含每分钟 120 个临时服务创建/销毁下无泄漏,
  **memstat 盲区在 30 分钟尺度上不可测(≤RSS 噪声)**,旧待办「quickjs 内部缓存盲区误差量级待确认」就此结案。
  实现注意:snjs_param 在用户脚本 eval 完成后才注入(snjs.c post-JS_Eval),
  服务内读取需延迟到首个 await 之后;临时服务销毁用
  `KILL :hex` 格式(十进制 handle 静默失效,详见 DEVELOPMENT.md 排查入口)。
- **JS 服务常驻内存（2026-09-20 归因修正）**:旧基线「1.4MB/服务、RSS 峰值
  1GB vs 360MB」是 js_send 泄漏造成的误归因——泄漏修复后的正式基线
  (repeat 3 中位数)core RSS 峰值 235.3MB vs 270.3MB;真实单服务基线
  snjs ~0.25MB vs snlua echo ~0.054MB
  (~4.6x,QuickJS runtime 堆 0.148MB),详见 bench.md「解读」第 7 条。
  剩余压缩空间已量化但均为低优先级:共享 runtime 多
  context(-43% 但破坏 per-service memlimit/SIGNAL 隔离,需立项)、minimal
  context 白名单(现实集 -6% 堆)、socket/cluster 库按需加载(几十 KB/服务)。
  另:socket 阶段 64KB 包 JS 服务端 RSS ~900MB vs lua ~35MB(拷贝放大 +
  分配器留存),是当前明确的内存优化候选,见 bench.md 解读第 7 条。

## 功能增强(按优先级)

1. **cluster 重连语义已对齐官方**(2026-09 完成,原计划"指数退避+抖动"作废):
   核对官方源码发现 cluster 路径(socketchannel 一律 connect-once)本无后台
   重连——重连完全由下一次请求驱动,每请求至多一次 connect 尝试,失败立即
   报错。skyclusterd 已删除固定 1s 后台重试(arm_retry/node_retry_all),
   断线或连接失败时立即 PTYPE_ERROR 失败该节点全部 pending 请求并清空待发
   帧,下一个请求按需重新 connect。验收场景 `test/config_cluster_fail.json`
   (套件用例 cluster_fail:对端宕机→立即失败×2→对端上线→按需重连成功)。
2. **skyclusterd 分帧组装已抽公共层**(2026-09 完成):inbound(request)/
   outbound(response) 的 multipart 重组(`lr_*`/`or_*` 两组同构字段)合并为
   `struct reasm` + `reasm_start/chunk/clear`,两侧共用;响应侧重组后的
   冗余 memcpy 一并消除(重组缓冲本就是 skynet_malloc 块,所有权直传给
   PTYPE_TAG_DONTCOPY)。发送侧拆分不合并:两侧单帧 threshold 语义不同
   (响应 `<=MULTI_PART`、请求 `<MULTI_PART`),系对拍原版 lua-cluster 的
   逐字节行为,保持原样。验收:cluster_fail 用例新增 40KB 双向大帧断言
   (CLUSTER BIG OK: 40005),旧代码交叉验证测试本身有效。
3. **二进制消息约定已文档化**(2026-09 完成):跨层类型契约固化于
   DEVELOPMENT.md「二进制消息协议约定」一节(text 协议走 UTF-8 字符串、lua 协议
   与响应走 ArrayBuffer、响应按调用方协议解码、pack/unpack 与 lua-seri 字节级
   兼容、int64 经 BigInt 往返、TYPE_USERDATA unpack 即报错)。
4. **TypeScript 接入已落地**(2026-09 完成):运行时全局注入面的类型声明
   `js/skyjs.d.ts`(与三个运行时库同源维护,注入面变更需同步更新),示例服务
   `examples/ts_echo/`(esbuild 剥离类型为 iife 纯 JS,snjs 以源码模式加载,
   无需改 C 层);构建 `examples/ts_echo/build.sh`(npx esbuild,仅构建期工具,
   运行时仍零 npm 依赖),验收 `./skyjs examples/ts_echo/config.json` 输出
   TS_ECHO_OK(text RTT + lua 协议 pack/unpack + JS 对象/数组→table
   hash/数组部分往返断言)。
5. **互通测试已一键化**(2026-09 完成):`make interop`(等价
   `node tools/run_interop.js`,复用 run_tests 的 watch/断言工具)串联
   submodule 增量构建 → 端口清理 → skyjs 互配节点(必须先起,原版 Lua 节点
   启动完成前要 call 进它)→ 原版 Lua 节点 → 双向断言(JS→lua 与 lua→JS
   各自的 RESULT 标记)。专用互配场景 `test/config_cluster_interop.json`,
   skyjs 侧 query 轮询等待 lua 就绪(每轮一次 connect 尝试,同官方语义)。
   注意原版节点每次启动都会打 `KILL self`(bootstrap 服务自退),互配脚本
   的 NEVER 哨兵只作用于 skyjs 流。手动双终端方式保留不变。
6. **console 面增强已落地**(2026-09 完成,独立 stdout 通道未做):新增
   time/timeLog/timeEnd(Date.now 墙钟,纯观测、不挂 dispatch,调度模型的
   worker 归还保证不受影响)与 printf 风格格式化(%s/%d/%i/%f/%j/%o/%%,
   首参为含 % 的字符串才启用,未知/缺参占位符原样保留,多余参数追加尾部;
   方法名保持标准 console API 面)。验收场景已接入套件(用例 js_console,
   套件增至 11 场景)。
7. **cluster 发送方向 TCP_NODELAY 已对齐官方**(2026-09,对比压测驱动):
   压测发现 skyclusterd 出站连接未设 TCP_NODELAY,而原版 clustersender.lua
   `nodelay = true`;已在 SKYNET_SOCKET_TYPE_CONNECT 处补上(仅出站/发送侧,
   接收方向与原版 clusteragent 一致保持默认)。注意两侧**响应方向均无
   nodelay**,串行小包 cluster.call RTT(约 2.9-4ms)被 Nagle 主导,属双侧
   共有特性;后续可评估双侧 nodelay 并补 pipelined cluster 压测场景
   (方法学与数据见 [bench.md](bench.md))。
8. **对比压测套件已建立**(2026-09):`make bench`(tools/run_bench.js)三层
   对比 SkyJS vs 原版 skynet(core:核心消息面/cluster:双向含混合互通/
   socket:TCP echo),基线数据与解读见 [bench.md](bench.md)。
9. **性能优化首轮已完成**(2026-09,均经同机同时段 A/B 对照确认):
   a. **js-seri 写缓冲重构**:连续几何增长缓冲(记账分配器)+ ArrayBuffer
      零拷贝交接,`sp_s64k` 净收益 ~4x;unpack 改平铺数组 + 单次 JS helper
      建 Map。**边界发现:quickjs 的 Map 为链表实现,Map.set O(n) 查重使
      大表 unpack 为 O(n²)(纯 JS 可复现),在 table→Map 契约下 sp_t1000
      类场景无优化空间**;突破需契约变更(数组型 table 解为 Array)或
      引擎 patch,待另行评估。
   b. **mixed 40KB 异常已证伪**:payload 扫描(100B/8KB/20KB 单帧与
      40KB/80KB 分帧)证明 cluster RTT 与包大小/分帧无关,全被响应方向
      Nagle 平台主导;109 msg/s 为运行瞬态(复测 535)。无需代码修复。
   c. **运行时库字节码化**:qjsc 构建期生成 skynet/socket/cluster.js
      字节码(snjs 对默认路径走 JS_ReadObject+JS_EvalFunction,非默认
      路径/版本偏离回退源码),`startup_self` 净收益 ~1.9x(对 snlua
      达 4.76x,~70µs/个)。RSS 峰值无明显变化(主要来自 runtime 基线)。
   遗留优化候选:JS 服务常驻内存(runtime 基线见「平台与稳定性」节)、seri
   大表场景的契约变更评估。pipelined cluster 压测场景已补(见 bench.md),
   双侧 nodelay 的评估可基于 cl_pipe 数据另议。

## 已知限制

- config 为扁平 JSON(platform/main.c 内置 ~100 行解析器),不支持原版的
  `$VAR` 替换与 `include`。
- 无 snlua/launcher/debug_console/harbor(master-slave);inject 热更新、
  sharetable、snax、datacenter 等无对应物。
- js-seri 不映射 TYPE_USERDATA(指针),unpack 遇到即报错(跨 VM 禁传指针,
  与原版语义一致);int64 经 BigInt 往返,JS number 侧超过 2^53 需自觉使用 BigInt。
- 对已连接 socket 重复 `socket.start` 会重发 `OPEN("transfer")` 事件,
  socket.js 已按状态文本过滤;直接使用底层 `skynetcore.socket` 时需自行注意
  (只有 resume/accept 后的首次 start 才是真实连接事件)。
- skynet 的 `TIMEOUT` 单位是 centisecond(10ms),JS 侧 `skynet.sleep(ms)` 已做
  换算;直接调 `skynetcore.command("TIMEOUT", ...)` 时注意单位。
