# 10 — 配置（`config`）、日志（`log`）、指标（`metrics`）

依赖：02、03（config 持久化用 db）。能力键：常驻可用。
涉及：新增 `js/config.js`、`js/log.js`、`js/metrics.js`；
owner `service/config_service.js`(`.config`)、`service/metrics_service.js`(`.metrics`)；
日志复用 `skynetcore.error`（skynet 日志通道），可选 `.log_sink` 落盘 service。

## 10.1 `config` 库（stable）

分层配置：**启动 JSON（现状，`skynet.getenv`）** + **DB 持久化 + 运行时热更 + 订阅**。

```js
config.get(key, default?) -> Promise<string>
config.get_json(key, default?) -> Promise<any>
config.set(key, value) -> Promise<void>            // 持久化到 .config（DB）
config.set_json(key, obj) -> Promise<void>
config.delete(key) -> Promise<void>
config.subscribe(key, fn) -> unsub                 // 值变更回调（跨服务广播）
config.validate(key, schema) -> Promise<void>      // 轻量 schema 校验
config.snapshot() -> Promise<object>               // 全量（脱敏后）

config.version -> string
```

- 静态运行时参数（thread/cpath/bootstrap 等）仍由启动 JSON 提供（不改现有机制）。
- 业务动态配置（可热更）走 `.config` owner + DB `configs` 表（对齐 Songloft `ConfigService`）。
- 变更通知：`.config` 广播给订阅者（如 HTTP router 重建、扫描器重配）。
- 校验失败：`ERR_PROTOCOL`；缺失且无默认：`ERR_NOT_FOUND`。
- 脱敏：`snapshot`/日志导出时按 key 模式屏蔽敏感值（token/password/secret）。

## 10.2 `log` 库（stable）

结构化日志，底层仍走 skynet 日志通道（`skynetcore.error`，保持与 `console.*` 统一）。

```js
log.trace|debug|info|warn|error(msg, fields?)      // fields 为结构化键值对象
log.with(fields) -> Logger                          // 派生带固定字段的子 logger
log.set_level(level)                                // 运行时切换（trace..error）
log.get_level() -> string
log.redact(patterns)                                // 追加脱敏字段名/正则

log.version -> string
```

- 字段串联：约定 `req_id / service / plugin / process` 等标准字段，贯穿 04/06/09 便于排障。
- 输出：默认 stdout（经 skynet 日志）；可选 `.log_sink` 落盘 + 轮转 + 脱敏导出
  （对齐 Songloft `RotateWriter` 与 `/logs/export`），落盘失败降级为仅 stdout。
- 级别热切换：`set_level` 即时生效（对齐 `/settings/log-level`）。

## 10.3 `metrics` 库（stable）

```js
metrics.counter(name, labels?) -> Counter          // .inc(n=1)
metrics.gauge(name, labels?) -> Gauge              // .set(v) / .inc / .dec
metrics.histogram(name, buckets?, labels?) -> Histogram  // .observe(v)
metrics.timer(name, labels?) -> Timer              // .start() -> stop()
metrics.export(format?) -> Promise<string>         // "prometheus"(默认) | "json"

metrics.version -> string
```

- 采集在各服务内本地累加，`.metrics` owner 聚合后由 `webapp` 暴露 `/metrics`。
- 健康检查：`webapp` 提供 `/health`（进程存活 + 关键 owner service ping）。
- 追踪：Tracely/OpenTelemetry 通过**可插拔 exporter**接入（`metrics.set_exporter(fn)` /
  错误上报 hook），不硬绑定某一后端（对齐 Songloft Tracely 可选注入）。

## 10.4 错误码

`ERR_NOT_FOUND`（key 缺失）、`ERR_PROTOCOL`（校验失败/格式非法）、`ERR_IO`（落盘失败，
降级不阻断）、`ERR_CANCELLED`/`ERR_TIMEOUT`。

## 10.5 验收

- `config`：DB 持久化 + 热更 + 订阅通知；启动 JSON 与 DB 分层优先级明确；敏感值脱敏。
- `log`：级别热切换即时生效；结构化字段可被下游解析；落盘失败降级仅 stdout。
- `metrics`：Prometheus 导出格式正确；`/health`、`/metrics` 可用；exporter 可插拔切换。
- 排障链路：一次请求可用 `req_id` 串联 HTTP→DB→media→plugin 日志。
