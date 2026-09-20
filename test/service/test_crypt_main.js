// Task 8 acceptance: crypto module tests. Runs all crypt.* functions with
// known test vectors and prints CRYPT <name> OK / CRYPT FAIL markers.
"use strict";

let fail_count = 0;

function hex(ab) {
    return crypt.hex_encode(ab);
}

function ab_eq(a, b) {
    const va = new Uint8Array(a);
    const vb = new Uint8Array(b);
    if (va.length !== vb.length) return false;
    for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) return false;
    }
    return true;
}

function check(label, ok, detail) {
    if (ok) {
        console.log("CRYPT " + label + " OK");
    } else {
        console.log("CRYPT FAIL " + label + (detail ? ": " + detail : ""));
        fail_count++;
    }
}

function check_hex(label, ab, expected) {
    const got = hex(ab);
    check(label, got === expected, "got " + got + " expected " + expected);
}

skynet.start(() => {
    // ---- SHA family ----
    check_hex("sha1_abc",
        crypt.sha1("abc"),
        "a9993e364706816aba3e25717850c26c9cd0d89d");
    check_hex("sha1_empty",
        crypt.sha1(""),
        "da39a3ee5e6b4b0d3255bfef95601890afd80709");

    check_hex("sha256_abc",
        crypt.sha256("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    check_hex("sha256_empty",
        crypt.sha256(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    check_hex("sha512_abc",
        crypt.sha512("abc"),
        "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
        "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
    check_hex("sha512_empty",
        crypt.sha512(""),
        "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce" +
        "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e");

    // ---- HMAC family (RFC 4231 Test Case 2: key="Jefe") ----
    const hmac_data = "what do ya want for nothing?";
    check_hex("hmac_sha1",
        crypt.hmac_sha1("Jefe", hmac_data),
        "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
    check_hex("hmac_sha256",
        crypt.hmac_sha256("Jefe", hmac_data),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    check_hex("hmac_sha512",
        crypt.hmac_sha512("Jefe", hmac_data),
        "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554" +
        "9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737");

    // ---- Base64 ----
    const b64_enc = crypt.base64_encode("abc");
    check("base64_encode", b64_enc === "YWJj", "got " + b64_enc);

    const b64_dec = crypt.base64_decode("YWJj");
    check("base64_decode", hex(b64_dec) === "616263", "got " + hex(b64_dec));

    // roundtrip
    const b64_input = "Hello, SkyJS crypto!";
    const b64_rt = crypt.base64_decode(crypt.base64_encode(b64_input));
    const b64_rt_str = new TextDecoder().decode(new Uint8Array(b64_rt));
    check("base64_roundtrip", b64_rt_str === b64_input, "got " + b64_rt_str);

    // ---- Hex ----
    const hex_enc = crypt.hex_encode(new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer);
    check("hex_encode", hex_enc === "deadbeef", "got " + hex_enc);

    const hex_dec = crypt.hex_decode("deadbeef");
    check("hex_decode", hex(hex_dec) === "deadbeef", "got " + hex(hex_dec));

    // roundtrip
    const hex_input = new Uint8Array([0, 1, 127, 128, 255]);
    const hex_rt = crypt.hex_decode(crypt.hex_encode(hex_input.buffer));
    check("hex_roundtrip", ab_eq(hex_input.buffer, hex_rt), "mismatch");

    // ---- DES ----
    // roundtrip with ISO7816-4 padding (default)
    const des_key = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    const des_plain = "test1234extra";
    const des_enc = crypt.des_encode(des_key, des_plain);
    const des_dec = crypt.des_decode(des_key, des_enc);
    const des_dec_str = new TextDecoder().decode(new Uint8Array(des_dec));
    check("des_iso7816", des_dec_str === des_plain, "got " + des_dec_str);

    // roundtrip with PKCS7 padding
    const des_enc_p7 = crypt.des_encode(des_key, des_plain, crypt.padding.pkcs7);
    const des_dec_p7 = crypt.des_decode(des_key, des_enc_p7, crypt.padding.pkcs7);
    const des_dec_p7_str = new TextDecoder().decode(new Uint8Array(des_dec_p7));
    check("des_pkcs7", des_dec_p7_str === des_plain, "got " + des_dec_p7_str);

    // ---- DH key exchange ----
    const a_priv = crypt.randomkey();
    const b_priv = crypt.randomkey();
    const a_pub = crypt.dh_exchange(a_priv);
    const b_pub = crypt.dh_exchange(b_priv);
    const shared_a = crypt.dh_secret(b_pub, a_priv);
    const shared_b = crypt.dh_secret(a_pub, b_priv);
    check("dh_exchange", hex(shared_a) === hex(shared_b),
        "A=" + hex(shared_a) + " B=" + hex(shared_b));

    // ---- XOR ----
    const xor_orig = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    const xor_orig_hex = hex(xor_orig.buffer);
    const xor_data = xor_orig.buffer.slice(0);   // copy
    const xor_key = new Uint8Array([0xAB, 0xCD]).buffer;
    crypt.xor_str(xor_data, xor_key);
    const xor_mid = hex(xor_data);
    check("xor_changed", xor_mid !== xor_orig_hex, "XOR did not change data");
    crypt.xor_str(xor_data, xor_key);
    check("xor_roundtrip", hex(xor_data) === xor_orig_hex,
        "got " + hex(xor_data) + " expected " + xor_orig_hex);

    // ---- Random ----
    const rb = crypt.random_bytes(32);
    check("random_bytes_len", rb.byteLength === 32, "len=" + rb.byteLength);
    const rb_v = new Uint8Array(rb);
    let rb_nonzero = false;
    for (let i = 0; i < rb_v.length; i++) {
        if (rb_v[i] !== 0) { rb_nonzero = true; break; }
    }
    check("random_bytes_nonzero", rb_nonzero, "all zeros");

    const rk = crypt.randomkey();
    check("randomkey_len", rk.byteLength === 8, "len=" + rk.byteLength);
    const rk_v = new Uint8Array(rk);
    let rk_xor = 0;
    for (let i = 0; i < rk_v.length; i++) rk_xor ^= rk_v[i];
    check("randomkey_nonzero", rk_xor !== 0 || rk_v[0] !== 0, "all-zero XOR");

    // ---- AES-GCM (OpenSSL only — SKIP if unavailable) ----
    try {
        const aes_key = crypt.random_bytes(32);
        const aes_iv = crypt.random_bytes(12);
        const aes_plain = "hello aes-gcm";
        const enc_result = crypt.aes_gcm_encrypt(aes_key, aes_plain, aes_iv);
        const aes_ct = enc_result.ciphertext;
        const aes_tag = enc_result.tag;
        const aes_dec = crypt.aes_gcm_decrypt(aes_key, aes_ct, aes_iv, aes_tag);
        const aes_dec_str = new TextDecoder().decode(new Uint8Array(aes_dec));
        check("aes_gcm", aes_dec_str === aes_plain, "got " + aes_dec_str);
        // tag tampering
        const bad_tag = new Uint8Array(aes_tag);
        bad_tag[0] ^= 0xff;
        let tamper_ok = false;
        try {
            crypt.aes_gcm_decrypt(aes_key, aes_ct, aes_iv, bad_tag.buffer);
        } catch (e) {
            tamper_ok = true;
        }
        check("aes_gcm_tamper", tamper_ok, "tampered tag accepted");
    } catch (e) {
        if (e && e.message && e.message.includes("OpenSSL")) {
            console.log("CRYPT aes_gcm SKIP");
        } else {
            console.log("CRYPT FAIL aes_gcm: " + (e && e.message));
            fail_count++;
        }
    }

    // ---- Ed25519 (OpenSSL only — SKIP if unavailable) ----
    try {
        const kp = crypt.ed25519_keypair();
        const ed_msg = "sign me";
        const sig = crypt.ed25519_sign(kp.secret, ed_msg);
        const ok1 = crypt.ed25519_verify(kp.public, ed_msg, sig);
        check("ed25519_sign_verify", ok1, "verify returned false");
        const ok2 = crypt.ed25519_verify(kp.public, "tampered", sig);
        check("ed25519_tamper", !ok2, "tampered message verified true");
    } catch (e) {
        if (e && e.message && e.message.includes("OpenSSL")) {
            console.log("CRYPT ed25519 SKIP");
        } else {
            console.log("CRYPT FAIL ed25519: " + (e && e.message));
            fail_count++;
        }
    }

    // ---- X25519 (OpenSSL only — SKIP if unavailable) ----
    try {
        const kp_a = crypt.x25519_keypair();
        const kp_b = crypt.x25519_keypair();
        const s_a = crypt.x25519_shared(kp_a.secret, kp_b.public);
        const s_b = crypt.x25519_shared(kp_b.secret, kp_a.public);
        check("x25519", hex(s_a) === hex(s_b),
            "A=" + hex(s_a) + " B=" + hex(s_b));
    } catch (e) {
        if (e && e.message && e.message.includes("OpenSSL")) {
            console.log("CRYPT x25519 SKIP");
        } else {
            console.log("CRYPT FAIL x25519: " + (e && e.message));
            fail_count++;
        }
    }

    // ---- summary ----
    if (fail_count === 0) {
        console.log("CRYPT ALL OK");
    } else {
        console.log("CRYPT FAIL total=" + fail_count);
    }
});
