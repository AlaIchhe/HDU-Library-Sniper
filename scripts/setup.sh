#!/usr/bin/env bash
# setup.sh — 全自动注册每日定时任务运行 HDU 图书馆抢座(Ubuntu / Linux)
#
# 设计原则:
#   1) 零交互 —— 全程不向用户确认,能自动装的直接装,不能装的警告后继续
#   2) 幂等   —— 重复运行不会产生重复条目,不会重复安装已存在的依赖
#   3) 自推导 —— 项目目录、Python 解释器、miniconda 路径全部自动探测,禁止手动拼路径
#   4) 用户级 —— 默认在当前用户 crontab 注册,无需 sudo;仅系统级包尝试 sudo
#
# 用法:
#   bash scripts/setup.sh                 # 首次部署 / 更新(全自动)
#   bash scripts/setup.sh --uninstall     # 仅移除 crontab 条目,保留环境与日志
#
# 自定义(环境变量):
#   CONDA_ENV        conda 环境名(缺省 base)
#   SNIPER_DAILY_AT 触发时刻 HH:MM:SS 或 HH:MM(缺省 19:59:59)
#   LOG_DIR         日志目录(缺省 <checkout>/logs)
#   TZ              时区(缺省 Asia/Shanghai)
set -euo pipefail

# ── 自推导路径 ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
RUNNER="$SCRIPT_DIR/run_libsniper.sh"
LOG_DIR="${LOG_DIR:-$APP_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/setup_$(date +%Y%m%d_%H%M%S).log"
TARGET_TZ="${TZ:-Asia/Shanghai}"
TARGET_TIME="${SNIPER_DAILY_AT:-19:59:59}"
CRON_MARKER="# libsniper-daily-run"

# ── 输出 + 日志双写 ───────────────────────────────────────
exec > >(tee -a "$LOG_FILE") 2>&1
log()  { echo "[$(date '+%F %T')] $*"; }
ok()   { echo "[$(date '+%F %T')] [OK]   $*"; }
warn() { echo "[$(date '+%F %T')] [WARN] $*"; }
err()  { echo "[$(date '+%F %T')] [ERR]  $*"; }

# ── 解析目标时刻 ──────────────────────────────────────────
_parse_target_time() {
    local t="$1" hh="" mm="" ss="0"
    local IFS=':'
    read -r hh mm ss <<<"$t"
    hh="${hh#0}"; mm="${mm#0}"; ss="${ss:-0}"; ss="${ss#0}"
    hh="${hh:-0}"; mm="${mm:-0}"; ss="${ss:-0}"
    if ! (( 0 <= hh && hh < 24 && 0 <= mm && mm < 60 && 0 <= ss && ss < 60 )); then
        err "SNIPER_DAILY_AT 格式非法: $1(需要 HH:MM:SS 或 HH:MM)"
        exit 1
    fi
    TARGET_HOUR=$hh
    TARGET_MIN=$mm
    TARGET_SEC=$ss
    CRON_HOUR=$hh
    CRON_MIN=$mm
    SLEEP_SEC=$ss
}
_parse_target_time "$TARGET_TIME"

# ── 仅卸载模式 ────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" || "${1:-}" == "uninstall" ]]; then
    log "=== 卸载模式 ==="
    # 1) crontab 条目(若有)
    if command -v crontab >/dev/null 2>&1; then
        TMP="$(mktemp)"
        if crontab -l 2>/dev/null > "$TMP"; then
            if grep -qF "$RUNNER" "$TMP"; then
                sed -i "\|$RUNNER|d" "$TMP"
                crontab "$TMP" && ok "已移除 crontab 条目" || warn "crontab 写入失败"
            else
                log "crontab 中未发现 libsniper 条目"
            fi
        fi
        rm -f "$TMP"
    else
        log "系统无 crontab,跳过"
    fi
    # 2) 常驻循环进程 + ~/.bashrc 守卫(loop 模式)
    LOOP="$SCRIPT_DIR/loop_sniper.sh"
    PIDS="$(pgrep -f "loop_sniper.sh" 2>/dev/null || true)"
    if [[ -n "$PIDS" ]]; then
        echo "$PIDS" | xargs -r kill 2>/dev/null || true
        ok "已终止常驻循环进程: ${PIDS//$'\n'/ }"
    else
        log "无运行中的循环进程"
    fi
    BASHRC="$HOME/.bashrc"
    MARK_BEGIN="# >>> libsniper loop begin >>>"
    MARK_END="# <<< libsniper loop end <<<"
    if [[ -f "$BASHRC" ]] && grep -qF "$MARK_BEGIN" "$BASHRC"; then
        sed -i "/${MARK_BEGIN//\//\\/}/,/${MARK_END//\//\\/}/d" "$BASHRC"
        ok "已移除 ~/.bashrc 自愈守卫"
    fi
    # 3) 冻结的配置文件(保留 miniconda / 依赖 / 日志)
    rm -f "$APP_DIR/.libsniper.env" && ok "已移除 .libsniper.env"
    ok "卸载完成(crontab 条目 / 循环进程 / .bashrc 守卫 / 配置文件)"
    exit 0
