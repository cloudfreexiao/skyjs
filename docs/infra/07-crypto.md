# 07 — 密码学与压缩（Node `crypto`/`zlib` + `skyjs/crypt`）

依赖：无（同步原语）。构建开关：部分算法需 `TLS=openssl`。能力键：`features().cryptExt`。
归层：**引擎内建**（node-compatibility §16.4.1、ND-33）。`crypt` 与层 1 的
`crypto`/`zlib` 共用 `internal/crypt-core.js` 与 `js-crypto.c`。
涉及：`js/internal/crypt-core.js`（共享内核，抽自 `js/crypt.js`）、
`js/builtins/skyjs/crypt.js`（`require('skyjs/crypt')`）、`js/builtins/crypto.js`
与 `js/builtins/zlib.js`（Node facade）、`service-src/js-crypto.c`
（`skynetcore.crypt`）。

`skynetcore.crypt` 是同步原语，无 owner service；引擎内建实现不依赖
`node_modules`，保证默认构建自洽。

原则：**现有接口语义保留不变，但形态改为 `require` 模块**（原 `globalThis.crypt`）：
`sha1/sha256/sha512`、
`hmacSha1/hmacSha256/hmacSha512`、`base64_*`、`hex_*`、`aes_gcm_*`、`ed25519_*`、
`x25519_*`、`randomBytes`、`xorStr`、`randomkey/hashkey/des_*/hmac64*/dh_*`。
本批仅**新增**插件生态所需算法，命名沿用 lowerCamelCase，输入统一走现有 `toAb` 强制。

## 7.1 新增接口（stable）

```js
// 摘要
crypt.md5(data) -> ArrayBuffer                 // data: string|ArrayBuffer|TypedArray
crypt.md5Hex(data) -> string

// 流加密
crypt.rc4(key, data) -> ArrayBuffer            // 对称，加解密同一函数

// 分组加密（CBC）
crypt.aesCbcEncrypt(key, plaintext, iv, opts?) -> ArrayBuffer
crypt.aesCbcDecrypt(key, ciphertext, iv, opts?) -> ArrayBuffer
// opts = { padding?: "pkcs7"(默认) | "none" }；key 长度决定 AES-128/192/256

// 非对称
crypt.rsaPublicEncrypt(pemPublicKey, plaintext, opts?) -> ArrayBuffer
// opts = { padding?: "pkcs1"(默认) | "oaep" }

// 压缩（zlib / raw deflate，供 ZIP/网络协议解析）
crypt.zlibInflate(data) -> ArrayBuffer
crypt.zlibDeflate(data, opts?) -> ArrayBuffer      // opts = { level?: 0..9 }
crypt.rawInflate(data) -> ArrayBuffer              // 无 zlib 头（ZIP 成员）
crypt.rawDeflate(data, opts?) -> ArrayBuffer

crypt.version -> string
```

映射到 `skynetcore.crypt` 新增原生原语（internal）：`md5 / rc4 / aesCbcEncrypt /
aesCbcDecrypt / rsaPublicEncrypt / zlibInflate / zlibDeflate / rawInflate /
rawDeflate`。zlib 系用系统 zlib 或 quickjs 已链的等价实现；AES/RSA 走 OpenSSL（`TLS=openssl`）。

## 7.2 与插件生态的对应

对齐 Songloft 插件运行时（`internal/jsruntime`）的原生桥接，等价能力一览：

| 插件侧（现有 Go 宿主） | SkyJS `skyjs/crypt` |
|---|---|
| `__go_crypto_md5` | `crypt.md5Hex` |
| `__go_crypto_sha1/sha256` | 现有 `crypt.sha1/sha256`（+ hex） |
| `__go_crypto_sha256_bytes` | `crypt.sha256`（二进制入） |
| `__go_crypto_rc4` | `crypt.rc4` |
| `__go_crypto_aes_encrypt/decrypt` | `crypt.aes_cbc_*`（及现有 `aes_gcm_*`） |
| `__go_crypto_rsa_encrypt` | `crypt.rsaPublicEncrypt` |
| `__go_crypto_random_bytes` | 现有 `crypt.randomBytes` |
| `__go_zlib_inflate/deflate/rawInflate` | `crypt.zlib_*` / `crypt.raw_*` |

> 说明：插件不直接调 `crypt`，而是经插件宿主暴露的受控 `crypto.*`（见 09）。此表用于保证
> 宿主可用 `crypt` 无缝实现这些桥接。

## 7.3 编码便捷（可选）

```js
crypt.hex(data) / crypt.unhex(str)             // 现有 hexEncode/hexDecode 的短别名
crypt.b64(data) / crypt.unb64(str)             // 现有 base64_* 的短别名
```
别名为可选糖；原 `hexEncode`/`base64_*` 长名保留在 `skyjs/crypt` 内，但不提升为全局。

### Node `crypto` / `zlib` facade

`require('crypto')` 与 `require('zlib')` 在本内核之上做 Node 语义适配（`createHash`、
`createHmac`、`randomBytes`、`randomUUID`、`timingSafeEqual`、`gzip`/`gunzip`/
`deflateRaw` 等常用子集）。首版只承诺常用子集，不承诺完整 OpenSSL 绑定或 native
addon 兼容；不支持的能力抛 `ERR_UNSUPPORTED_PLATFORM`。`skyjs/crypt` 保留 SkyJS 自有
命名与返回类型（如 `ArrayBuffer`），两者共享 `internal/crypt-core`。

## 7.4 错误码

- 无 OpenSSL 构建调用 AES/RSA：`ERR_UNSUPPORTED_PLATFORM`（沿用现有
  `requireOpenssl` 抛错精神，但统一 `err.code`）。
- 输入非法/padding 校验失败：`ERR_PROTOCOL`。
- 密钥长度非法：`ERR_PROTOCOL`（`err.detail` 带期望长度）。

## 7.5 验收

- 与 Songloft Go 宿主的加密向量对拍：md5/rc4/aes-cbc/rsa/zlib 逐字节一致。
- Miot 插件签名链（sha256(key+nonce) + rc4 + base64）在 `crypt` 上复现成功。
- 现有 `crypt` 测试与 `test/config-crypt.json` 不回归。
- 非 OpenSSL 构建：AES/RSA 抛 `ERR_UNSUPPORTED_PLATFORM`，摘要/zlib/rc4 仍可用。
