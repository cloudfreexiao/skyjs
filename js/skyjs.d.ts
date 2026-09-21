// js/skyjs.d.ts -- SkyJS 运行时全局注入面的 TypeScript 类型声明，与 js/ 下
// 运行时库同源维护（skynet.js / socket.js / sockethelper.js / cluster.js /
// http.js / websocket.js 的注入对象 + service-src/snjs.c 注入的 skynetcore）。TypeScript 服务经
// `/// <reference path="..." />` 引用（见 examples/ts_echo/ts_echo.ts）；
// esbuild 只剥离类型不做检查，如需强检查可另跑 `tsc --noEmit`。API 面以
// js/*.js 与 snjs.c 的实际注入为准（docs/DEVELOPMENT.md「C/JS 边界」），改动
// 注入面时同步更新。

// 启动参数由 snjs 在用户脚本 eval 完成后注入；同步启动阶段不可读取，详见
// DEVELOPMENT.md「排查问题的入口」。
declare const snjs_param: string;

/**
 * seri 解包的唯一 Lua table 目标类型（无损映射 Lua table 语义）。
 * 一个 Lua table = 数组段（键 1..n）+ 哈希段，故：
 * - `array`：0-based JS 数组，逻辑上对应 Lua 键 `1..n`。
 * - `hash`：Map，承载所有非 `1..n` 键（整数键保持 number，字符串键为 string）。
 * 打包侧 LuaTable 为规范源；JS Array/Map/Object 作为便捷语法糖也可打包，
 * 但一律回读为 LuaTable。整数键 hash 必须走 `hash`/Map，普通对象的数字键
 * 会被映射为字符串键（JS 限制）。
 */
declare class LuaTable<V = unknown> {
    constructor(array?: V[], hash?: Map<unknown, V>);
    /** 数组段：0-based，逻辑对应 Lua 键 1..n */
    array: V[];
    /** 哈希段：非 1..n 的任意键 */
    hash: Map<unknown, V>;
    /** 数组段长度，等价于 Lua `#t` */
    readonly len: number;
    /** 镜像 Lua `t[k]`：正整数落在数组段取 array[k-1]，否则查 hash */
    get(k: unknown): V | undefined;
    /** 镜像 Lua `t[k]=v`：可追加数组段（k===len+1）或写入 hash */
    set(k: unknown, v: V): this;
    /** 以 [key, value] 形式遍历（数组段键为 1-based），先数组段后哈希段 */
    entries(): Array<[unknown, V]>;
    [Symbol.iterator](): IterableIterator<[unknown, V]>;
    /** 调试/JSON：合并为普通对象（数组段键转为 1-based 字符串键） */
    toJSON(): Record<string, V>;
}

