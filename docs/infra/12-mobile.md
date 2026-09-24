# 12 — 移动端可嵌入 ABI（Android AAR / iOS XCFramework）

依赖：全部 P0 库（尤其 08 media 内嵌）。能力键：`features()` 在移动端标注
`subprocess.available=false`，`media/tag/sqlite/httpStream=true`。
归层：宿主接入属**引擎**，落 `platform/mobile/`（node-compatibility §16.4.2）；
`media`/`tag`/`db`/`webapp`/`archive`/`config`/`metrics` 仍是 `@skyjs` 包，由应用
构建期把包的静态库或 C/C++ 源码链入 AAR/XCFramework（§16.4.3）。
涉及：新增 `platform/mobile/`（可嵌入实例入口 + JNI/C ABI）、构建目标（见 13）。

移动端同样走目标架构：业务与插件只经 `require(...)` 访问模块，内嵌实例启动时执行
`js/bootstrap.js` 建立 CJS loader；旧全局库（`io`/`httpd`/`httpc`）不再提供。

## 12.1 可嵌入实例（核心改造）

把 SkyJS 主循环从“进程独占”改造成“可嵌入实例”：

- 独立线程启动 skynet 调度器，不调用进程级 `exit`（库模式禁止 `abort/exit`，错误经回调上报）。
- 幂等启动/关闭；关闭时优雅停止所有 owner service、释放原生资源、join 线程。
- 端口回传：监听端口=0 时由系统分配，启动后回报真实端口。

统一 C ABI（供 JNI / Swift 包装调用）：

```c
// platform/mobile/skyjsMobile.h
int  skyjs_start(const char *configJson);   // 返回实际端口，<0 为错误码
void skyjs_stop(void);
int  skyjs_is_running(void);
int  skyjs_get_port(void);
// 错误/日志回调注册
void skyjs_set_log_callback(void (*cb)(int level, const char *msg));
void skyjs_set_error_callback(void (*cb)(const char *code, const char *msg));
```

- 语义对齐 Songloft 现有 `mobile.Start/Stop/IsRunning/GetPort`，便于客户端平滑替换。
- `configJson`：扁平 JSON（含 dataDir、musicDir、port、js 库路径覆盖等）。

## 12.2 Android

- `platform/mobile/android/`：JNI wrapper（`skyjsJni.c`）暴露
  `SkyjsNative.start/stop/isRunning/getPort`，日志/错误回调经 JNI 上抛。
- ABI：`arm64-v8a`、`armeabi-v7a`、`x86_64`；`minSdk` 与 Songloft 现状对齐（androidapi 23）。
- 产物：`songloft-skyjs.aar`（含各 ABI 静态库 + libav/TagLib/SQLite/OpenSSL 静态）。
- 沙盒：data/music 目录由宿主传入；网络权限、前后台生命周期、低内存回调由宿主转发到
  `skyjs_stop`/GC 提示。

## 12.3 iOS

- `platform/mobile/ios/`：Swift 可调用包装（modulemap + 头），`Skyjs.start/stop/...`。
- slices：`arm64` device + `arm64/x86_64` simulator；全静态链接。
- 产物：`Skyjs.xcframework`（含 libav/TagLib/SQLite/OpenSSL 静态）。
- 沙盒：容器路径、后台音频/网络能力、`applicationDidReceiveMemoryWarning` → 释放缓存。

## 12.4 平台能力差异

- 原生依赖不要求内建进运行时：`node_modules/@skyjs/<name>` 包可携带预编译静态库或
  C/C++ 源码，在本节的全静态构建中链入 AAR/XCFramework；包的入口仍按 §3.1 层 2
  回退解析（构建清单纳入包即可，§13.2）。移动端受限的是运行时 `dlopen` 动态加载，
  不是包与源码能否放在 `node_modules`。
- 第三方 C 桥在移动端同样按包内 `package.json#skyjs.native` 的平台键值表挑源，
  构建期链入并登记进 `native-registry.c`；运行时经
  `skynetcore.native.initStatic()` 命中，不依赖 `extpath`
  （node-compatibility §3.4.3、§3.4.5）。
- `subprocess`：移动端不编入，调用抛 `ERR_UNSUPPORTED_PLATFORM`；插件 manifest 声明
  `command` 时由 `pluginManager` 明确拒绝并给出稳定错误（见 06、09）。
- `media`：始终走内嵌 `.media` owner（libav 静态），转码/探测/标签/缩略图全部本机完成，
  不依赖任何外部可执行文件。
- 其余模块跨平台一致：引擎内建 `Node http`/`Node fs`/`skyjs/fsx`/`skyjs/crypt`/
  `skyjs/log`/`skyjs/pluginHost`，包 `skyjs/db`/`skyjs/webapp`/`skyjs/archive`/
  `skyjs/config`/`skyjs/metrics`。包未随应用打包时对应能力标缺失，不静默降级
  （node-compatibility §3.3）。

## 12.5 错误码

`ERR_UNSUPPORTED_PLATFORM`（子进程等）、`ERR_IO`（沙盒路径/权限）、
`ERR_INTERNAL`（启动失败，经 error 回调上报，不崩溃宿主）。

## 12.6 验收

- ABI 语义与 Songloft `mobile.*` 一致：重复 `start/stop` 幂等、端口回传正确。
- Android/iOS 真机：扫描本地目录、`tag` 读写、播放（含 Range）、`media.transcode` seek/speed、
  停止服务全链路通过。
- 反复 start/stop 与切后台：无泄漏、无崩溃；低内存回调触发缓存释放。
- `features()` 在移动端正确标注 subprocess 不可用、media 可用。
