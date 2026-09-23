// TypeScript 接入示例：esbuild 剥离类型为纯 JS 后，由 snjs 以源码模式加载
// （用户脚本始终走源码 eval，见 docs/DEVELOPMENT.md「C/JS 边界」）。
// 构建：examples/ts-echo/build.sh；运行（CWD=仓库根）：
//   ./skyjs examples/ts-echo/config.json
// 全局注入面的类型声明在 js/skyjs.d.ts（运行时库同源维护）；
// 自有代码遵循仓库 JS 规范：camelCase（类型/接口名 PascalCase）、双引号、
// 4 空格缩进、const/let。

/// <reference path="../../js/skyjs.d.ts" />

// lua 协议 table 统一解为 LuaTable（`.array` 为 0-based 数组段，`.hash` 为 Map，
// `.get(k)` 镜像 Lua `t[k]`），见 DEVELOPMENT.md「seri → JS 映射」。
type LuaTableLike = LuaTable;

interface ProbeResult {
    textReply: string;
    luaPair: [string, number];
    tableN: number;
    tableArr1: number;
    jsMemBytes: number;
}

function tableGet(t: LuaTableLike, key: number | string): unknown {
    const v = t.get(key);
    if (v === undefined) throw new Error("field " + key + " missing");
    return v;
}

function expectNumber(t: LuaTableLike, key: number | string): number {
    const v = tableGet(t, key);
    if (typeof v !== "number") throw new Error("field " + key + " is not a number");
    return v;
}

async function runProbes(selfHandle: number): Promise<ProbeResult> {
    // 1) text 协议 self RTT：dispatch 返回值原样回包（应答解码为字符串）
    const textReply = await skynet.call<string>(selfHandle, "text", "ping");
    if (textReply !== "ts-echo:ping") {
        throw new Error("text roundtrip mismatch: " + textReply);
    }

    // 2) lua 协议 self RTT：pack 打包为 ArrayBuffer，应答体按 seri 流解包
    const echoAb = await skynet.call<ArrayBuffer>(selfHandle, "lua",
        skynet.pack("hello", 42));
    const vals = skynet.unpack(echoAb);
    const luaPair = [vals[0] as string, vals[1] as number] as [string, number];
    if (luaPair[0] !== "hello" || luaPair[1] !== 42) {
        throw new Error("lua roundtrip mismatch: " + vals.join(","));
    }

    // 3) 结构化 table 往返：JS 对象 pack 为 table hash 段，JS 数组 pack 为
    //    table 数组段；unpack 回来的顶层与内嵌表都是 LuaTable
    const structAb = await skynet.call<ArrayBuffer>(selfHandle, "lua",
        skynet.pack({ msg: "struct", n: 3, arr: [10, 20, 30] }));
    const structVals = skynet.unpack(structAb);
    const t = structVals[0] as LuaTableLike;
    const tableN = expectNumber(t, "n");
    // JS 数组位于子位置：pack 为子表的数组段，unpack 回子 LuaTable，
    // 用 .get(1) 取首元素（Lua 1-based）或 .array[0]（0-based）
    const arr = tableGet(t, "arr") as LuaTable;
    const tableArr1 = arr.get(1) as number;   // Lua 1-based
    if (tableN !== 3 || tableArr1 !== 10) {
        throw new Error("lua table roundtrip mismatch");
    }

    return {
        textReply,
        luaPair,
        tableN,
        tableArr1,
        jsMemBytes: skynet.memStat(),
    };
}

skynet.start(() => {
    skynet.dispatch<string>("text", (msg) => "ts-echo:" + msg);
    skynet.dispatch<ArrayBuffer>("lua", (buf) => skynet.pack(...skynet.unpack(buf)));
    (async () => {
        const r = await runProbes(skynet.self());
        console.log("TS_ECHO_OK", r.textReply, r.luaPair,
            "table_n=" + r.tableN, "table_arr1=" + r.tableArr1,
            "js_mem=" + r.jsMemBytes);
        skynet.exit();
    })().catch((e: unknown) => {
        console.error("TS_ECHO_FAIL", e instanceof Error ? e.message : e);
        skynet.exit();
    });
});