declare const skynetcore: {
    /** 发送消息；顺序与底层一致：dest, type, msg, session（0=fire-and-forget） */
    send(dest: number, type: number, msg: string | ArrayBuffer | null,
        session?: number): number;
    command(cmd: string, arg?: string): string | null;
    int_command(cmd: string, arg?: string): number;
    gen_id(): number;
    /** skynet 启动后的厘秒（10ms）计数，同原版 skynet.now */
    now(): number;
    error(msg: string): void;
    /** 本服务 JS 堆记账字节数（per-service memstat） */
    mem(): number;
    response(session: number, source: number, msg: string | ArrayBuffer | null): void;
    error_response(session: number, source: number): void;
    /** 转发消息并伪装 source（skynet.redirect 底层）；msg 原样透传 */
    redirect(dest: number, source: number, type: number, session: number,
        msg: string | ArrayBuffer | null): number;
    /** 打包为 lua-seri 兼容的 ArrayBuffer */
    pack(...vals: unknown[]): ArrayBuffer;
    /** 解包 seri 流；buf 亦接受字符串（按其 UTF-8 字节流解） */
    unpack(buf: ArrayBuffer | string): unknown[];
    /** ArrayBuffer 按 UTF-8 解码为字符串 */
    str(buf: ArrayBuffer): string;
    read_file(path: string): ArrayBuffer | null;
    write_file(path: string, data: ArrayBuffer): void;
    socket: {
        listen(host: string, port: number, backlog?: number): number;
        connect(host: string, port: number): number;
        start(id: number): void;
        send(id: number, data: string | ArrayBuffer): number;
        close(id: number): void;
        shutdown(id: number): void;
        /** 关闭 Nagle 算法（TCP_NODELAY） */
        nodelay(id: number): void;
        /** 切换本服务为 netpack 模式：DATA 走 C 帧缓冲（gateserver 使用） */
        netpack_mode(): void;
    };
    /** netpack 帧缓冲（2 字节大端长度前缀），gateserver 使用 */
    netpack: {
        /** 取出一个已重组的包，队列空返回 null */
        pop(): { fd: number; data: ArrayBuffer } | null;
        /** 为 data 加上 2 字节大端长度前缀 */
        pack(data: string | ArrayBuffer): ArrayBuffer;
        /** 清空队列与所有未完成重组缓冲 */
        clear(): void;
    };

    /**
     * C-layer crypto namespace (js-crypto.c, ArrayBuffer I/O).
     * 高层 JS 包装 globalThis.crypt 自动做 string→ArrayBuffer 转换；
     * 此处为底层 C 接口，参数必须为 ArrayBuffer。
     * OpenSSL-only 函数仅在 `make TLS=openssl` 构建时存在。
     */
    crypt: {
        // ---- Hash ----
        sha1(data: ArrayBuffer): ArrayBuffer;
        sha256(data: ArrayBuffer): ArrayBuffer;
        sha512(data: ArrayBuffer): ArrayBuffer;

        // ---- HMAC (standard) ----
        hmac_sha1(key: ArrayBuffer, data: ArrayBuffer): ArrayBuffer;
        hmac_sha256(key: ArrayBuffer, data: ArrayBuffer): ArrayBuffer;
        hmac_sha512(key: ArrayBuffer, data: ArrayBuffer): ArrayBuffer;

        // ---- Encoding ----
        base64_encode(data: ArrayBuffer): string;
        base64_decode(str: string): ArrayBuffer;
        hex_encode(data: ArrayBuffer): string;
        hex_decode(str: string): ArrayBuffer;

        // ---- Utility ----
        xor_str(data: ArrayBuffer, key: ArrayBuffer): ArrayBuffer;
        random_bytes(n: number): ArrayBuffer;

        // ---- Skynet protocol compat ----
        randomkey(): ArrayBuffer;
        hashkey(data: ArrayBuffer): ArrayBuffer;
        des_encode(key: ArrayBuffer, text: ArrayBuffer, padding?: number): ArrayBuffer;
        des_decode(key: ArrayBuffer, text: ArrayBuffer, padding?: number): ArrayBuffer;
        hmac64(x: ArrayBuffer, y: ArrayBuffer): ArrayBuffer;
        hmac64_md5(x: ArrayBuffer, y: ArrayBuffer): ArrayBuffer;
        hmac_hash(key: ArrayBuffer, text: ArrayBuffer): ArrayBuffer;
        dh_exchange(key: ArrayBuffer): ArrayBuffer;
        dh_secret(x: ArrayBuffer, y: ArrayBuffer): ArrayBuffer;

        // ---- OpenSSL-only (optional, make TLS=openssl) ----
        aes_gcm_encrypt?(key: ArrayBuffer, plaintext: ArrayBuffer, iv: ArrayBuffer,
            aad?: ArrayBuffer): { ciphertext: ArrayBuffer; tag: ArrayBuffer; iv: ArrayBuffer };
        aes_gcm_decrypt?(key: ArrayBuffer, ciphertext: ArrayBuffer, iv: ArrayBuffer,
            tag: ArrayBuffer, aad?: ArrayBuffer): ArrayBuffer;
        ed25519_keypair?(): { public_key: ArrayBuffer; secret_key: ArrayBuffer };
        ed25519_sign?(secret_key: ArrayBuffer, message: ArrayBuffer): ArrayBuffer;
        ed25519_verify?(public_key: ArrayBuffer, message: ArrayBuffer,
            sig: ArrayBuffer): boolean;
        x25519_keypair?(): { public_key: ArrayBuffer; secret_key: ArrayBuffer };
        x25519_shared?(secret_key: ArrayBuffer, peer_public: ArrayBuffer): ArrayBuffer;
    };

    // skynetcore.tls: TLS C-layer 尚未实现（无 js-tls.c）。
    // 待 Task #9 完成 TLS 支持后在此补充声明。
};

