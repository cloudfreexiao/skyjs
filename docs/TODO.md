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
- **长跑与统计对账**:计划中的 30 分钟长跑、memstat 与 RSS 对账尚未执行;
  quickjs 内部缓存可能存在 memstat 盲区,误差量级待确认。

## 功能增强(按优先级)

1. **cluster 断线重连退避**:skyclusterd 当前为固定 1s 重试(skynet_timeout
   100cs);宜加指数退避 + 抖动,避免对端宕机时的重试风暴。
2. **skyclusterd 代码清理**:`conn_send_frame` 等遗留死代码;inbound(request)/
   outbound(response) 的分帧组装可抽公共层。
3. **二进制消息约定文档化**:text 协议走 UTF-8 字符串、lua 协议走
   ArrayBuffer(响应按调用方协议解码);建议为 JS 服务固化一份协议约定文档。
4. **TypeScript 接入示例**:运行时为 QuickJS,加载 ts 转译产物(如 esbuild 打包)
   即可,无需改 C 层;补一个示例服务与构建脚本。
5. **互通测试一键化**:互通用例已迁入 `skyjs/test/cluster_lua/`(原版节点由
   `3rd/skynet` 子工程构建执行,CWD = 3rd/skynet,路径回指 `../../test/cluster_lua/`);
   可再补一个脚本把“submodule 构建 + 双节点启动 + 结果断言”串成一键验收。

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
