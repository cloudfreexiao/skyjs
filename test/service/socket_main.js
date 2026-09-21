// Task 4 acceptance: JS TCP echo server + JS client, both in the same node.
// TCP is a byte stream, so the test uses one request/response round trip and
// verifies the echoed payload content, then closes both ends.
skynetcore.error("MAIN socket test starting");

skynet.start(() => {
    skynet.dispatch("text", (msg) => "SOCKET:" + msg);
});

const listen_id = socket.listen("127.0.0.1", 18765, (conn_id) => {
    skynetcore.error("SOCKTEST accept conn " + conn_id);
    socket.start(conn_id, (data) => {
        socket.write(conn_id, data.toUpperCase());
    }, (id) => {
        skynetcore.error("SOCKTEST conn " + id + " closed");
    });
    // accepted fds start in PAccept state: must resume to receive data
    socket.resume(conn_id);
});
skynetcore.error("SOCKTEST listen id=" + listen_id);

// client side (after the server has had a moment to bind)
skynet.timeout(10, () => {
    socket.connect("127.0.0.1", 18765, (id) => {
        skynetcore.error("SOCKTEST connected fd=" + id);
        socket.start(id, (data) => {
            skynetcore.error("SOCKTEST echo got: " + data);
            if (data === "HELLO-SKYJS") {
                socket.close(id);
                skynetcore.error("SOCKTEST ALL_ECHO_OK");
            }
        }, (id) => {
            skynetcore.error("SOCKTEST client closed " + id);
        }, (id, err) => {
            skynetcore.error("SOCKTEST client error " + id + " " + err);
        });
        socket.write(id, "hello-skyjs");
    });
});