declare const skynet: {
    PTYPE_TEXT: number;
    PTYPE_RESPONSE: number;
    PTYPE_ERROR: number;
    PTYPE_LUA: number;
    PTYPE_CLIENT: number;
    start(start_func: () => void): void;
    /** 注册消息处理；回调返回值即应答（text 返回 string，lua 返回 pack 的 ArrayBuffer） */
    dispatch<T = unknown>(typename: string,
        fn: (msg: T, source?: number, session?: number) => unknown): void;
    register_protocol(p: { name: string; id: number; dispatch?: unknown }): void;
    /** call 返回 Promise；lua 协议应答为 ArrayBuffer（自行 unpack），text 解码为字符串 */
    call<T = unknown>(dest: number, typename: string,
        msg?: string | ArrayBuffer | null): Promise<T>;
    /** fire-and-forget 发送（无 session）；lua 协议 pack 多参，text 发单个字符串 */
    send(addr: number, typename: string, ...args: unknown[]): number;
    /** 转发消息并伪装 source（gate 用于把原始 client 帧转给 agent） */
    redirect(dest: number, source: number, typename: string, session: number,
        msg?: string | ArrayBuffer | null): number;
    /** 定时器，单位厘秒（10ms），同原版 skynet.timeout */
    timeout(centiseconds: number, fn: () => void): number;
    /** 毫秒休眠（内部已换算为厘秒） */
    sleep(ms: number): Promise<void>;
    fork<T>(fn: () => T | Promise<T>): Promise<T>;
    /** 创建服务；param 作为服务参数（snjs_param，脚本 eval 完成后才注入） */
    newservice(name: string, param?: string): number;
    self(): number;
    register(name: string): void;
    now(): number;
    mem_stat(): number;
    pack(...vals: unknown[]): ArrayBuffer;
    unpack(buf: ArrayBuffer | string): unknown[];
    exit(): void;
};

declare const socket: {
    listen(host: string, port: number, on_accept: (id: number, address: string) => void,
        backlog?: number): number;
    /**
     * Initiate a TCP connection.
     * NOTE: Only on_connect is registered at this stage. You MUST call
     * socket.start(id, on_data, on_close, on_error) after connect resolves
     * to receive error/close notifications. If the connection fails before
     * start() is called, the error is silently dropped.
     */
    connect(host: string, port: number, on_connect?: (id: number) => void): number;
    /** 注册数据回调；不 resume socket（resume 用 resume()）。opts.binary 时
     *  on_data 收到原始 ArrayBuffer，否则解码为 UTF-8 字符串 */
    start(id: number, on_data: (data: string | ArrayBuffer, size: number) => void,
        on_close?: (id: number) => void, on_error?: (id: number, msg: string) => void,
        opts?: { binary?: boolean }): void;
    resume(id: number): void;
    write(id: number, data: string | ArrayBuffer | ArrayBufferView): number;
    close(id: number): void;
    shutdown(id: number): void;
};

declare const gateserver: {
    /** 启动 gate：切换 netpack 模式并安装 socket 事件处理 */
    start(handler: {
        connect(fd: number, addr: string): void;
        message(fd: number, msg: ArrayBuffer): void;
        disconnect?(fd: number): void;
        error?(fd: number, msg: string): void;
        warning?(fd: number, size: number): void;
    }): void;
    /** 创建并启动监听 socket，返回 listen fd */
    open(host: string, port: number, backlog?: number, max_client?: number,
        nodelay?: boolean): number;
    close(): void;
    /** 开始读取一个已接受的连接（forward/accept 之后） */
    openclient(fd: number): void;
    closeclient(fd: number): void;
};

declare const cluster: {
    init(): void;
    set_nodes(nodes: Record<string, string>): void;
    open(port: number): void;
    register(name: string): void;
    /** 跨节点调用；按需 connect（失败立即 reject，同官方语义） */
    call(node: string, addr: string | number, ...vals: unknown[]): Promise<unknown[]>;
    send(node: string, addr: string | number, ...vals: unknown[]): void;
    query(node: string, name: string): Promise<unknown>;
};

// --------------- crypt (js/crypt.js) ---------------

