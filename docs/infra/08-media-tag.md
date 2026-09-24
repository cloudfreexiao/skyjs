# 08 — 跨平台媒体（`skyjs/media`）与标签（`skyjs/tag`）

依赖：02（stream、取消）、05（fs）。构建开关：`MEDIA=libav`（见 13）。
能力键：`features().media`、`features().tag`。
归层：**`@skyjs` 包**（node-compatibility §16.4.1、ND-33），不内建。
涉及：`packages/media/`（发布为 `@skyjs/media`）——`index.js`、`lib/`（`client`/
`probe`/`transcode`/`thumbnail`/`hls`）、`native/src/js-media.c`（libav 封装）、
`service/media-service.js`（owner，注册名 `.media`）；`packages/tag/`（发布为
`@skyjs/tag`）——`index.js`、`lib/`（`client`/`fields`）、`native/src/js-tag.cc`
（TagLib C++ 适配）、可选 `service/tag-service.js`（`.tag`）。

引擎内建表不含这两个入口，loader 按 node-compatibility §3.1 层 2 回退
`node_modules/@skyjs/<name>`。包内原生部分按 §3.2/§3.4 携带预编译产物、静态库或
C/C++ 源码；移动端在应用构建期把静态库或源码链入 AAR/XCFramework（§12.4）。
移动端限制的是"运行时 `dlopen` 动态加载"这一形态，不影响包与源码放进
`node_modules`。

重任务由包内 L2 的 `.media` owner service 承担，包内 C 桥只提供同步原语；两者都随
包分发，不写进引擎 `service-src/`。包内不得 `require('js/internal/*')`、不得直接
调用 `skynetcore.*`（§16.4.1 规则 1）。

## 8.1 架构

- `.media` owner service 独占 libav 上下文与一个受控 **worker pool**（避免单服务被长转码
  独占；重任务在 worker 内运行，结果经 `streamCore` + 流控回传）。
- 移动端媒体走**内嵌 libav**（不依赖外部 ffmpeg 进程），因此不受 06 子进程限制。
- `tag` 读写既可并入 `.media` owner，也可独立 `.tag` service（构建期决定）；接口对业务无差别。
- 所有任务接受 `{ signal, timeoutMs }`；取消即中止 libav 处理并释放上下文。

## 8.2 包内原生绑定（`module.native`，仅 owner 使用）

以下名字描述包内 C 桥导出的函数面（挂各自包的 `module.native`），**不是引擎的
`skynetcore.*` 命名空间**（§16.5）：

```
// media（libav），挂 @skyjs/media 的 module.native
native.media.probe(inputSpec) -> info
native.media.openTranscode(spec) -> task            // 返回可拉取的输出流句柄
native.media.readOutput(task, ab) -> n | "eof"
native.media.cancel(task) / close(task)
// inputSpec: { path } | { url, headers, range } | { fd }

// tag（TagLib），挂 @skyjs/tag 的 module.native
native.tag.read(path) -> fields
native.tag.write(path, fields, pictures?)
```

## 8.3 `media` 客户端库（stable）

`require('skyjs/media')`。均接受可选末参 `{ signal, timeoutMs }`。

```js
media.probe(input, opts?) -> Promise<MediaInfo>
// input: { path } | { url, headers?, range? }
// MediaInfo = { duration, bitRate, sampleRate, channels, format,
//               streams:[{type,codec,...}], hasVideo, tags:{...} }

media.transcode(input, outputOpts) -> Readable
// outputOpts = {
//   format: "mp3"|"m4a"|"ogg"|"flac"|"wav",
//   bitrate?, sampleRate?, channels?,
//   seekSec?,             // 输入 seek 起点
//   speed?,                // atempo，夹到 [0.5, 2.0]
//   loudnorm?: bool|{I,LRA,TP},   // EBU R128
//   signal?, timeoutMs?
// }  → 输出为 Readable（chunked 流式，供 ctx.stream 直接转发）

media.fingerprint(input, opts?) -> Promise<{ fingerprint, duration }>   // Chromaprint 等价
media.thumbnail(input, opts?) -> Promise<ArrayBuffer>
// opts = { width?, height?, format?: "jpeg"|"png", quality?, atSec? }
media.hls(input, opts?) -> Promise<{ playlistDir, firstSegmentReady }>
// 生成/管理 HLS 切片目录；配合 webapp.ctx.file 提供 playlist/segment

media.version -> string
media.codecs() -> string[]                 // 当前构建支持的编解码
```

