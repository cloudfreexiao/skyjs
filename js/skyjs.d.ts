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
        send(id: number, data: string): number;
        close(id: number): void;
        shutdown(id: number): void;
    };
};

declare const skynet: {
    PTYPE_TEXT: number;
    PTYPE_RESPONSE: number;
    PTYPE_ERROR: number;
    PTYPE_LUA: number;
    start(start_func: () => void): void;
    /** 注册消息处理；回调返回值即应答（text 返回 string，lua 返回 pack 的 ArrayBuffer） */
    dispatch<T = unknown>(typename: string,
        fn: (msg: T, session?: number, source?: number) => unknown): void;
    register_protocol(p: { name: string; id: number; dispatch?: unknown }): void;
    /** call 返回 Promise；lua 协议应答为 ArrayBuffer（自行 unpack），text 解码为字符串 */
    call<T = unknown>(dest: number, typename: string,
        msg?: string | ArrayBuffer | null): Promise<T>;
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
    /** 注册数据回调；不 resume socket（resume 用 resume()） */
    start(id: number, on_data: (data: string, size: number) => void,
        on_close?: (id: number) => void, on_error?: (id: number, msg: string) => void): void;
    resume(id: number): void;
    write(id: number, data: string): number;
    close(id: number): void;
    shutdown(id: number): void;
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
