// skyjs crypt bridge (Task 4 — crypto wrapper layer).
// Loaded by snjs after socket.js and before sockethelper.js (env key
// "js_crypt", default "./js/crypt.js"). Wraps skynetcore.crypt (pure-C
// hash/DES/DH/base64/hex, see js-crypto.c) into globalThis.crypt with
// auto String→ArrayBuffer coercion and graceful OpenSSL detection.
(function () {
    "use strict";

    const cc = skynetcore.crypt;
    const encoder = new TextEncoder();

    // --------------------------------------------------------- helpers

    /**
     * Coerce input to ArrayBuffer.
     *   string      → UTF-8 encode to ArrayBuffer
     *   ArrayBuffer  → passthrough
     *   TypedArray   → slice underlying buffer to the view's range
     */
    function to_ab(data) {
        if (data instanceof ArrayBuffer) return data;
        if (typeof data === "string") return encoder.encode(data).buffer;
        if (ArrayBuffer.isView(data)) {
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
        throw new TypeError("crypt: expected string, ArrayBuffer, or TypedArray");
    }

    /**
     * Guard for OpenSSL-only functions that may not exist on skynetcore.crypt.
     */
    function require_openssl(name) {
        if (typeof cc[name] !== "function") {
            throw new Error("crypt." + name + " requires OpenSSL build (make TLS=openssl)");
        }
    }

    // ----------------------------------------------- padding constants

    const padding = Object.freeze({ iso7816_4: 0, pkcs7: 1 });

    // -------------------------------------------- public crypt object

    globalThis.crypt = {
        padding,

        // ---- Hash --------------------------------------------------

        sha1(data) {
            return cc.sha1(to_ab(data));
        },
        sha256(data) {
            return cc.sha256(to_ab(data));
        },
        sha512(data) {
            return cc.sha512(to_ab(data));
        },

        // ---- HMAC (standard) ---------------------------------------

        hmac_sha1(key, data) {
            return cc.hmac_sha1(to_ab(key), to_ab(data));
        },
        hmac_sha256(key, data) {
            return cc.hmac_sha256(to_ab(key), to_ab(data));
        },
        hmac_sha512(key, data) {
            return cc.hmac_sha512(to_ab(key), to_ab(data));
        },

        // ---- Encoding ----------------------------------------------

        base64_encode(data) {
            return cc.base64_encode(to_ab(data));
        },
        base64_decode(str) {
            // C side expects a JS string, not ArrayBuffer
            return cc.base64_decode(String(str));
        },
        hex_encode(data) {
            return cc.hex_encode(to_ab(data));
        },
        hex_decode(str) {
            return cc.hex_decode(String(str));
        },

        // ---- AEAD (OpenSSL) ----------------------------------------

        aes_gcm_encrypt(key, plaintext, iv, aad) {
            require_openssl("aes_gcm_encrypt");
            return cc.aes_gcm_encrypt(to_ab(key), to_ab(plaintext), to_ab(iv),
                aad !== undefined ? to_ab(aad) : undefined);
        },
        aes_gcm_decrypt(key, ciphertext, iv, tag, aad) {
            require_openssl("aes_gcm_decrypt");
            return cc.aes_gcm_decrypt(to_ab(key), to_ab(ciphertext), to_ab(iv),
                to_ab(tag), aad !== undefined ? to_ab(aad) : undefined);
        },

        // ---- Ed25519 (OpenSSL) -------------------------------------

        ed25519_keypair() {
            require_openssl("ed25519_keypair");
            return cc.ed25519_keypair();
        },
        ed25519_sign(secret_key, message) {
            require_openssl("ed25519_sign");
            return cc.ed25519_sign(to_ab(secret_key), to_ab(message));
        },
        ed25519_verify(public_key, message, sig) {
            require_openssl("ed25519_verify");
            return cc.ed25519_verify(to_ab(public_key), to_ab(message), to_ab(sig));
        },

        // ---- X25519 (OpenSSL) --------------------------------------

        x25519_keypair() {
            require_openssl("x25519_keypair");
            return cc.x25519_keypair();
        },
        x25519_shared(secret_key, peer_public) {
            require_openssl("x25519_shared");
            return cc.x25519_shared(to_ab(secret_key), to_ab(peer_public));
        },

        // ---- Utility -----------------------------------------------

        random_bytes(n) {
            return cc.random_bytes(n | 0);
        },
        xor_str(data, key) {
            return cc.xor_str(to_ab(data), to_ab(key));
        },

        // ---- Skynet protocol compat --------------------------------

        randomkey() {
            return cc.randomkey();
        },
        hashkey(data) {
            return cc.hashkey(to_ab(data));
        },
        des_encode(key, text, pad) {
            return cc.des_encode(to_ab(key), to_ab(text),
                pad !== undefined ? (pad | 0) : undefined);
        },
        des_decode(key, text, pad) {
            return cc.des_decode(to_ab(key), to_ab(text),
                pad !== undefined ? (pad | 0) : undefined);
        },
        hmac64(x, y) {
            return cc.hmac64(to_ab(x), to_ab(y));
        },
        hmac64_md5(x, y) {
            return cc.hmac64_md5(to_ab(x), to_ab(y));
        },
        hmac_hash(key, text) {
            return cc.hmac_hash(to_ab(key), to_ab(text));
        },
        dh_exchange(key) {
            return cc.dh_exchange(to_ab(key));
        },
        dh_secret(x, y) {
            return cc.dh_secret(to_ab(x), to_ab(y));
        },
    };
})();
