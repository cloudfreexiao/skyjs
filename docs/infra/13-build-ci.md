# 13 — 构建开关与 CI 矩阵

涉及：扩展 `Makefile`、`.github/workflows/build.yml`；新增移动端构建脚本。
原则：沿用现有 `TLS=openssl` 风格的构建开关；`3rd/` 保持零修改；平台产物不入库。

## 13.1 构建开关（新增，与现有 STATIC/RELEASE/TLS 并列）

| 开关 | 作用 | 说明 |
|---|---|---|
| `SQLITE=1` | 编入 `js-sqlite.c` + SQLite | 静态链接固定版本 SQLite |
| `MEDIA=libav` | 编入 `js-media.c` + libav | 默认 LGPL 可分发配置 |
| `MEDIA_GPL=1` | 允许 GPL/nonfree 编解码 | 独立开关，触发发布合规检查 |
| `TAG=taglib` | 编入 `js-tag.cc` + TagLib | C++ 适配，需 C++ 链接 |
| `SUBPROCESS=1` | 编入 `js-subprocess.c` | 桌面默认开，移动端强制关 |
| `ARCHIVE=1` | 编入 `js-archive.c` | zip/tar.gz + zlib |
| 现有 `TLS=openssl` | AES/RSA/TLS/HTTPS/WSS | crypt 扩展的 AES/RSA 依赖此项 |
| 现有 `STATIC=1` / `RELEASE=1` | 单文件 / 瘦身 | 不变 |

组合示例（桌面全量）：`make SQLITE=1 MEDIA=libav TAG=taglib SUBPROCESS=1 ARCHIVE=1 TLS=openssl`。
移动端：`SUBPROCESS` 关，其余按需开，全静态。

## 13.2 新库的构建接线（对齐现有 rtBc 机制）

- 新 JS 库（`js/db.js` 等）纳入 `build/rtBc.c` 的 qjsc 预编译清单（见现有 Makefile
  `build/rtBc.c` 规则），与 skynet.js/socket.js 等同批生成字节码。
- 新 C 源（`js-sqlite.c` 等）各自 `build/*.o` 规则，`-fvisibility=hidden`，按开关择性链入
  `cservice/snjs.so`（或 STATIC 时并入 `skyjs`）。
- 新 env 键 `js_<lib>` 与懒加载 `F` 表登记（见 01-conventions §3）随之更新。

## 13.3 第三方依赖治理

- 每个第三方库（SQLite / FFmpeg / TagLib / zlib / OpenSSL）：固定版本号 + 归档校验值
  （sha256）+ 许可证记录，集中在 `docs/infra/deps.lock`（实现批次产出，本批只约定格式）。
- 移动端静态库构建脚本（各平台/ABI）产物为未跟踪文件，不入库；构建可复现（脚本 + 版本锁）。

## 13.4 依赖构建矩阵

| 依赖 | Linux/macOS | Windows(MinGW) | Android(NDK) | iOS |
|---|---|---|---|---|
| SQLite | 静态 | 静态 | 静态 | 静态 |
| zlib | 系统/静态 | 静态 | 静态 | 静态 |
| OpenSSL | 系统/静态 | 静态 | 静态 | 静态 |
| FFmpeg/libav | 静态(LGPL) | 静态 | 静态×3 ABI | 静态 device+sim |
| TagLib | 静态 | 静态 | 静态 | 静态 |

## 13.5 CI 矩阵（扩展 `.github/workflows/build.yml`）

| 平台 | 构建 | 测试 |
|---|---|---|
| macOS arm64/x86_64 | 全开关组合 | `make test` + `make longrun`(短) + ASan 定向 |
| Linux x86_64/aarch64 | 全开关组合 | `make test` + `make interop` + ASan/UBSan |
| Windows x86_64 (MinGW) | 全量构建 | smoke test（启动 + 基础场景） |
| Android arm64/armv7/x86_64 | 交叉编译 + AAR 打包 | 宿主进程内最小启动/停止测试 |
| iOS arm64 (+sim) | 交叉编译 + XCFramework | 最小启动/停止测试 |

门禁：任一平台构建失败阻断合并；lint（`npm run lint`，eslint）沿用；新增许可证合规检查
（`MEDIA_GPL` 构建单独标注，不进默认发布）。

## 13.6 验收

- 五平台全部可构建；开关组合正确择性链入对应模块。
- `features()` 与实际编入的模块一致（开关关 → 能力标 unavailable）。
- 依赖版本锁存在且可复现构建；平台产物不入库。
