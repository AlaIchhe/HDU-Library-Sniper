# 🚀 HDU Library Sniper - Docker 部署清单

## 📋 部署前检查

### 1️⃣ 环境准备
- [ ] 已安装 Docker Engine 20.10+
- [ ] 已安装 Docker Compose V2+
- [ ] （可选）已安装 `make` 工具
- [ ] （GUI 模式）已安装 X11 服务器

### 2️⃣ 文件检查
- [ ] `Dockerfile` 存在
- [ ] `docker-compose.yml` 存在
- [ ] `docker-entrypoint.sh` 可执行
- [ ] `.dockerignore` 存在
- [ ] `.env.example` 存在

### 3️⃣ 配置准备
- [ ] 已准备学号和密码
- [ ] 已决定运行模式（GUI/Daemon/Scheduled）
- [ ] 已配置定时规则（如使用 Scheduled 模式）

## 🎯 快速部署（推荐）

### 方案 A: 定时任务模式（最常用）

```bash
# 1. 创建配置
cp .env.example .env
nano .env  # 编辑填入学号、密码、定时规则

# 2. 构建镜像
make docker-build

# 3. 启动定时任务（后台运行）
make docker-scheduled

# 4. 验证运行
make docker-logs
```

**验证步骤：**
```bash
# 检查容器状态
docker ps | grep hdu-sniper

# 查看日志
tail -f logs/booking.log

# 测试 cron 配置
docker exec hdu-sniper-scheduled crontab -l
```

### 方案 B: GUI 模式（本地测试）

```bash
# 1. 允许 X11 访问（Linux/macOS）
xhost +local:docker

# 2. 构建镜像
make docker-build

# 3. 启动 GUI
make docker-gui
```

### 方案 C: 守护模式（单次执行）

```bash
# 1. 配置凭据
mkdir -p data
cat > data/credentials.yaml << 'YAML'
student_id: "你的学号"
password: "你的密码"
YAML

# 2. 构建并运行
make docker-build
make docker-daemon
```

## 🔧 详细配置步骤

### 步骤 1: 克隆/获取代码
```bash
git clone <repository-url>
cd HDU-Library-Sniper
```

### 步骤 2: 配置凭据

**选项 A: 环境变量文件（推荐）**
```bash
cp .env.example .env

# 编辑 .env 文件
# HDU_STUDENT_ID=你的学号
# HDU_PASSWORD=你的密码
# SCHEDULE=0 20 * * *  # 每天 20:00
```

**选项 B: 凭据文件**
```bash
mkdir -p data
cat > data/credentials.yaml << EOF
student_id: "你的学号"
password: "你的密码"