declare const crypt: {
    /** DES 填充模式常量 */
    readonly padding: { readonly iso7816_4: 0; readonly pkcs7: 1 };

    // ---- Hash ----
    /** SHA-1 摘要，返回 20 字节 */
    sha1(data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    /** SHA-256 摘要，返回 32 字节 */
    sha256(data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    /** SHA-512 摘要，返回 64 字节 */
    sha512(data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;

    // ---- HMAC (standard) ----
    hmac_sha1(key: string | ArrayBuffer | ArrayBufferView,
        data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    hmac_sha256(key: string | ArrayBuffer | ArrayBufferView,
        data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    hmac_sha512(key: string | ArrayBuffer | ArrayBufferView,
        data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;

    // ---- Encoding ----
    /** Base64 编码，返回字符串 */
    base64_encode(data: string | ArrayBuffer | ArrayBufferView): string;
    /** Base64 解码，返回 ArrayBuffer */
    base64_decode(str: string): ArrayBuffer;
    /** 十六进制编码（小写），返回字符串 */
    hex_encode(data: string | ArrayBuffer | ArrayBufferView): string;
    /** 十六进制解码，返回 ArrayBuffer */
    hex_decode(str: string): ArrayBuffer;

    // ---- AEAD (OpenSSL, Phase 7) ----
    /** AES-256-GCM 加密；无 OpenSSL 时抛出错误 */
    aes_gcm_encrypt(key: ArrayBuffer, plaintext: ArrayBuffer, iv: ArrayBuffer,
        aad?: ArrayBuffer): { ciphertext: ArrayBuffer; tag: ArrayBuffer; iv: ArrayBuffer };
    /** AES-256-GCM 解密；无 OpenSSL 时抛出错误 */
    aes_gcm_decrypt(key: ArrayBuffer, ciphertext: ArrayBuffer, iv: ArrayBuffer,
        tag: ArrayBuffer, aad?: ArrayBuffer): ArrayBuffer;

    // ---- Ed25519 (OpenSSL, Phase 7) ----
    ed25519_keypair(): { public_key: ArrayBuffer; secret_key: ArrayBuffer };
    ed25519_sign(secret_key: ArrayBuffer, message: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    ed25519_verify(public_key: ArrayBuffer, message: string | ArrayBuffer | ArrayBufferView,
        sig: ArrayBuffer): boolean;

    // ---- X25519 (OpenSSL, Phase 7) ----
    x25519_keypair(): { public_key: ArrayBuffer; secret_key: ArrayBuffer };
    x25519_shared(secret_key: ArrayBuffer, peer_public: ArrayBuffer): ArrayBuffer;

    // ---- Utility ----
    /** 生成 n 字节密码学安全随机数 */
    random_bytes(n: number): ArrayBuffer;
    /**
     * XOR data with key. WARNING: This modifies `data` in-place and returns
     * the same ArrayBuffer. If you need the original data, copy it first.
     */
    xor_str(data: string | ArrayBuffer | ArrayBufferView,
        key: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;

    // ---- Skynet protocol compat ----
    /** 8 字节随机密钥（非零异或校验） */
    randomkey(): ArrayBuffer;
    /** DJB+JS 双 hash，返回 8 字节 */
    hashkey(data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    /** DES 加密；padding 默认 iso7816_4(0)，可选 pkcs7(1) */
    des_encode(key: ArrayBuffer, text: string | ArrayBuffer | ArrayBufferView,
        padding?: number): ArrayBuffer;
    /** DES 解密 */
    des_decode(key: ArrayBuffer, text: ArrayBuffer,
        padding?: number): ArrayBuffer;
    /** skynet hmac64（MD5-based，8 字节输入输出） */
    hmac64(x: ArrayBuffer, y: ArrayBuffer): ArrayBuffer;
    /** skynet hmac64_md5（8 字节输入输出） */
    hmac64_md5(x: ArrayBuffer, y: ArrayBuffer): ArrayBuffer;
    /** hashkey(text) 后与 key 做 hmac64 */
    hmac_hash(key: ArrayBuffer, text: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    /** DH 密钥交换：g^key mod p，返回 8 字节 */
    dh_exchange(key: ArrayBuffer): ArrayBuffer;
    /** DH 共享密钥：x^y mod p，返回 8 字节 */
    dh_secret(x: ArrayBuffer, y: ArrayBuffer): ArrayBuffer;
};

// --------------- sockethelper (js/sockethelper.js) ---------------

/** BufferedReader: 将回调式 socket 数据到达转为 Promise 式精确长度读取 */
declare class BufferedReader {
    readonly fd: number;
    closed: boolean;
    error_msg: string | null;

    constructor(fd: number);

    /** 读取恰好 n 字节 */
    read(n: number): Promise<ArrayBuffer>;
    /** 读取直到 CRLF（\r\n），返回不含 CRLF 的 UTF-8 字符串 */
    readline(): Promise<string>;
    /** 写入数据（默认调用 socket.write，TLS 升级后替换为加密写入） */
    write(data: string | ArrayBuffer | ArrayBufferView): void;
}

declare const sockethelper: {
    /** 哨兵对象，=== 比较区分 socket 错误和逻辑错误 */
    readonly socket_error: object;
    /** BufferedReader 构造器 */
    BufferedReader: typeof BufferedReader;
    /** 带超时的 TCP 连接；timeout 单位厘秒（10ms），省略则无超时 */
    connect(host: string, port: number, timeout?: number): Promise<number>;
    /** 返回写闭包：调用 socket.write，失败时 throw socket_error */
    writefunc(fd: number): (data: string | ArrayBuffer | ArrayBufferView) => void;
    /** 便捷方法：为 fd 创建 BufferedReader 并注册 binary 回调 + resume */
    reader(fd: number): BufferedReader;
};

// console（log/info/debug/warn/error/trace/time/timeLog/timeEnd，全部映射
// skynet 日志通道）由 JS 标准库类型覆盖，不在此重复声明。

// --------------- httpd (js/http.js) ---------------

/** HTTP 请求读取结果 */
interface HttpdReadResult {
    /** 200 表示成功，其他为 HTTP 错误码（400/413/501/505） */
    code: number;
    url?: string;
    method?: string;
    header?: Record<string, string | string[]>;
    body?: string;
}

declare const httpd: {
    /** 从 BufferedReader 读取并解析 HTTP 请求 */
    read_request(reader: BufferedReader, bodylimit?: number): Promise<HttpdReadResult>;
    /**
     * 写出 HTTP 响应。
     *   write_fn: 写函数（同 sockethelper.writefunc 返回值）
     *   statuscode: HTTP 状态码
     *   body: string（完整体）| function（chunked 生成器，返回 null 结束）| null（仅头）
     *   header: 响应头对象（值为数组时写多个同名头）
     * 返回 true 成功，false 写入失败
     */
    write_response(
        write_fn: (data: string | ArrayBuffer | ArrayBufferView) => void,
        statuscode: number,
        body: string | (() => string | null) | null,
        header?: Record<string, string | string[]>
    ): boolean;
};

// --------------- httpc (js/http.js) ---------------

interface HttpcResponse {
    status: number;
    body: string;
    header: Record<string, string | string[]>;
}

interface HttpcUrlParsed {
    protocol: string;
    host: string;
    port: number;
    path: string;
}

/** HTTP 客户端流式响应 */
interface HttpcStream {
    status: number;
    header: Record<string, string | string[]>;
    connected: boolean;
    /** 读取下一块数据，返回 null 表示结束 */
    read(): Promise<string | null>;
    /** 关闭流并释放连接 */
    close(): void;
}

declare const httpc: {
    /** 全局超时（centiseconds，10ms 单位），null 表示无超时 */
    timeout: number | null;

    /** 完整 HTTP 请求，支持连接池复用 */
    request(
        method: string,
        hostname: string,
        url: string,
        recv_header_out?: Record<string, string | string[]>,
        header?: Record<string, string | string[]>,
        content?: string
    ): Promise<HttpcResponse>;

    /** HTTP GET 简写 */
    get(
        hostname: string,
        url: string,
        recv_header_out?: Record<string, string | string[]>,
        header?: Record<string, string | string[]>
    ): Promise<{ status: number; body: string }>;

    /** HTTP POST（表单编码） */
    post(
        hostname: string,
        url: string,
        form: Record<string, string>,
        recv_header_out?: Record<string, string | string[]>
    ): Promise<{ status: number; body: string }>;

    /** HTTP HEAD，仅返回状态码 */
    head(
        hostname: string,
        url: string,
        recv_header_out?: Record<string, string | string[]>,
        header?: Record<string, string | string[]>
    ): Promise<number>;

    /** 流式 HTTP 请求 */
    request_stream(
        method: string,
        hostname: string,
        url: string,
        recv_header_out?: Record<string, string | string[]>,
        header?: Record<string, string | string[]>,
        content?: string
    ): Promise<HttpcStream>;

    /** URL 编码：保留 A-Za-z0-9_-.~（RFC 3986 unreserved），其余 → %XX */
    escape(str: string): string;
    /** URL 路径解析：按 ? 分割，解码 path */
    url_parse(url: string): { path: string; query: string };
    /** URL 查询字符串解析：k=v&k2=v2，重复键合并为数组 */
    url_parse_query(q: string): Record<string, string | string[]>;
    /** 完整 URL 解析：protocol://host:port/path */
    parse_url(url: string): HttpcUrlParsed;
    /** 关闭所有 Keep-Alive 连接 */
    close_all_keepalive(): void;
};

// --------------- http_internal (js/http.js) ---------------
// 内部解析函数，供 websocket.js 复用 HTTP 升级握手的头解析。

declare const http_internal: {
    /** 从 reader 读取 HTTP 头行直到空行 */
    recv_header(reader: BufferedReader): Promise<{ lines: string[]; ok: boolean }>;
    /** 解析 "Name: Value" 头行，名称小写化，支持行折叠与重复头 */
    parse_header(
        lines: string[],
        from: number,
        header?: Record<string, string | string[]>
    ): Record<string, string | string[]> | null;
    /** 读取 chunked 编码体 */
    recv_chunked_body(
        reader: BufferedReader,
        bodylimit: number | null,
        header: Record<string, string | string[]>
    ): Promise<{ body: string; header: Record<string, string | string[]> } | null>;
    /** 根据 content-length/状态码读取响应体 */
    recv_body(
        reader: BufferedReader,
        code: number,
        header: Record<string, string | string[]>
    ): Promise<string>;
    /** HTTP 状态码 → 原因短语表 */
    readonly http_status_msg: Record<number, string>;
};

// --------------- websocket (js/websocket.js) ---------------

/** WebSocket handler 回调接口（服务端 accept handler 模式） */
interface WebSocketHandler {
    /** 连接建立（握手前） */
    connect?(id: number): void;
    /** 握手完成 */
    handshake?(id: number, header: Record<string, string | string[]>,
        url: string): void;
    /** 收到消息；msg 为 ArrayBuffer，msg_type 为 "text" | "binary" */
    message(id: number, msg: ArrayBuffer, msg_type: string): void;
    /** 收到 ping */
    ping?(id: number): void;
    /** 收到 pong */
    pong?(id: number): void;
    /** 连接关闭；code/reason 来自关闭帧（可选） */
    close?(id: number, code?: number, reason?: string): void;
    /** 连接错误 */
    error?(id: number, err: unknown): void;
    /** 写缓冲区警告 */
    warning?(id: number, size: number): void;
}

/** websocket.accept 的 options 参数 */
interface WebSocketAcceptOptions {
    /** 跳过 HTTP 解析（调用者已解析升级请求） */
    upgrade?: {
        header: Record<string, string | string[]>;
        method: string;
        url: string;
    };
    /** 复用已有的 BufferedReader（避免数据丢失） */
    reader?: BufferedReader;
}

/** websocket.read 返回的数据消息 */
interface WebSocketDataMessage {
    data: ArrayBuffer;
    type: "text" | "binary";
    close: false;
}

/** websocket.read 返回的关闭消息 */
interface WebSocketCloseMessage {
    data: null;
    close: true;
    code: number | undefined;
    reason: string;
}

declare const websocket: {
    /**
     * 服务端入口：接受 WebSocket 连接并进入消息循环。
     *   fd: 已接受的 TCP 连接
     *   handler: 回调接口
     *   protocol: "ws"（默认）| "wss"
     *   addr: 连接地址信息
     *   options: 升级选项（可选）
     */
    accept(
        fd: number,
        handler: WebSocketHandler,
        protocol?: string,
        addr?: string,
        options?: WebSocketAcceptOptions
    ): Promise<boolean>;

    /**
     * 客户端入口：连接到 WebSocket 服务器。
     *   url: "ws://host:port/path" 或 "wss://..."
     *   header: 额外请求头（可选）
     *   timeout: 连接超时，厘秒（可选）
     * 返回连接 id（fd）
     */
    connect(
        url: string,
        header?: Record<string, string>,
        timeout?: number
    ): Promise<number>;

    /**
     * 手动读取模式：读取一条完整消息（自动处理 ping/pong 和分片重组）。
     * 数据消息返回 { data, type, close: false }；
     * 关闭帧返回 { data: null, close: true, code, reason }。
     */
    read(id: number): Promise<WebSocketDataMessage | WebSocketCloseMessage>;

    /**
     * 发送 WebSocket 帧。
     *   fmt: "text"（默认）| "binary"
     *   data: string | ArrayBuffer
     * 客户端帧自动添加掩码（RFC 6455 §5.3）。
     */
    write(id: number, data: string | ArrayBuffer, fmt?: string): void;

    /** 发送 ping 帧 */
    ping(id: number): void;

    /** 发送关闭帧并关闭连接 */
    close(id: number, code?: number, reason?: string): void;

    /** 获取连接地址信息 */
    addrinfo(id: number): string;

    /** 获取 x-real-ip 头（反向代理） */
    real_ip(id: number): string;

    /** 检查连接是否已关闭 */
    is_close(id: number): boolean;
};
