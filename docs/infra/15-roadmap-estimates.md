# 15 — 批次、依赖、估算与完成标准

本文件把各库文档串成可执行的实现路线（本批仍只写文档；此处定义后续实现批次的顺序与判定）。

## 15.1 依赖图

```
02 core-runtime (skynet 扩展 / stream / 二进制 / 取消)
   ├─ 03 sqlite (db)
   ├─ 04 http (webapp + httpd/httpc 流式)
   ├─ 05 fs + archive
   ├─ 06 subprocess (桌面)
   └─ 07 crypt 扩展
08 media + tag         依赖 02、05
09 plugin-host         依赖 02/03/04/05/06/07/08
10 config/log/metrics  依赖 02、03
11 testing             独立（尽早可用）
12 mobile              贯穿；随 02 起步，08 完成后封板
13 build-ci            贯穿（每批接线）
14 integration-release 各库完成后并入门禁
```

顺序硬约束：`02 → {03,04,05,06,07}`；`08` 在 `02/05` 后；`09` 在 `03/04/05/06/07/08` 后；
`12` 从 `02` 起持续，`08` 完成后封板；`11/13` 贯穿全程。

## 15.2 实现批次与人日（承接已批准的总计划）

| 批次 | 内容 | 人日 |
|---|---|---|
| B0 | 基线冻结 + 跨平台骨架 + `features()` + `testing` 起步 | 15–25 |
| B1 | 02 core-runtime（可取消/二进制/stream/socket 信号） | 20–30 |
| B2 | 03 sqlite（db + owner + migrate） | 20–30 |
| B3 | 04 http（webapp + 流式 + 背压 + 取消映射） | 35–50 |
| B4 | 05 fs/archive + 06 subprocess + 07 crypt 扩展（可并行） | 35–50 |
| B5 | 08 media + tag（含跨平台静态构建矩阵） | 60–95 |
| B6 | 09 plugin-host（受限 loader + host services + 运维） | 40–65 |
| B7 | 10 config/log/metrics + 11 testing 补全（P1） | 30–45 |
| B8 | 12 mobile 宿主与打包（AAR/XCFramework） | 45–70 |
| B9 | 14 集成硬化/门禁/发布 | 30–50 |
| 合计 | | 约 330–510 人日（约 16–25 人月） |

日历时间：单人约 18–28 个月；3 人约 8–12 个月（受 02/协议/移动构建的共享依赖限制，
4 人以上收益递减）。最大不确定性：iOS/Android 的 libav/TagLib 静态构建、媒体行为差分、
插件沙箱逃逸面。

## 15.3 并行分工建议（3 人）

- A：02 core-runtime → 03 sqlite → 10 config（数据/运行时主线）。
- B：04 http → 09 plugin-host → 11 testing（服务/插件主线）。
- C：05/06/07 → 08 media/tag → 12 mobile（系统/媒体/移动主线）。
- 共享协议与 ABI（02 的二进制/取消契约、01 命名总表）由 B0/B1 先冻结。

## 15.4 决策门

- 决策门 1（B1–B3 + 一条 B5 转码链，约 90–130 人日）：SQLite + 二进制 HTTP streaming +
  取消传播 + libav 转码跑通，内存/断连回收/移动真机达标。未达标暂停。
- 决策门 2（B6 后）：Miot/Cloudflared/DAV 三类插件分别通过 命令/网络/存储 兼容测试。

## 15.5 完成标准

- P0：`db`、`webapp`+流、`fs`/`archive`、`subprocess`（桌面）、`media`/`tag`、受限插件宿主
  均有稳定 Promise API、取消语义、资源上限，五平台验证通过。
- P1：`config`/`log`/`metrics`、`testing`、插件 SDK 完整、移动端产物齐全；核心路径具备
  差分/压力/安全/长跑测试。
- 达标后再单独制定 Songloft 数据层、服务层、约 192 个 HTTP 路由的业务迁移计划
  （不属于本文档族）。

## 15.6 提交策略

- 每批拆独立小提交：native API / JS wrapper / 测试 / 构建接线分别提交。
- 每批必须保持旧 API 与既有测试通过，不跨批留下不可构建状态。
- 行为变更同步三处文档（见 [../DEVELOPMENT.md](../DEVELOPMENT.md) 约定）与本目录对应文件。
