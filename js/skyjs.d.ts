// js/skyjs.d.ts -- SkyJS 运行时全局注入面的 TypeScript 类型声明，与 js/ 下
// 三个运行时库同源维护（skynet.js / socket.js / cluster.js 的注入对象 +
// service-src/snjs.c 注入的 skynetcore）。TypeScript 服务经 `/// <reference
// path="..." />` 引用（见 examples/ts_echo/ts_echo.ts）；esbuild 只剥离类型
// 不做检查，如需强检查可另跑 `tsc --noEmit`。API 面以 js/*.js 与 snjs.c 的
// 实际注入为准（docs/DEVELOPMENT.md「C/JS 边界」），改动注入面时同步更新。

// 启动参数由 snjs 在用户脚本 eval 完成后注入；同步启动阶段不可读取，详见
// DEVELOPMENT.md「排查问题的入口」。
declare const snjs_param: string;

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

// console（log/info/debug/warn/error/trace/time/timeLog/timeEnd，全部映射
// skynet 日志通道）由 JS 标准库类型覆盖，不在此重复声明。
