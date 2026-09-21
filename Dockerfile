FROM debian:bookworm

# Switch to Alibaba Cloud mirror for faster downloads in China
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    elif [ -f /etc/apt/sources.list ]; then \
        sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        gcc libc6-dev make git autoconf nodejs procps && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
