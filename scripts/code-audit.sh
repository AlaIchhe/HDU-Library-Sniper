#!/usr/bin/env bash
# 本地代码审计管线：体量 -> 大文件 -> 格式 -> vet -> 测试 -> biome -> 类型 -> 重复 -> 死代码
# 用法：./scripts/code-audit.sh [--fast]
#   --fast  跳过 go test / vitest（只跑静态检查）
# 输出：$AUDIT_OUT（默认 .audit/，已在 .gitignore 与 biome 中排除）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="${AUDIT_OUT:-}"
[ -z "$OUT" ] && OUT="$ROOT/.audit"
mkdir -p "$OUT"
FAST=0
if [ "$#" -gt 0 ] && [ "$1" = "--fast" ]; then FAST=1; fi
# npx/knip 的缓存放仓库内，避免只读 HOME 导致 EROFS
export npm_config_cache="${npm_config_cache:-$OUT/npm}"
mkdir -p "$npm_config_cache"

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
FAILED=0
section() { printf '\n%s== %s ==%s\n' "$BOLD" "$*" "$RESET"; }
pass() { printf '%s  OK  %s%s\n' "$GREEN" "$*" "$RESET"; }
warn() { printf '%s WARN %s%s\n' "$YELLOW" "$*" "$RESET"; }
fail() { printf '%s FAIL %s%s\n' "$RED" "$*" "$RESET"; FAILED=1; }
have() { command -v "$1" >/dev/null 2>&1; }

# 仓库内自带的 Go / Bun 工具链（本机没有全局安装时）
if [ -d "$ROOT/.toolchain/go/bin" ]; then
  export PATH="$ROOT/.toolchain/go/bin:$PATH"
fi

section "1/10 体量"
find cmd internal main.go src tests -type f \( -name '*.go' -o -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
  -print0 | xargs -0 wc -l | tail -1 | tee "$OUT/loc.txt"
for ext in go ts tsx css; do
  n=$(find cmd internal main.go src tests -type f -name "*.$ext" -print0 | xargs -0 cat 2>/dev/null | wc -l)
  printf '  .%-4s %7s 行\n' "$ext" "$n"
done

section "2/10 超大文件（阈值 1200 行，>600 行列出）"
LIMIT=1200
find cmd internal main.go src -type f \( -name '*.go' -o -name '*.ts' -o -name '*.tsx' \) \
  -not -path 'src/ui/*' -print0 | xargs -0 wc -l | sort -rn \
  | awk -v lim="$LIMIT" 'NR>1 && $1>600 {printf "  %5d  %s\n", $1, $2; if ($1>lim) bad=1} END {exit bad?1:0}'
if [ "$?" -ne 0 ]; then fail "存在超过 $LIMIT 行的文件，建议拆分"; else pass "无超过 $LIMIT 行的文件"; fi

section "3/10 gofmt"
if have gofmt; then
  unformatted=$(gofmt -l cmd internal main.go)
  printf '%s\n' "$unformatted" >"$OUT/gofmt.txt"
  if [ -z "$unformatted" ]; then pass "gofmt 通过"; else fail "gofmt 有差异，运行 gofmt -w cmd internal main.go"; fi
else warn "未找到 gofmt，跳过"; fi

section "4/10 go vet + contract"
if have go; then
  if CGO_ENABLED=0 go vet ./... >"$OUT/go-vet.txt" 2>&1 && CGO_ENABLED=0 go run ./cmd/gen-contract --check >>"$OUT/go-vet.txt" 2>&1; then
    pass "go vet 与契约同步通过"
  else
    fail "go vet 或契约同步失败，见 $OUT/go-vet.txt"
  fi
else warn "未找到 go，跳过"; fi

section "5/10 go test"
if [ "$FAST" = "1" ]; then
  warn "--fast：跳过"
elif have go; then
  if CGO_ENABLED=0 go test -v ./... >"$OUT/go-test.txt" 2>&1; then
    n=$(grep -cE '^ok\s+' "$OUT/go-test.txt" || true)
    pass "go test 通过（$n 个包）"
  else
    fail "go test 失败，见 $OUT/go-test.txt"
  fi
else warn "未找到 go，跳过"; fi

section "6/10 biome"
if [ -x node_modules/.bin/biome ]; then
  if ./node_modules/.bin/biome ci . >"$OUT/biome.txt" 2>&1; then
    pass "biome 0 diagnostics"
  else
    fail "biome 失败，见 $OUT/biome.txt"
  fi
else warn "未安装 biome，先 bun install"; fi

section "7/10 tsc --noEmit"
if [ -x node_modules/.bin/tsc ]; then
  if ./node_modules/.bin/tsc --noEmit >"$OUT/tsc.txt" 2>&1; then pass "类型检查通过"; else fail "类型错误，见 $OUT/tsc.txt"; fi
else warn "未安装 typescript"; fi

section "8/10 vitest"
if [ "$FAST" = "1" ]; then
  warn "--fast：跳过"
elif [ -x node_modules/.bin/vitest ]; then
  if ./node_modules/.bin/vitest run --reporter=dot >"$OUT/vitest.txt" 2>&1; then pass "前端单测通过"; else fail "前端单测失败，见 $OUT/vitest.txt"; fi
else warn "未安装 vitest"; fi

section "9/10 jscpd 重复代码（门禁 3%）"
if have npx; then
  if npx --yes jscpd@4 --min-lines 12 --min-tokens 70 --threshold 3 \
      --format go,typescript,tsx,css \
      --ignore '**/node_modules/**,**/build/**,**/.mygo/**,**/.toolchain/**,**/ui/**,**/mygo.ts,**/api.generated.ts' \
      --reporters console --output "$OUT/jscpd" src internal cmd tests >"$OUT/jscpd.txt" 2>&1; then
    pass "重复率低于 3%"
  else
    fail "重复率超过 3%，见 $OUT/jscpd.txt"
  fi
else warn "未找到 npx，跳过"; fi

section "10/10 knip 死代码（可选）"
if [ -x node_modules/.bin/knip ]; then
  if ./node_modules/.bin/knip --no-progress >"$OUT/knip.txt" 2>&1; then pass "无未用依赖/导出"; else warn "存在未用导出或依赖，见 $OUT/knip.txt（组件库导出可忽略）"; fi
else warn "未安装 knip（npx knip@5），跳过"; fi

printf '\n%s结果：%s\n' "$BOLD" "$RESET"
if [ "$FAILED" = "0" ]; then
  printf '%s全部通过%s（报告目录：%s）\n' "$GREEN" "$RESET" "$OUT"
else
  printf '%s有阶段失败%s（日志：%s）\n' "$RED" "$RESET" "$OUT"
fi
exit "$FAILED"
