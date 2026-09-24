# 14 — 集成硬化、门禁与发布

依赖：全部库文档。目的：定义“基建可用”的客观判定与发布顺序，不含业务迁移。

## 14.1 双实例差分（Go Songloft ↔ SkyJS PoC）

- 对同一组黑盒输入（fixture、HTTP 请求序列、插件 API 调用），并行跑 Go Songloft 与
  SkyJS 基建 PoC，比较：
  - DB 最终状态（表快照差分）。
  - HTTP 响应：状态码、关键 header（Content-Range/ETag/Content-Type/Content-Length）、body。
  - 媒体产物：转码时长/码率、缩略图尺寸、标签字段、HLS 清单。
  - 错误分类：同一非法输入两侧归为等价的错误类别。
- 差分工具输出可读报告，纳入 CI（关键契约不允许回归）。

## 14.2 性能门禁

| 指标 | 门槛（相对 Go 基线或绝对值） |
|---|---|
| 冷启动耗时 | 记录基线，回归不超过约定阈值 |
| 常驻 RSS | 记录基线（snjs 约 0.25MB/服务，见 bench.md），设上限 |
| SQLite 吞吐 | 读/写 QPS 达标 |
| 静态文件吞吐 / 首字节时间 | 大文件 + Range 达标 |
| 转码实时系数 | ≥ 约定倍速（桌面/移动分别设） |
| 插件冷启动 | 首次 load + 首请求延迟达标 |
| 24h 稳定性 | RSS/句柄无单调增长 |

## 14.3 安全门禁

- 路径穿越（Node `fs`/`skyjs/fsx`/`skyjs/archive`）、SSRF（`fetch`/HTTP 内核/插件
  fetch 私网拦截）、ZIP bomb、超大 multipart、命令注入（`skyjs/subprocess`）、
  插件逃逸（无 `skynetcore`/`js/internal`/任意 Node 内置模块）、JWT 伪造、异常媒体文件。
- 每项有定向用例；全部通过方可发布。

## 14.4 决策门（承接 15）

- 决策门 1（基建可行性）：SQLite + 二进制 HTTP streaming + 取消传播 + 一条 libav 转码链
  跑通，且内存/断连回收/移动真机指标达标。未达标暂停后续建设。
- 决策门 2（插件基建可用）：Miot、Cloudflared、DAV 三类插件分别通过 命令/网络/存储 兼容
  测试后，方宣布插件基建可用于业务迁移。

## 14.5 发布顺序

1. macOS / Linux canary（服务器/桌面主线）。
2. Windows。
3. Android。
4. iOS。

任一平台失败不降低协议契约；确实不适用的能力只通过 `features()` 标注，不静默缺失。
`MEDIA_GPL` 构建单独通道，默认发布走 LGPL 配置。

引擎产物与 `@skyjs` 包产物**分开发布、分开版本号**（node-compatibility §16.4.1）：
引擎产物只有可执行文件/`snjs.so` 与内建模块清单；`@skyjs/<name>` 包按 npm 包发布，
原生部分随包（§16.4.3）。两者靠 `peerDependencies` 版本区间与 ABI 号对接，不做
“包编进引擎产物”的组合，也不为某个业务单独裁剪引擎。

## 14.6 Node 兼容门禁

- [../node-compatibility.md](../node-compatibility.md) §12.1 的每条兼容差异必须有
  `test/node-compat/` 用例覆盖；未覆盖的差异不得宣称对应 NC 批次完成。
- 差异表新增或修改必须与实现同批提交，不允许先改行为后补文档。
- 归层变更（某入口在引擎内建与 `@skyjs` 包之间移动）必须同批更新
  node-compatibility §16.4.1 与 01-conventions §3 的能力总表，且 `features()` 键不变。

## 14.7 验收

- 差分测试在 CI 常态运行，关键契约零回归。
- 性能/安全门禁全绿；决策门 1/2 有明确通过记录。
- 发布产物按平台顺序产出，能力清单与 `features()` 一致。
- 引擎产物不含任何 `packages/` 内容；删掉 `packages/` 后引擎仍能构建启动并跑通
  自验证用例（node-compatibility §16.4.1 收口标准）。
