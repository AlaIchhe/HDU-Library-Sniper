FROM docker.io/oven/bun:1.4.0-alpine
WORKDIR /app
COPY package.json bun.lock tsconfig.json vite.config.ts vitest.config.ts playwright.config.ts orval.config.ts openapi.yaml index.html ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY public ./public
RUN bun run build
ENV NODE_ENV=production \
    HDU_SNIPER_HOME=/var/lib/hdu-sniper \
    HDU_WEB_PORT=8000 \
    TZ=Asia/Shanghai
RUN mkdir -p /var/lib/hdu-sniper/data
EXPOSE 8000
CMD ["bun", "run", "src/server/index.ts"]
