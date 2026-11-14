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
RUN cargo build --release -p hdu-sniper-server \
    && mkdir -p /var/lib/hdu-sniper/data

FROM gcr.io/distroless/cc-debian12
ARG SOURCE_REVISION=unknown
LABEL com.hdu-library-sniper.source-revision=$SOURCE_REVISION
WORKDIR /app
COPY --from=rust /src/target/release/hdu-sniper-server /usr/local/bin/hdu-sniper-server
COPY --from=web /app/dist/web /app/dist/web
COPY --from=rust /var/lib/hdu-sniper /var/lib/hdu-sniper
ENV HDU_SNIPER_HOME=/var/lib/hdu-sniper \
    HDU_WEB_PORT=8000 \
    HDU_WEB_HOST=0.0.0.0 \
    TZ=Asia/Shanghai
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/hdu-sniper-server", "--healthcheck"]
CMD ["/usr/local/bin/hdu-sniper-server"]
