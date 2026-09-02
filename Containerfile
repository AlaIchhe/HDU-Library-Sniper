FROM docker.io/oven/bun:1.4.0-alpine
WORKDIR /app
ARG SOURCE_REVISION=unknown
COPY package.json bun.lock tsconfig.json vite.config.ts vitest.config.ts playwright.config.ts orval.config.ts openapi.yaml index.html ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY public ./public
RUN bun run build
LABEL com.hdu-library-sniper.source-revision=$SOURCE_REVISION
ENV NODE_ENV=production \
    HDU_SNIPER_HOME=/var/lib/hdu-sniper \
    HDU_WEB_PORT=8000 \
    TZ=Asia/Shanghai
RUN mkdir -p /var/lib/hdu-sniper/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/api/health || exit 1
CMD ["bun", "run", "src/server/index.ts"]
