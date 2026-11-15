# Build the React frontend once; no Bun runtime is shipped.
FROM docker.io/oven/bun:1.4.0-alpine AS web
WORKDIR /app
COPY package.json bun.lock tsconfig.json vite.config.ts index.html ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY public ./public
RUN bun run build:web

# Build the pure-Go HTTP server (CGO_ENABLED=0). Same backend core as the MyGo desktop app.
FROM docker.io/library/golang:1.27-bookworm AS go
ARG TARGETOS=linux
ARG TARGETARCH=amd64
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/hdu-sniper-server ./cmd/server \
    && mkdir -p /var/lib/hdu-sniper/data

FROM gcr.io/distroless/static-debian12
ARG SOURCE_REVISION=unknown
LABEL com.hdu-library-sniper.source-revision=$SOURCE_REVISION
WORKDIR /app
COPY --from=go /out/hdu-sniper-server /usr/local/bin/hdu-sniper-server
COPY --from=web /app/dist/web /app/dist/web
COPY --from=go /var/lib/hdu-sniper /var/lib/hdu-sniper
ENV HDU_SNIPER_HOME=/var/lib/hdu-sniper \
    HDU_STATIC_DIR=/app/dist/web \
    HDU_WEB_PORT=8000 \
    HDU_WEB_HOST=0.0.0.0 \
    TZ=Asia/Shanghai
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/hdu-sniper-server", "--healthcheck"]
CMD ["/usr/local/bin/hdu-sniper-server"]
