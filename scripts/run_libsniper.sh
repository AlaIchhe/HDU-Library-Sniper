#!/usr/bin/env bash
# run_libsniper.sh — 每日 19:59:59 (Asia/Shanghai) 运行 HDU 图书馆抢座
# 由 scripts/setup.sh 注册到 crontab;通常无需手动执行。
#
# 全部路径自推导,禁止在本文件中硬编码任何绝对路径:
#   APP_DIR      = 脚本所在目录的上一级,即项目 checkout 根(main.py 所在目录)
#   CONDA_ROOT   = 项目内的 miniconda → ~/miniconda3 → PATH 中的 conda,第一个命中即止
#   PYTHON_BIN   = 对应解释器(优先 base;设 CONDA_ENV 环境变量则切到该 env)
set -euo pipefail

# ── 路径自推导 ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

_detect_conda() {
    # 优先级:项目内 miniconda → ~/miniconda3 → ~/miniconda → PATH 中的 conda
    for c in "$APP_DIR/miniconda3" "$APP_DIR/miniconda" "$HOME/miniconda3" "$HOME/miniconda"; do
        [[ -x "$c/bin/conda" ]] && { echo "$c"; return 0; }
    done
    if command -v conda >/dev/null 2>&1; then
        conda info --base 2>/dev/null && return 0
    fi
    return 1
}

CONDA_ROOT="$(_detect_conda)"
if [[ -z "$CONDA_ROOT" ]]; then
    echo "[FATAL] 找不到 miniconda / conda,请先安装 miniconda 或把 conda 加入 PATH" >&2
    exit 127
fi

CONDA_ENV="${CONDA_ENV:-base}"
if [[ "$CONDA_ENV" == "base" ]]; then
    PYTHON_BIN="$CONDA_ROOT/bin/python"
else
    PYTHON_BIN="$CONDA_ROOT/envs/$CONDA_ENV/bin/python"
fi

# ── 前置校验 ──────────────────────────────────────────────
if [[ ! -f "$APP_DIR/main.py" ]]; then
    echo "[FATAL] $APP_DIR/main.py 不存在,请确认 checkout 完整性 (APP_DIR=$APP_DIR)" >&2
    exit 127
fi
if ! "$PYTHON_BIN" -V >/dev/null 2>&1; then
    echo "[FATAL] 解释器不可执行 (CONDA_ENV=$CONDA_ENV): $PYTHON_BIN" >&2
    exit 127
fi

# ── 日志 ──────────────────────────────────────────────────
LOG_DIR="${LOG_DIR:-$APP_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/libsniper.log"

# ── TZ ─────────────────────────────────────────────────────
export TZ="${TZ:-Asia/Shanghai}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*"; }

# ── 主流程(一次性日志文件,每次覆盖,保留最近 N 天备份) ────
{
    log "===== libsniper 启动 ====="
    log "APP_DIR     = $APP_DIR"
    log "CONDA_ROOT  = $CONDA_ROOT"
    log "CONDA_ENV   = $CONDA_ENV"
    log "PYTHON_BIN  = $PYTHON_BIN ($("$PYTHON_BIN" -V 2>&1))"
    log "USER        = ${USER:-?}  ($([[ $(id -u) -eq 0 ]] && echo root || echo non-root))"

    # 防并发锁:同一分钟只允许一个实例(55s 阈值,留 5s 余量给 19:59:59→20:00 边界)
    LOCK="/tmp/libsniper.lock"
    if [[ -e "$LOCK" ]]; then
        AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK") ))
        if (( AGE < 55 )); then
            log "已有运行中实例(锁文件 ${LOCK}, ${AGE}s 前由 $(cat "$LOCK" 2>/dev/null || echo '?') 创建),跳过本次"
            exit 0
        fi
        log "锁已过期(${AGE}s),移除"
        rm -f "$LOCK"
    fi
    echo "$$@$(date +%s)" > "$LOCK"
    trap 'rm -f "$LOCK"' EXIT

    # 运行 main.py --run-now
    cd "$APP_DIR"
    set +e
    "$PYTHON_BIN" main.py --run-now
    RET=$?
    set -e

    # 退出码语义(与 main.py 中的 App.run_once() 对齐)
    case $RET in
        0) RESULT="成功:至少一个方案抢座成功" ;;
        1) RESULT="失败:全部方案尝试失败" ;;
        2) RESULT="认证失效:Cookie 过期,需要重新登录" ;;
        3) RESULT="无方案:没有启用的预约方案" ;;
        *) RESULT="未知退出码($RET)" ;;
    esac
    log ">>> 退出码 = ${RET} (${RESULT})"

    exit "$RET"
} >> "$LOG_FILE" 2>&1
RET=$?

# 每次执行后把当日日志归档为带时间戳备份(仅保留最近 30 天)
cp -f "$LOG_FILE" "${LOG_FILE%.log}_$(date +%Y%m%d_%H%M%S).log" 2>/dev/null || true
find "$LOG_DIR" -name 'libsniper_*.log' -mtime +30 -delete 2>/dev/null || true

exit "$RET"
