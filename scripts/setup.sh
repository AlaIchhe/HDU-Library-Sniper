#!/usr/bin/env bash
# setup.sh — 自动注册每日 19:59:59 (Asia/Shanghai) 的定时任务运行 HDU 图书馆抢座
#
# 功能:
#   1) 校验 / 安装 miniconda3 到 $HOME/miniconda3(缺则按官方脚本静默安装)
#   2) 安装 dependencies(requirements.txt)到 base 环境
#   3) 校验 main.py 可解析
#   4) 在 crontab 中注册每日 19:59:00 触发 + sleep 59 秒 = 19:59:59 执行
#
# 使用:
#   cd <checkout>
#   bash scripts/setup.sh            # 首次部署
#   bash scripts/setup.sh --uninstall   # 仅移除 crontab 注册,不动环境
#
# 可在 crontab 里放心重复调用 —— 注册是幂等的(以 run_libsniper.sh 的绝对路径作标记,已存在则跳过)。
set -euo pipefail

# ── 自推导路径 ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
RUNNER="$SCRIPT_DIR/run_libsniper.sh"
TARGET_TIME="19:59:59"
TARGET_TZ="Asia/Shanghai"
CRON_MARKER="# libsniper-daily-run"

# ── 输出着色 ──────────────────────────────────────────────
if [[ -t 1 ]]; then
    C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BOLD=$'\033[1m'; C_RST=$'\033[0m'
else
    C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""; C_RST=""
fi
info() { echo "${C_BOLD}[setup]${C_RST} $*"; }
warn() { echo "${C_YELLOW}[setupWARN]${C_RST} $*"; }
err()  { echo "${C_RED}[setupERROR]${C_RST} $*"; }
ok()   { echo "${C_GREEN}[setupOK]${C_RST} $*"; }

# ── 仅卸载模式 ────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" || "${1:-}" == "uninstall" ]]; then
    info "仅卸载模式:移除 crontab 中的 libsniper 定时任务,保留环境与日志"
    if ! command -v crontab >/dev/null 2>&1; then
        warn "系统未安装 crontab,无需清理"
        exit 0
    fi

    TMP="$(mktemp)"
    if crontab -l 2>/dev/null > "$TMP"; then
        if grep -qF "$RUNNER" "$TMP"; then
            sed -i "\|$RUNNER|d" "$TMP"
            crontab "$TMP" && ok "已移除 crontab 条目: $RUNNER" || err "写入 crontab 失败"
        else
            info "crontab 中未发现 libsniper 条目,无需清理"
        fi
    else
        info "当前无 crontab,无需清理"
    fi
    rm -f "$TMP"
    exit 0
fi

info "=== HDU-Library-Sniper 自动部署 ==="
info "APP_DIR = $APP_DIR"

# ── 前置依赖:bash、curl/wget ──────────────────────────────
for cmd in bash; do
    command -v "$cmd" >/dev/null || { err "系统缺少必要命令: $cmd"; exit 1; }
done
if ! command -v crontab >/dev/null 2>&1; then
    err "系统未安装 crontab,请先安装(apt-get install cron 并 systemctl enable --now cron)"
    exit 1
fi

# ── 校验 main.py 存在 ─────────────────────────────────────
if [[ ! -f "$APP_DIR/main.py" ]]; then
    err "未找到 $APP_DIR/main.py,请在项目根目录执行本脚本"
    exit 1
fi

# ── miniconda 安装/校验 ───────────────────────────────────
CONDA_ROOT="$HOME/miniconda3"
MINI_SCRIPT="/tmp/Miniconda3-latest-Linux-x86_64.sh"

if [[ ! -x "$CONDA_ROOT/bin/conda" ]]; then
    info "未找到 $CONDA_ROOT,开始静默安装 Miniconda3(Linux x86_64)..."
    if command -v wget >/dev/null 2>&1; then
        wget -q "https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh" -O "$MINI_SCRIPT"
    elif command -v curl >/dev/null 2>&1; then
        curl -fsSL "https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh" -o "$MINI_SCRIPT"
    else
        err "需要 curl 或 wget 下载 Miniconda,请先安装其中一个"
        exit 1
    fi
    bash "$MINI_SCRIPT" -b -p "$CONDA_ROOT" >/dev/null
    rm -f "$MINI_SCRIPT"
    ok "Miniconda3 已安装到 $CONDA_ROOT"
else
    ok "Miniconda3 已存在: $CONDA_ROOT"
fi

