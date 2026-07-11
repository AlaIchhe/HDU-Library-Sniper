# Docker 容器化部署指南

本项目支持完整的 Docker 容器化部署，提供 GUI 模式、守护模式和定时任务模式。

## 📋 前置要求

- Docker Engine 20.10+
- Docker Compose V2+
- （GUI 模式）X11 显示服务器（Linux/macOS）或 X Server（Windows）

## 🚀 快速开始

### 1. 构建镜像

```bash
docker build -t hdu-library-sniper:latest .
```

### 2. 运行模式

#### 🖥️ GUI 模式（图形界面）

**Linux / macOS:**
```bash
# 允许 Docker 访问 X11
xhost +local:docker

# 启动 GUI 容器
docker-compose --profile gui up

# 或使用 docker run
docker run -it --rm \
  -e DISPLAY=$DISPLAY \
  -v /tmp/.X11-unix:/tmp/.X11-unix:rw \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  hdu-library-sniper:latest gui
```

**Windows (WSL2):**
```powershell
# 安装 VcXsrv 或 Xming X Server
# 配置 DISPLAY 环境变量
$env:DISPLAY = "host.docker.internal:0"

docker run -it --rm `
  -e DISPLAY=$env:DISPLAY `
  -v ${PWD}/data:/app/data `
  -v ${PWD}/logs:/app/logs `
  hdu-library-sniper:latest gui
```

#### 🤖 守护模式（单次执行）

```bash
# 使用 docker-compose
docker-compose --profile daemon up

# 或使用 docker run
docker run --rm \
  -e HDU_STUDENT_ID="你的学号" \
  -e HDU_PASSWORD="你的密码" \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  hdu-library-sniper:latest daemon
```

#### ⏰ 定时任务模式（自动定时执行）

```bash
# 每天 20:00 自动执行
docker-compose --profile scheduled up -d

# 自定义时间（例如每天 19:55）
SCHEDULE="55 19 * * *" docker-compose --profile scheduled up -d

# 查看日志
docker logs -f hdu-sniper-scheduled
```

#### ⚡ 立即执行一次

```bash
docker run --rm \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  hdu-library-sniper:latest run-now
```

## 🔧 配置方式

### 方式 1: 环境变量（推荐用于 CI/CD）

```bash
export HDU_STUDENT_ID="你的学号"
export HDU_PASSWORD="你的密码"

docker-compose --profile daemon up
```

### 方式 2: 凭据文件（推荐用于本地）

创建 `data/credentials.yaml`:
```yaml
student_id: "你的学号"
password: "你的密码"
```

```bash
docker run --rm \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  hdu-library-sniper:latest daemon
```

### 方式 3: .env 文件

复制环境变量模板：
```bash
cp .env.example .env
# 编辑 .env 文件填入你的凭据
```

```bash
docker-compose --env-file .env --profile scheduled up -d
```

## 📂 数据持久化

容器会挂载以下目录到主机：

```
./data/          # 凭据、预约方案、会话缓存
./logs/          # 运行日志
./config/        # 配置文件
```

## 🔒 安全建议

1. **不要将凭据提交到 Git**
   ```bash
   # 已在 .gitignore 中排除
   data/credentials.yaml
   .env
   ```

2. **限制容器权限**
   ```bash
   docker run --rm --read-only \
     --tmpfs /tmp \
     -v $(pwd)/data:/app/data \
     hdu-library-sniper:latest daemon
   ```

3. **使用 Docker Secrets**（生产环境）
   ```yaml
   services:
     hdu-sniper:
       secrets:
         - hdu_credentials
   
   secrets:
     hdu_credentials:
       file: ./secrets/credentials.yaml
   ```

## 🐛 故障排查

### GUI 无法显示

**问题：** `cannot open display: :0`

**解决：**
```bash
# Linux
xhost +local:docker
export DISPLAY=:0

# macOS (使用 XQuartz)
xhost + 127.0.0.1
export DISPLAY=host.docker.internal:0
```

### Playwright 浏览器错误

**问题：** `Executable doesn't exist`

**解决：**
```bash
# 重新构建镜像，确保安装浏览器
docker build --no-cache -t hdu-library-sniper:latest .
```

### 权限错误

**问题：** `Permission denied: 'data/credentials.yaml'`

**解决：**
```bash
# 修复文件权限
chmod 600 data/credentials.yaml
chmod 755 data logs
```

## 📊 监控与日志

### 实时日志

```bash
# 查看容器日志
docker logs -f hdu-sniper-daemon

# 查看应用日志
tail -f logs/booking.log

# 查看 cron 日志（定时任务模式）
docker exec hdu-sniper-scheduled tail -f /app/logs/cron.log
```

### 健康检查

```bash
# 检查容器状态
docker ps -a | grep hdu-sniper

# 进入容器调试
docker exec -it hdu-sniper-daemon /bin/bash
```

## 🔄 更新部署

```bash
# 重新构建镜像
docker-compose build

# 重启服务（保留数据）
docker-compose --profile scheduled down
docker-compose --profile scheduled up -d

# 查看日志确认
docker logs -f hdu-sniper-scheduled
```

## 🌐 高级用例

### 多实例部署（多账号）

```bash
# 账号 1
docker run -d --name sniper-account1 \
  -e HDU_STUDENT_ID="学号1" \
  -e HDU_PASSWORD="密码1" \
  -v ./data1:/app/data \
  hdu-library-sniper:latest scheduled

# 账号 2
docker run -d --name sniper-account2 \
  -e HDU_STUDENT_ID="学号2" \
  -e HDU_PASSWORD="密码2" \
  -v ./data2:/app/data \
  hdu-library-sniper:latest scheduled
```

### Docker Compose 生产配置

```yaml
version: '3.8'

services:
  hdu-sniper:
    image: hdu-library-sniper:latest
    container_name: hdu-sniper-prod
    restart: unless-stopped
    environment:
      - SCHEDULE=0 20 * * *
    volumes:
      - hdu-data:/app/data
      - hdu-logs:/app/logs
    secrets:
      - hdu_credentials
    command: scheduled
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  hdu-data:
  hdu-logs:

secrets:
  hdu_credentials:
    external: true
```

## 📝 常用命令速查

```bash
# 构建
docker build -t hdu-library-sniper:latest .

# GUI 模式
docker-compose --profile gui up

# 守护模式（后台）
docker-compose --profile daemon up -d

# 定时任务（后台）
docker-compose --profile scheduled up -d

# 查看日志
docker logs -f hdu-sniper-scheduled

# 停止所有
docker-compose down

# 清理
docker system prune -a
```

## 🎯 Makefile 快捷命令

项目提供了 Makefile 快捷命令：

```bash
make docker-build          # 构建 Docker 镜像
make docker-gui            # 启动 GUI 模式
make docker-daemon         # 启动守护模式
make docker-scheduled      # 启动定时任务模式
make docker-logs           # 查看日志
make docker-stop           # 停止所有容器
make docker-clean          # 清理容器和镜像
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可

MIT License
