// TypeScript 接入示例：esbuild 剥离类型为纯 JS 后，由 snjs 以源码模式加载
// （用户脚本始终走源码 eval，见 docs/DEVELOPMENT.md「C/JS 边界」）。
// 构建：examples/ts_echo/build.sh；运行（CWD=仓库根）：
//   ./skyjs examples/ts_echo/config.json
// 全局注入面的类型声明在 js/skyjs.d.ts（运行时库同源维护）；
// 自有代码遵循仓库 JS 规范：lower_snake_case（类型/接口名同规则）、双引号、
// 4 空格缩进、const/let。

/// <reference path="../../js/skyjs.d.ts" />

// lua 协议 table 在 JS 侧区分处理：纯数组部分（无 hash）解为 JS Array（0-based），
// 含 hash 部分的表解为 Map（数组键为 1..n），见 DEVELOPMENT.md「seri → JS 映射」。
type lua_table = Map<number | string, unknown>;

interface probe_result {
    text_reply: string;
    lua_pair: [string, number];
    table_n: number;
    table_arr1: number;
    js_mem_bytes: number;
}

function table_get(t: lua_table, key: number | string): unknown {
    const v = t.get(key);
    if (v === undefined) throw new Error("field " + key + " missing");
    return v;
}

function expect_number(t: lua_table, key: number | string): number {
    const v = table_get(t, key);
    if (typeof v !== "number") throw new Error("field " + key + " is not a number");
    return v;
}

async function run_probes(self_handle: number): Promise<probe_result> {
    // 1) text 协议 self RTT：dispatch 返回值原样回包（应答解码为字符串）
    const text_reply = await skynet.call<string>(self_handle, "text", "ping");
    if (text_reply !== "ts_echo:ping") {
        throw new Error("text roundtrip mismatch: " + text_reply);
    }

    // 2) lua 协议 self RTT：pack 打包为 ArrayBuffer，应答体按 seri 流解包
    const echo_ab = await skynet.call<ArrayBuffer>(self_handle, "lua",
        skynet.pack("hello", 42));
    const vals = skynet.unpack(echo_ab);
    const lua_pair = [vals[0] as string, vals[1] as number] as [string, number];
    if (lua_pair[0] !== "hello" || lua_pair[1] !== 42) {
        throw new Error("lua roundtrip mismatch: " + vals.join(","));
    }

    // 3) 结构化 table 往返：JS 对象 pack 为 table hash 部分，JS 数组 pack 为
    //    table 数组部分；unpack 回来的顶层对象是 Map（含 hash 键），内嵌数组部分
    //    是 JS Array（0-based）
    const struct_ab = await skynet.call<ArrayBuffer>(self_handle, "lua",
        skynet.pack({ msg: "struct", n: 3, arr: [10, 20, 30] }));
    const struct_vals = skynet.unpack(struct_ab);
    const t = struct_vals[0] as lua_table;
    const table_n = expect_number(t, "n");
    // JS Array 位于子位置：pack 为子 table 的数组部分，unpack 回子 Array（0-based）
    const arr = table_get(t, "arr") as number[];
    const table_arr1 = arr[0] as number;   // 0-based
    if (table_n !== 3 || table_arr1 !== 10) {
        throw new Error("lua table roundtrip mismatch");
    }

    return {
        text_reply,
        lua_pair,
        table_n,
        table_arr1,
        js_mem_bytes: skynet.mem_stat(),
    };
}

skynet.start(() => {
    skynet.dispatch<string>("text", (msg) => "ts_echo:" + msg);
    skynet.dispatch<ArrayBuffer>("lua", (buf) => skynet.pack(...skynet.unpack(buf)));
    (async () => {
        const r = await run_probes(skynet.self());
        console.log("TS_ECHO_OK", r.text_reply, r.lua_pair,
            "table_n=" + r.table_n, "table_arr1=" + r.table_arr1,
            "js_mem=" + r.js_mem_bytes);
        skynet.exit();
    })().catch((e: unknown) => {
        console.error("TS_ECHO_FAIL", e instanceof Error ? e.message : e);
        skynet.exit();
    });
});
