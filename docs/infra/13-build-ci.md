# 13 — 构建开关与 CI 矩阵

涉及：扩展 `Makefile`、`.github/workflows/build.yml`；新增移动端构建脚本。
原则：沿用现有 `TLS=openssl` 风格的构建开关；`3rd/` 保持零修改；平台产物不入库。

归层（node-compatibility §16.4.1、ND-33）：下表中 `SQLITE`/`MEDIA`/`TAG` 三个开关
对应的是 **`@skyjs` 包**的原生部分（`packages/db`、`packages/media`、`packages/tag`），
`ARCHIVE` 只在启用包内原生加速时有意义；`SUBPROCESS`/`NATIVE_EXT` 属于**引擎**。
无论如何择性，引擎默认构建都不依赖 `packages/`。

## 13.1 构建开关（新增，与现有 STATIC/RELEASE/TLS 并列）

| 开关 | 归层 | 作用 | 说明 |
|---|---|---|---|
| `SUBPROCESS=1` | 引擎 | 编入 `js-subprocess.c` | 桌面默认开，移动端强制关 |
| `NATIVE_EXT=1` | 引擎 | 编入 `js-native.c`（第三方 C 桥装载器） | 提供 `skynetcore.native.*`：`extpath` 非空时走动态装载，静态链入的包走 `initStatic` 查表；静态构建也需编入此项。不提供通用 FFI，见 node-compatibility §3.4 |
| `SQLITE=1` | 包 `@skyjs/db` | 编入包内 `native/src/js-sqlite.c` + SQLite | 静态链接固定版本 SQLite |
| `MEDIA=libav` | 包 `@skyjs/media` | 编入包内 `native/src/js-media.c` + libav | 默认 LGPL 可分发配置 |
| `MEDIA_GPL=1` | 包 `@skyjs/media` | 允许 GPL/nonfree 编解码 | 独立开关，触发发布合规检查 |
| `TAG=taglib` | 包 `@skyjs/tag` | 编入包内 `native/src/js-tag.cc` + TagLib | C++ 适配，需 C++ 链接 |
| `ARCHIVE=1` | 包 `@skyjs/archive` | 编入包内 `native/src/js-archive.c` | 可选：默认纯 JS，仅原生加速时开 |
| 现有 `TLS=openssl` | 引擎 | AES/RSA/TLS/HTTPS/WSS | crypt 扩展的 AES/RSA 依赖此项（OpenSSL 链接在引擎侧） |
| 现有 `STATIC=1` / `RELEASE=1` | 引擎 | 单文件 / 瘦身 | 不变 |

组合示例（桌面全量）：`make SQLITE=1 MEDIA=libav TAG=taglib SUBPROCESS=1 ARCHIVE=1 TLS=openssl`。
移动端：`SUBPROCESS` 关，其余按需开，全静态。
移动端 `extpath` 留空，即不启用动态装载；第三方 C 桥改由构建期静态链入主程序，
经 `native-registry.c` 登记后由 `initStatic` 命中。`NATIVE_EXT=1` 仍需开启。

## 13.2 新库的构建接线（对齐现有 rtBc 机制）

- **模块清单自动收录**：构建脚本扫描 `js/bootstrap.js`、`js/loader.js`、`js/internal/**`、
  `js/builtins/**`，生成模块 id → 源码/字节码 的清单包；不再维护
  `snjs.c lazy_setup_js` 的手写 `F` 表，也不再有 `extern snjs_bc_*` 逐符号列表。
  新增模块 = 新增文件 + 清单重新生成。
- 已安装的 `node_modules/@skyjs/*` 包可选纳入同一清单（用于把 `skyjs/<name>` 入口
  指向包实现），并按包 `package.json#skyjs.native` 的平台键值表挑出当前目标的
  `native/**`（预编译库）或 `src/**`（C/C++ 源码）参与链接；内建实现存在时仍以
  内建优先（node-compatibility §3.1–3.2、§3.4.6）。
- `build/rtBc.c` 改为批量编译整个模块目录（开发期直接读 `jsModuleSource=disk` 下的源码；
  发布期读嵌入式字节码包），与现有 qjsc 规则衔接；同一入口处理
  `require('<node-module>')` 与 `require('skyjs/<name>')` 两套模块 id。
- 引擎新 C 源（`service-src/*.c`）各自 `build/*.o` 规则，`-fvisibility=hidden`，按开关
  择性链入 `cservice/snjs.so`（或 STATIC 时并入 `skyjs`）。**包内 C/C++ 源不链进
  `snjs.so`**：要么编成包内 `native/<platform>-<arch>/` 产物，要么由应用构建期静态
  链入宿主（§13.3、§16.4.3）。
- env 键从逐库 `js<Lib>`/`js_<lib>` 收敛为 `jsBootstrap`/`jsModuleRoot`/
  `jsModuleSource`（见 01-conventions §3.2、node-compatibility §16.5）；新增模块
  不再改 C 代码或 env。
- owner service 分两处：引擎 `service/` 由
  `skynet.newservice("snjs service/<cap>-service.js …")` 启动；包内
  `packages/<name>/service/` 由 `skynet.newservice("@skyjs/<name>",
  "service/<cap>-service.js …")` 启动（§16.8）。构建需确保两类 service 目录都随
  产物或包分发。

## 13.3 第三方依赖治理

- 每个第三方库（SQLite / FFmpeg / TagLib / zlib / OpenSSL）：固定版本号 + 归档校验值
  （sha256）+ 许可证记录，集中在 `docs/infra/deps.lock`（实现批次产出，本批只约定格式）。
- 移动端静态库构建脚本（各平台/ABI）产物为未跟踪文件，不入库；构建可复现（脚本 + 版本锁）。
- 第三方原生能力可由 `node_modules/@skyjs/<name>` 提供：包内放预编译静态库或
  C/C++ 源码，构建脚本在 AAR/XCFramework 组装阶段把源码编成静态库并链入。按形态
  导出对应入口符号：cservice 走四符号约定（node-compatibility §3.2），C 桥走
  `skyjs_ext_abi` / `skyjs_ext_init`（§3.4.3）；静态链入多个 C 桥时按包名改写
  符号名并生成 `native-registry.c`，包自身源码不用感知改写。构建脚本因此需要
  扫描已安装的 `@skyjs/*` 包及其 `skyjs.native` 表，而不是只处理仓库内固定依赖。

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

Node 兼容专项：`test/unit/` 直接以 `node --test` 运行纯逻辑用例；
`test/node-compat/` 在 Node 20 与 SkyJS 两侧跑同一组用例做差分对拍（见
[../node-compatibility.md](../node-compatibility.md) §12）。两者纳入 CI 常态门禁，
`fs` 覆盖率为 NC2 的发布前置。

## 13.6 验收

- 五平台全部可构建；开关组合正确择性链入对应模块。
- `features()` 与实际编入的模块一致（开关关 → 能力标 unavailable）。
- 依赖版本锁存在且可复现构建；平台产物不入库。
- 模块清单随目录变化自动更新；删除任一模块后 C 侧无需改动即可构建。
