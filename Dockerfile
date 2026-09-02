FROM oven/bun:1.2-alpine
WORKDIR /app
COPY package.json tsconfig.json vite.config.ts index.html ./
RUN bun install --frozen-lockfile || bun install
COPY src ./src
COPY public ./public
ENV NODE_ENV=production \
    HDU_SNIPER_HOME=/var/lib/hdu-sniper \
    HDU_WEB_PORT=8000 \
    TZ=Asia/Shanghai
RUN mkdir -p /var/lib/hdu-sniper/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/api/health || exit 1
CMD ["bun", "run", "src/server/index.ts"]
