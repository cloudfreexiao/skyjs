-- Cluster node map for the run_bench.js phase-2 pairs. Consumed by the
-- stock Lua node booted from the 3rd/skynet submodule (CWD = 3rd/skynet;
-- relative paths resolve from there). Both lua bench nodes share this file;
-- the skyjs side passes its node table explicitly via cluster.set_nodes.
a = "127.0.0.1:2528"
b = "127.0.0.1:2529"
