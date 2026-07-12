#!/bin/bash
set -e

# HDU Library Sniper - Docker 入口点脚本

# 只创建可写运行目录；凭据始终由应用直接读取，不写入持久化卷。
mkdir -p "$HDU_SNIPER_HOME/data" "$HDU_SNIPER_HOME/state/logs"

# 根据命令参数执行不同模式
case "$1" in
    gui)
        echo "启动 GUI 模式..."
        # 检查 DISPLAY 环境变量
        if [ -z "$DISPLAY" ]; then
            echo "警告：未设置 DISPLAY 环境变量，GUI 可能无法显示"
            echo "请使用: docker run -e DISPLAY=\$DISPLAY -v /tmp/.X11-unix:/tmp/.X11-unix ..."
        fi
        exec uv run python main.py
        ;;

    daemon)
        echo "启动守护模式（单次执行）..."
        exec uv run python main.py --daemon
        ;;

    scheduled)
        echo "启动定时任务模式..."
        # 默认每天 20:00 执行（如果未提供 SCHEDULE）
        SCHEDULE="${SCHEDULE:-0 20 * * *}"
        echo "定时规则: $SCHEDULE"

        # cron 不继承容器启动环境；仅将必要变量写入 /run 临时文件。
        env_file=/run/hdu-sniper.env
        : > "$env_file"
        for name in HDU_SNIPER_HOME HDU_STUDENT_ID HDU_PASSWORD HDU_STUDENT_ID_FILE HDU_PASSWORD_FILE HDU_WECHAT_WEBHOOK; do
            if [ -n "${!name:-}" ]; then
                printf 'export %s=%q\n' "$name" "${!name}" >> "$env_file"
            fi
        done
        chmod 600 "$env_file"

        # 创建 crontab 条目
        {
            echo "SHELL=/bin/bash"
            echo "PATH=/usr/local/bin:/usr/bin:/bin"
            echo "$SCHEDULE . $env_file; cd /app && uv run python main.py --daemon >> $HDU_SNIPER_HOME/state/logs/task.log 2>&1"
        } | crontab -

        # 启动 cron（前台运行）
        echo "Cron 任务已配置，启动 cron 守护进程..."
        cron -f
        ;;

    run-now)
        echo "立即执行一次抢座..."
        exec uv run python main.py --run-now
        ;;

    shell)
        echo "启动交互式 Shell..."
        exec /bin/bash
        ;;

    *)
        echo "使用方式:"
        echo "  docker run ... hdu-library-sniper gui          # 启动 GUI 界面"
        echo "  docker run ... hdu-library-sniper daemon       # 执行一次抢座（守护模式）"
        echo "  docker run ... hdu-library-sniper scheduled    # 定时执行抢座"
        echo "  docker run ... hdu-library-sniper run-now      # 立即执行一次"
        echo "  docker run ... hdu-library-sniper shell        # 进入容器 Shell"
        exit 1
        ;;
esac
