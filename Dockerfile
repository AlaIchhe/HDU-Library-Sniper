# 多阶段构建：基础镜像
FROM python:3.11-slim AS base

# 设置环境变量
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# 安装系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    # 基础工具
    curl \
    ca-certificates \
    cron \
    # PySide6 GUI 依赖
    libgl1-mesa-glx \
    libglib2.0-0 \
    libdbus-1-3 \
    libxkbcommon-x11-0 \
    libxcb-icccm4 \
    libxcb-image0 \
    libxcb-keysyms1 \
    libxcb-randr0 \
    libxcb-render-util0 \
    libxcb-shape0 \
    libxcb-xinerama0 \
    libxcb-xfixes0 \
    libxcb-cursor0 \
    libegl1 \
    libfontconfig1 \
    # Playwright 浏览器依赖
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

# 安装 uv（快速 Python 包管理器）
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# 设置工作目录
WORKDIR /app

# 复制项目文件
COPY pyproject.toml uv.lock ./
COPY main.py ./
COPY src ./src

# 安装 Python 依赖
RUN uv sync --frozen --no-dev

# 安装 Playwright 浏览器（仅 Chromium，减小镜像体积）
RUN uv run playwright install --with-deps chromium

# 创建容器运行目录
RUN mkdir -p /var/lib/hdu-sniper/config \
    /var/lib/hdu-sniper/data \
    /var/lib/hdu-sniper/state/logs

# 暴露环境变量配置
ENV HDU_SNIPER_HOME=/var/lib/hdu-sniper \
    HDU_STUDENT_ID="" \
    HDU_PASSWORD="" \
    DISPLAY=:0

# 入口点脚本
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["gui"]
