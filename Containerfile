# Build the React frontend once; no Bun runtime is shipped.
FROM docker.io/oven/bun:1.4.0-alpine AS web
WORKDIR /app
COPY package.json bun.lock tsconfig.json vite.config.ts vitest.config.ts playwright.config.ts index.html ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY public ./public
RUN bun run build

# Build the Rust HTTP server. The container gets the same binary as the desktop core.
FROM docker.io/rust:1.99-bookworm AS rust
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY src-tauri ./src-tauri
RUN cargo build --release -p hdu-sniper-server

FROM docker.io/library/debian:bookworm-slim
ARG SOURCE_REVISION=unknown
LABEL com.hdu-library-sniper.source-revision=$SOURCE_REVISION
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=rust /src/target/release/hdu-sniper-server /usr/local/bin/hdu-sniper-server
COPY --from=web /app/dist/web /app/dist/web
ENV HDU_SNIPER_HOME=/var/lib/hdu-sniper \
    HDU_WEB_PORT=8000 \
    HDU_WEB_HOST=0.0.0.0 \
    TZ=Asia/Shanghai
RUN mkdir -p /var/lib/hdu-sniper/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/api/health || exit 1
CMD ["hdu-sniper-server"]