## 8.4 `tag` 客户端库（stable）

`require('skyjs/tag')`：音频标签与封面读写（对齐 Songloft `pkg/tag` 覆盖的格式）。

```js
tag.read(path) -> Promise<Tags>
// Tags = { title, artist, artists[], albumArtists[], album, track, disc,
//          year, genre, language, style, isrc, comment,
//          duration?, bitrate?, sampleRate?,
//          hasCover, lyric?, lyricSource?, custom:{...} }

tag.write(path, fields, opts?) -> Promise<void>
// opts = { cover?: {data:ArrayBuffer, mime}, lyric?: string,
//          keepUnspecified?: true }        // 只改传入字段，其余保留

tag.readCover(path) -> Promise<{ data: ArrayBuffer, mime } | null>

tag.version -> string
tag.formats() -> string[]                    // mp3/flac/m4a/ogg/ape/wav/aiff/...
```

- 多值字段（artists、albumArtists）结构化返回；单值 `artist` 作兼容回退。
- 自定义标签（如通用的 `custom["..."]`）透传，不内置任何业务专有键名。

## 8.5 第三方库与许可

- 媒体后端：FFmpeg/libav（libavformat/libavcodec/libavfilter/libswresample/libswscale）。
- 标签后端：TagLib（C++）。
- 图像缩放：优先复用 libav（swscale）或独立轻量图像库，输出 JPEG/PNG。
- 许可：默认采用 **LGPL 可分发配置**（动态或满足 LGPL 的静态链接义务）；GPL/nonfree
  编解码作为**显式独立构建开关**（`MEDIA_GPL=1`）并纳入发布合规检查（见 13、14）。

## 8.6 跨平台构建矩阵

| 平台 | libav | TagLib | 备注 |
|---|---|---|---|
| Linux/macOS | 静态 | 静态 | 桌面主线 |
| Windows(MinGW) | 静态 | 静态 | compat 层 |
| Android(NDK) | 静态(arm64/armv7/x86_64) | 静态 | 编入 AAR |
| iOS | 静态(device+sim) | 静态 | 编入 XCFramework |

构建脚本与依赖版本/校验值固定，见 [13-build-ci.md](13-build-ci.md)。

## 8.7 错误码

`ERR_UNSUPPORTED_PLATFORM`（无 MEDIA 构建/缺编解码）、`ERR_PROTOCOL`（损坏/不支持的容器）、
`ERR_CANCELLED`/`ERR_TIMEOUT`、`ERR_LIMIT_EXCEEDED`（输出/时长上限）、`ERR_IO`。
`err.detail` 带 `{ codec?, avErr? }`。

## 8.8 验收（对拍 Songloft 媒体 fixture）

- `probe`/`tag.read`：元数据字段与现有样本一致（时长、码率、多值 artist、封面存在性）。
- `tag.write`：写回后再读一致；`keepUnspecified` 不破坏其它字段。
- `transcode`：目标格式/码率/时长匹配；`seekSec`/`speed`/`loudnorm` 行为对拍。
- `thumbnail`：缩放尺寸/格式正确，超大图不 OOM（并发上限）。
- `hls`：playlist/segment 生成与首分片就绪通知。
- 取消：转码中途取消→libav 上下文释放、无残留 worker。
- 移动端真机：连续转码、切后台取消、内存峰值与温升在阈值内。