# ── conda 初始化(base) ────────────────────────────────────
# 非交互式 shell 需要用 eval 载入 conda shell hook,否则后续 pip install 无法激活 base
eval "$("$CONDA_ROOT/bin/conda" shell.bash hook 2>/dev/null)" || true
conda activate base 2>/dev/null || true

PYTHON_BIN="$CONDA_ROOT/bin/python"
if ! "$PYTHON_BIN" -V >/dev/null 2>&1; then
    err "解释器不可执行(安装可能不完整): $PYTHON_BIN"
    exit 1
fi
ok "Python: $("$PYTHON_BIN" -V 2>&1)"

# ── 安装依赖 ──────────────────────────────────────────────
if [[ -f "$APP_DIR/requirements.txt" ]]; then
    info "安装 $APP_DIR/requirements.txt 到 base 环境..."
    "$CONDA_ROOT/bin/pip" install -q --upgrade pip >/dev/null 2>&1 || true
    "$CONDA_ROOT/bin/pip" install -q -r "$APP_DIR/requirements.txt"
    ok "依赖就位"
else
    warn "未找到 $APP_DIR/requirements.txt,跳过依赖安装"
fi

# ── 校验 main.py 可解析(syntax check) ─────────────────────
if ! "$PYTHON_BIN" -m py_compile "$APP_DIR/main.py"; then
    err "main.py 语法检查失败,请先在手动环境下排查: $PYTHON_BIN -m py_compile $APP_DIR/main.py"
    exit 1
fi
ok "main.py 语法校验通过"

# ── 确保 run_libsniper.sh 可执行 ──────────────────────────
chmod +x "$RUNNER"
RUNNER_ABS="$(cd "$(dirname "$RUNNER")" && pwd)/$(basename "$RUNNER")"
ok "运行器就绪: $RUNNER_ABS"

# ── 关键:19:59:59 的精确定时方案 ─────────────────────────
# crontab 最小粒度是分钟,因此:
#   - 注册为 '59 19 * * *',即 19:59:00 触发
#   - 执行前先 sleep 59,等到 19:59:59 再真正调用运行器
#     (cron 触发误差通常 <10ms,加上 sleep 精度约 10ms,总误差 <50ms)
# 命令中所有 % 字符必须转义,否则被 crontab 当作 newline。
CRON_TIME="59 19"
CRON_CMD='sleep 59 && TZ=Asia/Shanghai '
CRON_CMD+="$RUNNER_ABS"
CRON_LINE="$CRON_TIME * * * $CRON_CMD $CRON_MARKER"

# ── 幂等注册:先删后写 ─────────────────────────────────────
TMP="$(mktemp)"
crontab -l 2>/dev/null > "$TMP" || true

if grep -qF "$RUNNER_ABS" "$TMP"; then
    info "crontab 中已有注册(自动更新),移除旧条目..."
    # 移除与该运行器相关的连续两行(命令 + marker 注释)
    sed -i "\|$RUNNER_ABS|d" "$TMP"
fi

# 追加新条目(命令 + marker 注释,便于后续定位)
printf '%s\n' "$CRON_LINE" >> "$TMP"

if crontab "$TMP"; then
    ok "crontab 注册成功"
else
    err "crontab 写入失败,请检查是否有权限"
    rm -f "$TMP"
    exit 1
fi
rm -f "$TMP"

# ── 确保 cron 服务处于运行状态 ─────────────────────────────
if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet cron 2>/dev/null || systemctl is-active --quiet crond 2>/dev/null; then
        ok "cron 服务运行中"
    else
        warn "cron 服务未运行,尝试启动(sudo 可能需要口令)"
        (sudo systemctl enable --now cron 2>/dev/null || sudo systemctl enable --now crond 2>/dev/null) \
            || warn "自动启动失败,请手动: sudo systemctl enable --now cron"
    fi
fi

# ── 汇总 ──────────────────────────────────────────────────
echo
info "=== 部署完成 ==="
echo
echo "  触发时刻 : 每日 $TARGET_TIME ($TARGET_TZ)"
echo "  计时方案 : crontab $CRON_TIME * * * + sleep 59s"
echo "  运行器   : $RUNNER_ABS"
echo "  下次执行 :"
crontab -l 2>/dev/null | grep -F "$RUNNER_ABS" | head -1
echo
echo "  常用命令:"
echo "    bash $0 --uninstall    # 仅移除 crontab,不动环境与日志"
echo "    $RUNNER_ABS            # 手跑一次验证"
echo "    tail -f $APP_DIR/logs/libsniper.log     # 看日志"
echo
ok "部署完成。如果想手动抢一次,回车执行:"
echo "    $RUNNER_ABS"
