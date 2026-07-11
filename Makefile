.PHONY: help install dev lint format test run clean

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
	@echo "  make run         启动 GUI 应用"
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

# 清理缓存
clean:
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete 2>/dev/null || true
