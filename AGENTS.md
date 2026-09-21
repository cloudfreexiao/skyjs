# AGENTS.md — SkyJS 开发指南

面向 AI 编码代理。详细规范（验收矩阵、C/JS 边界、编码约定全文、排查入口）见
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)，演进记录与问题归因见
[docs/HISTORY.md](docs/HISTORY.md)，遗留事项见 [docs/TODO.md](docs/TODO.md)。动手改代码前先读完本文与 DEVELOPMENT.md。

## 项目概述

SkyJS 将 [Skynet](https://github.com/cloudwu/skynet)（submodule `3rd/skynet/`，
**源码零修改**）与 QuickJS（quickjs-ng，`3rd/quickjs/`）结合的 Actor 模型服务端
框架：C 内核 + JS 服务。三条核心原则：

- **内核零侵入**：skynet-src 15/17 文件原样编译，`platform/` 提供替代层（JSON 配置）
- **与 snlua 逐项对齐**：内存记账限额、死循环打断、session↔Promise 调度同构
- **线协议字节级兼容**：js-seri 与原版 lua-seri 对拍，skyclusterd 兼容原版 cluster 线协议

## 常用命令

```sh
git submodule update --init     # 首次：拉取 skynet + quickjs-ng
make                            # 构建 ./skyjs + cservice/*.so + test 服务
make test/seri_tool             # lua-seri 对拍工具
make lint                       # JS 静态检查（提交前必跑，零依赖）
./skyjs test/config_core.json        # 运行（CWD 必须是仓库根目录）
```

## 硬性约束

1. **永不修改 `3rd/` 下文件**；需要内核能力时扩展 `platform/` 或 `service-src/`。
2. **协议兼容最高优先级**：影响 lua-seri 字节格式或 cluster 线协议的改动，必须
   用 `test/seri_tool` 对拍 / 与原版节点互通验证。
3. **编码规范**：JS 标识符一律 lower_snake_case（无连写豁免，对齐 skynet 生态），
   C 注入名同规则、JS/C 同步改名；禁 `var`；协议层兼容细节见 DEVELOPMENT.md。
4. **功能边界**：未实现清单（harbor master-slave、snlua、inject、sharetable、snax
   等）见 DEVELOPMENT.md——未实现 ≠ 永久排除，引入前先与用户确认设计，勿擅自实现。
5. **平台基线** macOS/arm64；Linux 分支未实测（socket_server.c epoll 路径）。

## 排查入口

日志用 `console.*`（映射 skynet 日志通道）或 `skynetcore.error`；内存看
`skynetcore.mem()` + `js_memlimit`；死循环用 SIGNAL 打断。详见 DEVELOPMENT.md。
