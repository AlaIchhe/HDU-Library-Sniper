# HDU-Library-Sniper Docker 镜像
# 用 scheduler.py 作为 PID 1 前台常驻,Docker --restart 策略负责生存,
# 无需 cron / tmux / .bashrc / setsid。
#
# 构建:docker build -t libsniper .
# 运行:docker run -d --name libsniper --restart unless-stopped \
#        -v "$PWD/data:/app/data" -v "$PWD/logs:/app/logs" \
#        -e SNIPER_DAILY_AT=19:59:59 libsniper
#
# 镜像选择:python:3.11-slim(Debian,有 bash)最稳;若要更小可用 python:3.11-alpine。
# scheduler.py 只依赖 Python 标准库 + 项目 requirements,不依赖 bash/GNU date。

FROM python:3.11-slim

WORKDIR /app

# 依赖单独一层,利用构建缓存
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝项目(.dockerignore 已排除 data/ logs/ .git 等)
COPY . .

# 时区与触发时刻(可在 docker run -e 覆盖)
ENV TZ=Asia/Shanghai
ENV SNIPER_DAILY_AT=19:59:59
ENV PYTHONUNBUFFERED=1

# scheduler.py 作为容器 PID 1,前台运行
CMD ["python", "scripts/scheduler.py"]
