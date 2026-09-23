#!/bin/bash
# Docker Linux (Debian/arm64) 压测一键脚本
# 用法: ./tools/docker-bench.sh [run-bench.js 参数]
# 示例:
#   ./tools/docker-bench.sh                    # 完整压测 (等价 make bench)
#   ./tools/docker-bench.sh --phase mem        # 只跑内存阶段
#   ./tools/docker-bench.sh --phase core --repeat 5

set -e
cd "$(dirname "$0")/.."

IMAGE_NAME="skyjs-bench"
BENCH_ARGS="${@:---phase all --repeat 3}"

# 构建镜像（有缓存时秒过）
echo "=== Building Docker image ==="
docker build --platform linux/arm64 -t "$IMAGE_NAME" .

# 运行压测
echo "=== Running Linux bench: $BENCH_ARGS ==="
docker run --rm --platform linux/arm64 \
    -v "$(pwd):/workspace" \
    "$IMAGE_NAME" \
    bash -c "make clean && make && node tools/run-bench.js $BENCH_ARGS"

# 恢复 macOS 构建
echo "=== Restoring macOS build ==="
make clean && make

echo "=== Done ==="
