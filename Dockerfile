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
CMD ["bun", "run", "src/server/index.ts"]
