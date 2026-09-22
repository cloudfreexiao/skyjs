# 07 — 密码学扩展（`crypt`）

依赖：无（同步原语）。构建开关：部分算法需 `TLS=openssl`。能力键：`features().crypt_ext`。
涉及：扩展 `js/crypt.js`（`globalThis.crypt`）、`service-src/js-crypto.c`（`skynetcore.crypt`）。

原则：**现有接口全部保留不变**（见 `js/crypt.js`）：`sha1/sha256/sha512`、
`hmac_sha1/hmac_sha256/hmac_sha512`、`base64_*`、`hex_*`、`aes_gcm_*`、`ed25519_*`、
`x25519_*`、`random_bytes`、`xor_str`、`randomkey/hashkey/des_*/hmac64*/dh_*`。
本批仅**新增**插件生态所需算法，命名沿用 `lower_snake_case`，输入统一走现有 `to_ab` 强制。

## 7.1 新增接口（stable）

```js
// 摘要
crypt.md5(data) -> ArrayBuffer                 // data: string|ArrayBuffer|TypedArray
crypt.md5_hex(data) -> string

// 流加密
crypt.rc4(key, data) -> ArrayBuffer            // 对称，加解密同一函数

// 分组加密（CBC）
crypt.aes_cbc_encrypt(key, plaintext, iv, opts?) -> ArrayBuffer
crypt.aes_cbc_decrypt(key, ciphertext, iv, opts?) -> ArrayBuffer
// opts = { padding?: "pkcs7"(默认) | "none" }；key 长度决定 AES-128/192/256

// 非对称
crypt.rsa_public_encrypt(pem_public_key, plaintext, opts?) -> ArrayBuffer
// opts = { padding?: "pkcs1"(默认) | "oaep" }

// 压缩（zlib / raw deflate，供 ZIP/网络协议解析）
crypt.zlib_inflate(data) -> ArrayBuffer
crypt.zlib_deflate(data, opts?) -> ArrayBuffer      // opts = { level?: 0..9 }
crypt.raw_inflate(data) -> ArrayBuffer              // 无 zlib 头（ZIP 成员）
crypt.raw_deflate(data, opts?) -> ArrayBuffer

crypt.version -> string
```

映射到 `skynetcore.crypt` 新增原生原语（internal）：`md5 / rc4 / aes_cbc_encrypt /
aes_cbc_decrypt / rsa_public_encrypt / zlib_inflate / zlib_deflate / raw_inflate /
raw_deflate`。zlib 系用系统 zlib 或 quickjs 已链的等价实现；AES/RSA 走 OpenSSL（`TLS=openssl`）。

## 7.2 与插件生态的对应

对齐 Songloft 插件运行时（`internal/jsruntime`）的原生桥接，等价能力一览：

| 插件侧（现有 Go 宿主） | SkyJS `crypt` |
|---|---|
| `__go_crypto_md5` | `crypt.md5_hex` |
| `__go_crypto_sha1/sha256` | 现有 `crypt.sha1/sha256`（+ hex） |
| `__go_crypto_sha256_bytes` | `crypt.sha256`（二进制入） |
| `__go_crypto_rc4` | `crypt.rc4` |
| `__go_crypto_aes_encrypt/decrypt` | `crypt.aes_cbc_*`（及现有 `aes_gcm_*`） |
| `__go_crypto_rsa_encrypt` | `crypt.rsa_public_encrypt` |
| `__go_crypto_random_bytes` | 现有 `crypt.random_bytes` |
| `__go_zlib_inflate/deflate/raw_inflate` | `crypt.zlib_*` / `crypt.raw_*` |

> 说明：插件不直接调 `crypt`，而是经插件宿主暴露的受控 `crypto.*`（见 09）。此表用于保证
> 宿主可用 `crypt` 无缝实现这些桥接。

## 7.3 编码便捷（可选）

```js
crypt.hex(data) / crypt.unhex(str)             // 现有 hex_encode/hex_decode 的短别名（保留旧名）
crypt.b64(data) / crypt.unb64(str)             // 现有 base64_* 的短别名（保留旧名）
```
别名为可选糖，旧名不废弃。

## 7.4 错误码

- 无 OpenSSL 构建调用 AES/RSA：`ERR_UNSUPPORTED_PLATFORM`（沿用现有
  `require_openssl` 抛错精神，但统一 `err.code`）。
- 输入非法/padding 校验失败：`ERR_PROTOCOL`。
- 密钥长度非法：`ERR_PROTOCOL`（`err.detail` 带期望长度）。

## 7.5 验收

- 与 Songloft Go 宿主的加密向量对拍：md5/rc4/aes-cbc/rsa/zlib 逐字节一致。
- Miot 插件签名链（sha256(key+nonce) + rc4 + base64）在 `crypt` 上复现成功。
- 现有 `crypt` 测试与 `test/config_crypt.json` 不回归。
- 非 OpenSSL 构建：AES/RSA 抛 `ERR_UNSUPPORTED_PLATFORM`，摘要/zlib/rc4 仍可用。
