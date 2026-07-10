#!/usr/bin/env bash
# loop_sniper.sh — 纯用户态常驻调度器(无 cron / 无 root 时的替代方案)
#
# 工作方式:后台进程常驻,每次 sleep 到下一个目标时刻(如 19:59:59)后
# 运行 main.py --run-now,跑完重新计算下一次,无限循环。
#
# 生存保证:
#   - 用 setsid + nohup 脱离控制终端,SSH 登出不被 SIGHUP 杀死
#   - 服务器重启后,~/.bashrc 中的守卫会在用户首次登录时自动重启本循环
#     (setup.sh --no-cron 已自动写入守卫)
#
# 用法(通常由 setup.sh 自动拉起,也可手动):
#   setsid bash scripts/loop_sniper.sh >> logs/loop.log 2>&1 < /dev/null & disown
#
# 自定义(环境变量):
#   SNIPER_DAILY_AT 触发时刻 HH:MM:SS 或 HH:MM(缺省 19:59:59)
#   CONDA_ENV       conda 环境名(缺省 base)
#   LOG_DIR         日志目录(缺省 <checkout>/logs)
#   TZ              时区(缺省 Asia/Shanghai)
set -euo pipefail

# ── 路径自推导(与 run_libsniper.sh 一致) ─────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

# 加载 setup.sh 冻结的配置(时刻 / conda env / 时区 / 日志目录),不存在则用缺省
ENV_FILE="$APP_DIR/.libsniper.env"
if [[ -f "$ENV_FILE" ]]; then
    set -a; . "$ENV_FILE"; set +a
fi

_detect_conda() {
    for c in "$APP_DIR/miniconda3" "$APP_DIR/miniconda" "$HOME/miniconda3" "$HOME/miniconda"; do
        [[ -x "$c/bin/conda" ]] && { echo "$c"; return 0; }
    done
    if command -v conda >/dev/null 2>&1; then
        conda info --base 2>/dev/null && return 0
    fi
    return 1
}

CONDA_ROOT="$(_detect_conda || true)"
if [[ -z "$CONDA_ROOT" ]]; then
    echo "[loop][FATAL] 找不到 miniconda/conda,先跑 scripts/setup.sh" >&2
    exit 127
fi
CONDA_ENV="${CONDA_ENV:-base}"
if [[ "$CONDA_ENV" == "base" ]]; then
    PYTHON_BIN="$CONDA_ROOT/bin/python"
else
    PYTHON_BIN="$CONDA_ROOT/envs/$CONDA_ENV/bin/python"
fi

[[ -f "$APP_DIR/main.py" ]] || { echo "[loop][FATAL] $APP_DIR/main.py 不存在" >&2; exit 127; }
"$PYTHON_BIN" -V >/dev/null 2>&1 || { echo "[loop][FATAL] 解释器不可执行: $PYTHON_BIN" >&2; exit 127; }

# ── 配置 ──────────────────────────────────────────────────
export TZ="${TZ:-Asia/Shanghai}"
TARGET_TIME="${SNIPER_DAILY_AT:-19:59:59}"
LOG_DIR="${LOG_DIR:-$APP_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/loop.log"

log() { echo "[$(date '+%F %T %Z')] [loop] $*"; }

# ── 单次实例锁:防止 ~/.bashrc 守卫重复拉起 ────────────────
LOCK="/tmp/libsniper_loop.lock"
if [[ -e "$LOCK" ]]; then
    AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK") ))
    # 循环进程是常驻的,锁若存在且 < 1 天视为仍在运行
    if pgrep -f "loop_sniper.sh" | grep -qv "$$" 2>/dev/null; then
        echo "[loop] 已有循环实例在运行($LOCK),本进程退出" >&2
        exit 0
    fi
    rm -f "$LOCK"
fi
echo "$$@$(date +%s)" > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

log "===== 循环调度器启动 ====="
log "APP_DIR=$APP_DIR  PYTHON=$PYTHON_BIN  TARGET=$TARGET_TIME  TZ=$TZ"
log "PID=$$  日志=$LOG_FILE"

# ── 主循环 ────────────────────────────────────────────────
while true; do
    # 计算到下一个目标时刻的秒数(GNU date:Ubuntu 默认)
    target_epoch="$(date -d "$TARGET_TIME" +%s 2>/dev/null || date -d "today $TARGET_TIME" +%s)"
    now_epoch="$(date +%s)"
    if (( target_epoch <= now_epoch )); then
        target_epoch=$(( target_epoch + 86400 ))   # 已过,改到明天
    fi
    wait=$(( target_epoch - now_epoch ))

    log "下次运行: $(date -d "@$target_epoch" '+%F %T %Z')(等待 ${wait}s)"

    # 分段 sleep:每 3600s 醒一次写心跳,避免长 sleep 在系统休眠后失准
    while (( wait > 0 )); do
        step=$(( wait > 3600 ? 3600 : wait ))
        sleep "$step"
        wait=$(( wait - step ))
    done

    log "----- 触发运行 -----"
    cd "$APP_DIR"
    set +e
    "$PYTHON_BIN" main.py --run-now
    RET=$?
    set -e
    case $RET in
        0) R="成功" ;;
        1) R="全部尝试失败" ;;
        2) R="认证失效(缓存过期/凭据登录失败)" ;;
        3) R="无启用方案" ;;
        *) R="异常($RET)" ;;
    esac
    log ">>> 退出码 ${RET} (${R})"

    # 触发后短暂歇 60s,避免边界上立刻又算到同一时刻
    sleep 60
done
