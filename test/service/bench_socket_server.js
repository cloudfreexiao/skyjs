// run_bench.js phase-3 target (JS side): raw TCP echo on 127.0.0.1:2601.
// Bytes in -> bytes out; the load client (tools/bench_socket_client.js) is
// shared with the stock Lua node, so only the server framework differs.
// The socket bridge carries UTF-8 strings, so payloads are ASCII frames
// ('x'*size + '\n') -- identical bytes on both sides.
skynet.start(() => {
    skynet.dispatch("text", (msg) => "OK");
});

socket.listen("127.0.0.1", 2601, (conn_id) => {
    socket.start(conn_id, (data) => {
        socket.write(conn_id, data);
    }, (id) => {
        // peer closed: release the socket so no half-open fd lingers
        socket.close(id);
    }, (id, err) => {
        skynetcore.error("BENCH_SOCKERR " + id + " " + err);
    });
    // accepted fds start in PAccept state: must resume to receive data
    socket.resume(conn_id);
});

skynetcore.error("BENCH_SOCKET_READY");