fi

log "=== HDU-Library-Sniper 自动部署(零交互) ==="
log "LOG_FILE    = $LOG_FILE"
log "APP_DIR     = $APP_DIR"
log "TARGET_TIME = $TARGET_TIME ($TARGET_TZ) -> cron $CRON_HOUR:$CRON_MIN:00 + sleep ${SLEEP_SEC}s"

# ── Step 1:系统依赖自动检测 + 安装 ────────────────────────
SYS_DEPS=(curl wget crontab)
MISSING_SYS=()
for cmd in "${SYS_DEPS[@]}"; do
    command -v "$cmd" >/dev/null 2>&1 || MISSING_SYS+=("$cmd")
done

_install_apt() {
    sudo -n apt-get update -qq >/dev/null 2>&1 || true
    sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null 2>&1
}
_install_yum()    { sudo -n yum install -y -q "$@" >/dev/null 2>&1; }
_install_dnf()    { sudo -n dnf install -y -q "$@" >/dev/null 2>&1; }
_install_pacman() { sudo -n pacman -Sy --noconfirm --quiet "$@" >/dev/null 2>&1; }
_install_brew()   { brew install "$@" >/dev/null 2>&1; }

if (( ${#MISSING_SYS[@]} > 0 )); then
    log "缺少系统依赖: ${MISSING_SYS[*]},自动安装..."
    declare -A PKG_MAP
    PKG_MGR=""
    if command -v apt-get >/dev/null 2>&1; then
        PKG_MGR="apt"
        PKG_MAP=( [curl]=curl [wget]=wget [crontab]=cron )
    elif command -v dnf >/dev/null 2>&1; then
        PKG_MGR="dnf"; PKG_MAP=( [curl]=curl [wget]=wget [crontab]=cronie )
    elif command -v yum >/dev/null 2>&1; then
        PKG_MGR="yum"; PKG_MAP=( [curl]=curl [wget]=wget [crontab]=cronie )
    elif command -v pacman >/dev/null 2>&1; then
        PKG_MGR="pacman"; PKG_MAP=( [curl]=curl [wget]=wget [crontab]=cronie )
    elif command -v brew >/dev/null 2>&1; then
        PKG_MGR="brew"; PKG_MAP=( [curl]=curl [wget]=wget [crontab]=cron )
    fi

    if [[ -n "$PKG_MGR" ]]; then
        PKGS=()
        for c in "${MISSING_SYS[@]}"; do PKGS+=("${PKG_MAP[$c]:-$c}"); done
        log "使用 $PKG_MGR 安装: ${PKGS[*]}"
        if "_install_$PKG_MGR" "${PKGS[@]}"; then
            ok "系统依赖安装完成: ${PKGS[*]}"
        else
            warn "系统依赖安装失败(可能无 sudo 权限),继续;若后续步骤失败请手动安装: ${PKGS[*]}"
        fi
    else
        warn "未识别的包管理器,请手动安装: ${MISSING_SYS[*]}"
    fi
else
    ok "系统依赖已就绪: ${SYS_DEPS[*]}"
fi

if ! command -v crontab >/dev/null 2>&1; then
    warn "crontab 不可用(无 cron 或无 root)—— 将在后续自动改用纯用户态常驻循环"
fi

# ── Step 2:miniconda 自动检测 / 安装 ──────────────────────
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
    CONDA_ROOT="$HOME/miniconda3"
    log "未找到 miniconda,自动安装到 $CONDA_ROOT ..."
    MINI_SCRIPT="/tmp/Miniconda3-latest-Linux-x86_64.sh"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh" -o "$MINI_SCRIPT"
    elif command -v wget >/dev/null 2>&1; then
        wget -q "https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh" -O "$MINI_SCRIPT"
    else
        err "需要 curl 或 wget 下载 Miniconda,请先安装其中一个"
        exit 1
    fi
    bash "$MINI_SCRIPT" -b -p "$CONDA_ROOT" >/dev/null
    rm -f "$MINI_SCRIPT"
    ok "Miniconda3 安装完成: $CONDA_ROOT"
else
    ok "Miniconda3 已就绪: $CONDA_ROOT"
fi

# ── Step 3:conda 初始化 + Python 校验 ─────────────────────
eval "$("$CONDA_ROOT/bin/conda" shell.bash hook 2>/dev/null)" || true
conda activate base >/dev/null 2>&1 || true

CONDA_ENV="${CONDA_ENV:-base}"
if [[ "$CONDA_ENV" == "base" ]]; then
    PYTHON_BIN="$CONDA_ROOT/bin/python"
else
    if ! conda env list 2>/dev/null | grep -qw "$CONDA_ENV"; then
        log "conda env '$CONDA_ENV' 不存在,自动创建..."
        conda create -y -q -n "$CONDA_ENV" python=3.11 >/dev/null
        ok "conda env '$CONDA_ENV' 创建完成"
    fi
    PYTHON_BIN="$CONDA_ROOT/envs/$CONDA_ENV/bin/python"
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
    err "Python 解释器不可执行: $PYTHON_BIN"
    exit 1
fi
ok "Python: $("$PYTHON_BIN" -V 2>&1)  ($PYTHON_BIN)"

# ── Step 4:检查并补装 Python 依赖(自动、幂等) ────────────
# pip install -r 本身就是幂等的:它逐条检查每个 requirement,仅对缺失或版本
# 不满足的包发起安装,已满足的打印 "already satisfied" 跳过。这里先用
# --dry-run 探测待装项(可读性好),再决定是否真正安装;老版本 pip 不支持
# --dry-run 时退化为直接幂等安装。
if [[ -f "$APP_DIR/requirements.txt" ]]; then
    log "检查 Python 依赖..."
    PIP="$CONDA_ROOT/bin/pip"
    DRY_OUT=""
    if DRY_OUT="$("$PIP" install --dry-run -r "$APP_DIR/requirements.txt" 2>/dev/null)"; then
        # --dry-run 支持:输出含 "Would install ..." 说明有缺失
        if echo "$DRY_OUT" | grep -qi 'would install\|would download'; then
            TO_INSTALL="$(echo "$DRY_OUT" | grep -i 'would install' | sed 's/.*[Ii]nstall //')"
            log "缺失 Python 包,自动补装: $TO_INSTALL"
            if "$PIP" install -q -r "$APP_DIR/requirements.txt"; then
                ok "Python 依赖补装完成"
            else
                err "Python 依赖安装失败,请检查网络或 pip 源"
                exit 1
            fi
        else
            ok "Python 依赖已全部就绪(无需补装)"
        fi
    else
        # --dry-run 不被支持(老 pip):直接幂等安装,pip 自身只装缺失项
        log "pip 不支持 --dry-run,直接幂等安装依赖..."
        if "$PIP" install -q -r "$APP_DIR/requirements.txt"; then
            ok "Python 依赖就绪"
        else
            err "Python 依赖安装失败,请检查网络或 pip 源"
            exit 1
        fi
    fi
else
    warn "未找到 $APP_DIR/requirements.txt,跳过依赖检查"
fi

# ── Step 5:main.py 语法校验 ───────────────────────────────
if [[ ! -f "$APP_DIR/main.py" ]]; then
    err "未找到 $APP_DIR/main.py,请在项目根目录执行本脚本"
    exit 1
fi
if ! "$PYTHON_BIN" -m py_compile "$APP_DIR/main.py"; then
    err "main.py 语法检查失败,请先修复: $PYTHON_BIN -m py_compile $APP_DIR/main.py"
    exit 1
fi
ok "main.py 语法校验通过"

# ── Step 6:确保 run_libsniper.sh 可执行 ───────────────────
chmod +x "$RUNNER"
RUNNER_ABS="$(cd "$(dirname "$RUNNER")" && pwd)/$(basename "$RUNNER")"
ok "运行器就绪: $RUNNER_ABS"

# ── Step 7:冻结配置到 .libsniper.env(供 runner/loop 读取) ─
ENV_FILE="$APP_DIR/.libsniper.env"
cat > "$ENV_FILE" <<EOF
# 由 scripts/setup.sh 自动生成,记录部署时确定的调度配置。可删除后重跑 setup.sh 重建。
SNIPER_DAILY_AT='$TARGET_TIME'
CONDA_ENV='$CONDA_ENV'
TZ='$TARGET_TZ'
LOG_DIR='$LOG_DIR'
EOF
chmod 600 "$ENV_FILE" 2>/dev/null || true
ok "配置已冻结: $ENV_FILE"

# 确保 loop_sniper.sh 也可执行(无 cron 时的替代方案会用到)
LOOP="$SCRIPT_DIR/loop_sniper.sh"
[[ -f "$LOOP" ]] && chmod +x "$LOOP"
LOOP_ABS="$(cd "$SCRIPT_DIR" && pwd)/loop_sniper.sh"

# ── Step 8:选择调度方式 —— 有 cron 用 cron,否则纯用户态循环 ─
_cron_is_running() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl is-active --quiet cron 2>/dev/null && return 0
        systemctl is-active --quiet crond 2>/dev/null && return 0
    fi
    pgrep -x cron >/dev/null 2>&1 && return 0
    pgrep -x crond >/dev/null 2>&1 && return 0
    return 1
}

USE_CRON=0
if command -v crontab >/dev/null 2>&1 && _cron_is_running; then
    USE_CRON=1
fi

if (( USE_CRON )); then
    # ── 模式 A:crontab(有 cron 服务) ──────────────────────
    log "检测到 cron 服务可用,采用 crontab 模式"
    CRON_CMD="sleep $SLEEP_SEC && TZ=$TARGET_TZ $RUNNER_ABS"
    CRON_LINE="$CRON_MIN $CRON_HOUR * * * $CRON_CMD $CRON_MARKER"

    TMP="$(mktemp)"
    crontab -l 2>/dev/null > "$TMP" || true
    if grep -qF "$RUNNER_ABS" "$TMP"; then
        log "crontab 中已有注册,更新条目..."
        sed -i "\|$RUNNER_ABS|d" "$TMP"
    fi
    printf '%s\n' "$CRON_LINE" >> "$TMP"
    if crontab "$TMP"; then
        ok "crontab 注册成功"
    else
        err "crontab 写入失败,请检查权限"
        rm -f "$TMP"; exit 1
    fi
    rm -f "$TMP"
    DEPLOY_MODE="crontab"
else
    # ── 模式 B:纯用户态常驻循环(无 cron / 无 root) ────────
    log "未检测到可用的 cron 服务(无 cron 或无 root 启动),改用纯用户态常驻循环"
    BASHRC="$HOME/.bashrc"
    MARK_BEGIN="# >>> libsniper loop begin >>>"
    MARK_END="# <<< libsniper loop end <<<"
    # 幂等:先删旧块再追加
    if [[ -f "$BASHRC" ]]; then
        sed -i "/${MARK_BEGIN//\//\\/}/,/${MARK_END//\//\\/}/d" "$BASHRC"
    fi
    {
        echo "$MARK_BEGIN"
        echo "# 由 scripts/setup.sh 自动写入:登录时若循环未在跑则拉起(无 cron 替代方案)"
        echo 'if ! pgrep -f "loop_sniper.sh" >/dev/null 2>&1; then'
        echo "  setsid bash \"$LOOP_ABS\" >> \"$LOG_DIR/loop.log\" 2>&1 < /dev/null & disown"
        echo 'fi'
        echo "$MARK_END"
    } >> "$BASHRC"
    ok "已写入 ~/.bashrc 自愈守卫(重启后登录即重启循环)"

    # 立即拉起一次,本次部署就生效(无需等下次登录)
    if ! pgrep -f "loop_sniper.sh" >/dev/null 2>&1; then
        setsid bash "$LOOP_ABS" >> "$LOG_DIR/loop.log" 2>&1 < /dev/null & disown
        sleep 1
        if pgrep -f "loop_sniper.sh" >/dev/null 2>&1; then
            ok "常驻循环已启动(已脱离终端,SSH 登出不中断)"
        else
            warn "常驻循环启动可能失败,请查看: tail -f $LOG_DIR/loop.log"
        fi
    else
        ok "常驻循环已在运行"
    fi
    DEPLOY_MODE="loop(无 cron)"
fi

# ── 汇总 ──────────────────────────────────────────────────
echo
log "=== 部署完成 ==="
log "调度方式 : $DEPLOY_MODE"
log "触发时刻 : 每日 $TARGET_TIME ($TARGET_TZ)"
if (( USE_CRON )); then
    log "计时方案 : crontab $CRON_HOUR:$CRON_MIN:00 + sleep ${SLEEP_SEC}s"
    log "运行器   : $RUNNER_ABS"
    log "注册条目 :"
    crontab -l 2>/dev/null | grep -F "$RUNNER_ABS" | head -1
else
    log "运行器   : $LOOP_ABS"
    log "日志     : $LOG_DIR/loop.log"
    log "进程     : $(pgrep -f "loop_sniper.sh" | tr '\n' ' ' || echo 未运行)"
fi
echo
log "维护命令:"
log "  bash $0 --uninstall   移除定时任务(crontab 或 ~/.bashrc 守卫 + 进程)"
log "  $RUNNER_ABS           手跑一次验证(cron 模式)"
log "  tail -f $LOG_DIR/loop.log             看循环日志(loop 模式)"
log "  pgrep -af loop_sniper                 查看循环进程"
echo
ok "部署完成"
