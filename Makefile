.PHONY: help install dev lint format test run web legacy-qt clean docker-build docker-web docker-run docker-scheduled docker-logs docker-stop docker-clean

# 默认目标：显示帮助
help:
	@echo "HDU Library Sniper - 开发命令"
	@echo ""
	@echo "安装与开发:"
	@echo "  make install     安装项目依赖"
	@echo "  make dev         安装开发工具"
	@echo ""
	@echo "代码质量:"
	@echo "  make lint        运行 ruff 检查代码"
	@echo "  make format      运行 ruff 格式化代码"
	@echo "  make test        运行测试套件"
	@echo ""
	@echo "运行:"
	@echo "  make run         启动 Flet 桌面应用"
	@echo "  make web         启动本地 Web UI"
	@echo "  make legacy-qt   启动旧 Qt 界面（迁移期）"
	@echo ""
	@echo "Docker 容器化:"
	@echo "  make docker-build      构建 Docker 镜像"
	@echo "  make docker-web        启动 Web UI"
	@echo "  make docker-run        立即执行一次"
	@echo "  make docker-scheduled  启动定时任务模式（后台）"
	@echo "  make docker-logs       查看容器日志"
	@echo "  make docker-stop       停止所有容器"
	@echo "  make docker-clean      清理容器和镜像"
	@echo ""
	@echo "清理:"
	@echo "  make clean       清理缓存文件"

# 安装项目依赖
install:
	uv sync

# 安装开发依赖
dev:
	uv sync --all-groups

# 代码检查
lint:
	uv run ruff check .

# 代码格式化
format:
	uv run ruff format .

# 运行测试
test:
	uv run pytest

# 启动应用
run:
	uv run python main.py

# 启动本地 Web UI
web:
	uv run python main.py --web

# 启动迁移期旧 Qt 界面
legacy-qt:
	uv run --extra legacy-qt python main.py --legacy-qt

# 清理缓存
clean:
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete 2>/dev/null || true

# ========== Docker 命令 ==========

# 构建 Docker 镜像
docker-build:
	docker build -t hdu-library-sniper:latest .

# 启动 Web UI
docker-web:
	@echo "启动 Web UI..."
	docker compose --profile web up -d --build
	@echo "访问 http://localhost:$${HDU_WEB_PORT:-8000}"

# 立即执行一次
docker-run:
	@echo "立即执行一次..."
	docker compose --profile run run --rm hdu-sniper-run

# 启动定时任务模式（后台运行）
docker-scheduled:
	@echo "启动定时任务模式..."
	docker compose --profile scheduled up -d
	@echo "使用 'make docker-logs' 查看日志"

# 查看容器日志
docker-logs:
	@echo "查看容器日志（Ctrl+C 退出）..."
	docker compose logs -f

# 停止所有容器
docker-stop:
	@echo "停止所有容器..."
	docker compose --profile web --profile run --profile scheduled down

# 清理容器和镜像
docker-clean: docker-stop
	@echo "清理容器和镜像..."
	docker rmi hdu-library-sniper:latest || true
	docker system prune -f
