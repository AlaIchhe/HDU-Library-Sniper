# Docker 快速开始指南

## 🚀 5 分钟上手

### 1️⃣ 构建镜像
```bash
make docker-build
```

### 2️⃣ 配置凭据
```bash
# 方式 A: 使用环境变量文件
cp .env.example .env
# 编辑 .env 填入学号和密码

# 方式 B: 直接创建凭据文件
mkdir -p data
cat > data/credentials.yaml << 'YAML'
student_id: "你的学号"
password: "你的密码"
YAML
```

### 3️⃣ 选择运行模式

#### 🖥️ GUI 模式（图形界面）
```bash
# Linux/macOS
xhost +local:docker
make docker-gui
```

#### 🤖 守护模式（单次执行）
```bash
make docker-daemon
```

#### ⏰ 定时任务（每天自动抢座）
```bash
# 默认每天 20:00 执行
make docker-scheduled

# 查看日志
make docker-logs
```

## 📚 完整文档

查看 [docs/DOCKER.md](docs/DOCKER.md) 获取详细文档。

## ⚡ 常用命令

```bash
make docker-build      # 构建镜像
make docker-scheduled  # 启动定时任务
make docker-logs       # 查看日志
make docker-stop       # 停止容器
make docker-clean      # 清理资源
```

## 🔧 自定义定时

编辑 `.env` 文件：
```bash
# 每天 19:55 执行
SCHEDULE=55 19 * * *

# 每天 20:00 和 21:00 执行
SCHEDULE=0 20,21 * * *
```

## 📊 查看日志

```bash
# 实时日志
docker logs -f hdu-sniper-scheduled

# 应用日志文件
tail -f logs/booking.log
```

## 🐛 常见问题

### GUI 无法显示
```bash
# Linux/macOS
xhost +local:docker
export DISPLAY=:0
```

### 权限错误
```bash
chmod 600 data/credentials.yaml
chmod 755 data logs
```

## 📞 获取帮助

- 查看所有命令: `make help`
- 完整文档: `docs/DOCKER.md`
- 提交 Issue: GitHub Issues
