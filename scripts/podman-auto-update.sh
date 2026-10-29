#!/usr/bin/env bash
#
# Update the production Podman deployment from a published container image.
#
# Nothing is built on this host: GitHub Actions publishes the image
# (.github/workflows/image.yml -> ghcr.io/<owner>/hdu-library-sniper) and this
# job only pulls it. The candidate container runs against a disposable data
# volume and must answer /api/health before production is replaced; a failed
# replacement is rolled back to the previous container.
#
# The script is installed to /usr/local/sbin by install-podman-auto-update.sh and
# deliberately does not need a local Git checkout, so the deployment host keeps
# no source tree at all.
set -Eeuo pipefail

IMAGE=${HDU_SNIPER_IMAGE:-ghcr.io/alaichhe/hdu-library-sniper:latest}
CONTAINER_NAME=${HDU_SNIPER_CONTAINER_NAME:-hdu-library-sniper}
VOLUME_NAME=${HDU_SNIPER_VOLUME:-hdu-sniper-data}
ENV_FILE=${HDU_SNIPER_ENV_FILE:-/etc/hdu-sniper/env}
HOST_PORT=${HDU_SNIPER_HOST_PORT:-8000}
BIND_ADDRESS=${HDU_SNIPER_BIND_ADDRESS:-0.0.0.0}
READY_TIMEOUT_SECONDS=${HDU_SNIPER_READY_TIMEOUT_SECONDS:-60}
LOCK_FILE=${HDU_SNIPER_UPDATE_LOCK_FILE:-/run/hdu-library-sniper-auto-update.lock}
PRUNE_IMAGES=${HDU_SNIPER_PRUNE_IMAGES:-1}
LEGACY_IMAGE_PREFIX=${HDU_SNIPER_LEGACY_IMAGE_PREFIX:-localhost/hdu-library-sniper:}

CANDIDATE_CONTAINER=
CANDIDATE_VOLUME=

log() {
  printf '[hdu-library-sniper auto-update] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

short_id() {
  local value=${1#sha256:}
  printf '%s' "${value:0:12}"
}

# 旧版本在宿主机本地构建镜像（localhost/hdu-library-sniper:*）。迁移到镜像
# 部署后这些 tag 不再需要；顺手清掉，并回收不再被引用的悬空层。
# 设置 HDU_SNIPER_PRUNE_IMAGES=0 可跳过全局悬空镜像清理。
reclaim_images() {
  local name
  while IFS= read -r name; do
    [[ "$name" == "$LEGACY_IMAGE_PREFIX"* ]] || continue
    log "removing legacy local build image $name"
    podman image rm "$name" >/dev/null 2>&1 || true
  done < <(podman images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)

  if [[ "$PRUNE_IMAGES" != 0 ]]; then
    podman image prune --force >/dev/null 2>&1 || true
  fi
}

cleanup() {
  local status=$?
  if [[ -n "$CANDIDATE_CONTAINER" ]]; then
    podman rm -f "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "$CANDIDATE_VOLUME" ]]; then
    podman volume rm -f "$CANDIDATE_VOLUME" >/dev/null 2>&1 || true
  fi
  exit "$status"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

container_exists() {
  podman container exists "$1"
}

container_running() {
  [[ "$(podman inspect --format '{{.State.Running}}' "$1" 2>/dev/null || printf false)" == "true" ]]
}

container_image_id() {
  podman inspect --format '{{.Image}}' "$1" 2>/dev/null || true
}

image_revision() {
  local revision
  revision="$(podman image inspect --format '{{index .Labels "com.hdu-library-sniper.source-revision"}}' "$1" 2>/dev/null || true)"
  [[ "$revision" == "<no value>" ]] && revision=
  printf '%s' "$revision"
}

run_args() {
  local container_name=$1
  local volume_name=$2
  local publish=$3
  local restart_policy=$4

  local -a args=(
    --name "$container_name"
    --restart "$restart_policy"
    --env HDU_SNIPER_HOME=/var/lib/hdu-sniper
    --env HDU_WEB_PORT=8000
    --volume "$volume_name:/var/lib/hdu-sniper:Z"
    --publish "$publish"
    --health-cmd "wget -qO- http://127.0.0.1:8000/api/health"
    --health-interval 30s
    --health-timeout 5s
    --health-retries 3
    --health-start-period 10s
  )

  if [[ -f "$ENV_FILE" ]]; then
    args+=(--env-file "$ENV_FILE")
  fi

  printf '%s\0' "${args[@]}"
}

start_container() {
  local image=$1
  local container_name=$2
  local volume_name=$3
  local publish=$4
  local restart_policy=$5
  local revision=$6

  local -a args=()
  while IFS= read -r -d '' argument; do
    args+=("$argument")
  done < <(run_args "$container_name" "$volume_name" "$publish" "$restart_policy")

  podman run "${args[@]}" \
    --label "com.hdu-library-sniper.source-revision=$revision" \
    --detach "$image"
}

wait_for_ready() {
  local container_name=$1
  local url=$2
  local label=$3
  local elapsed=0

  while (( elapsed < READY_TIMEOUT_SECONDS )); do
    if ! container_running "$container_name"; then
      log "$label stopped before becoming ready"
      podman logs --tail 80 "$container_name" 2>&1 || true
      return 1
    fi

    if curl --fail --silent --show-error --connect-timeout 2 --max-time 3 "$url" >/dev/null; then
      log "$label passed HTTP health check"
      return 0
    fi

    sleep 1
    ((elapsed += 1))
  done

  log "$label did not become healthy within ${READY_TIMEOUT_SECONDS}s"
  podman logs --tail 80 "$container_name" 2>&1 || true
  return 1
}

require_command curl
require_command flock
require_command podman

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another update job is already running; skipping"
  exit 0
fi

# 锁由父 shell 持有。把真正的更新逻辑放进一个子 shell 执行，并在子 shell 内
# 立刻关闭锁描述符 9，避免脚本通过 podman 启动的 conmon 进程继承这个锁 fd。
# 否则 conmon 会一直持有锁，导致次日自动更新被误判为 "already running" 而跳过。
(
  exec 9>&-
  trap cleanup EXIT

  log "pulling $IMAGE"
  podman pull --quiet "$IMAGE" >/dev/null \
    || die "could not pull $IMAGE; check the network and, if the package is private, run 'podman login ghcr.io'"

  TARGET_IMAGE_ID="$(podman image inspect --format '{{.Id}}' "$IMAGE")" \
    || die "could not inspect $IMAGE after pull"
  TARGET_REVISION="$(image_revision "$IMAGE")"
  SHORT_REVISION="$(short_id "${TARGET_REVISION:-$TARGET_IMAGE_ID}")"

  CURRENT_IMAGE_ID=
  if container_exists "$CONTAINER_NAME"; then
    CURRENT_IMAGE_ID="$(container_image_id "$CONTAINER_NAME")"
  fi

  if [[ "$CURRENT_IMAGE_ID" == "$TARGET_IMAGE_ID" ]]; then
    if ! container_running "$CONTAINER_NAME"; then
      log "current image is installed but the service is stopped; starting it"
      podman start "$CONTAINER_NAME" >/dev/null
    fi
    wait_for_ready "$CONTAINER_NAME" "http://127.0.0.1:${HOST_PORT}/api/health" "production container"
    reclaim_images
    log "already running image $SHORT_REVISION; no update needed"
    exit 0
  fi

  CURRENT_SHORT=
  if [[ -n "$CURRENT_IMAGE_ID" ]]; then
    CURRENT_SHORT="$(short_id "$CURRENT_IMAGE_ID")"
  fi
  log "updating ${CURRENT_SHORT:-none} -> $SHORT_REVISION"

  CANDIDATE_CONTAINER="${CONTAINER_NAME}-candidate-${SHORT_REVISION}"
  CANDIDATE_VOLUME="${VOLUME_NAME}-candidate-${SHORT_REVISION}"
  podman volume create "$CANDIDATE_VOLUME" >/dev/null
  start_container \
    "$IMAGE" \
    "$CANDIDATE_CONTAINER" \
    "$CANDIDATE_VOLUME" \
    "127.0.0.1::8000" \
    no \
    "$TARGET_REVISION" >/dev/null

  CANDIDATE_BINDING="$(podman port "$CANDIDATE_CONTAINER" 8000/tcp | head -n 1)"
  CANDIDATE_PORT="${CANDIDATE_BINDING##*:}"
  [[ "$CANDIDATE_PORT" =~ ^[0-9]+$ ]] || die "could not determine candidate HTTP port: $CANDIDATE_BINDING"
  wait_for_ready "$CANDIDATE_CONTAINER" "http://127.0.0.1:${CANDIDATE_PORT}/api/health" "candidate container"

  podman rm -f "$CANDIDATE_CONTAINER" >/dev/null
  CANDIDATE_CONTAINER=
  podman volume rm -f "$CANDIDATE_VOLUME" >/dev/null
  CANDIDATE_VOLUME=

  PREVIOUS_CONTAINER=
  if container_exists "$CONTAINER_NAME"; then
    PREVIOUS_CONTAINER="${CONTAINER_NAME}-previous-$(date +%Y%m%d%H%M%S)"
    log "stopping previous production container"
    podman stop --time 15 "$CONTAINER_NAME" >/dev/null 2>&1 || true
    podman rename "$CONTAINER_NAME" "$PREVIOUS_CONTAINER"
  fi

  if ! start_container \
    "$IMAGE" \
    "$CONTAINER_NAME" \
    "$VOLUME_NAME" \
    "${BIND_ADDRESS}:${HOST_PORT}:8000" \
    always \
    "$TARGET_REVISION" >/dev/null; then
    log "could not start the replacement container"
    if [[ -n "$PREVIOUS_CONTAINER" ]]; then
      podman rename "$PREVIOUS_CONTAINER" "$CONTAINER_NAME"
      podman start "$CONTAINER_NAME" >/dev/null || true
    fi
    die "rollback attempted after replacement start failure"
  fi

  if ! wait_for_ready "$CONTAINER_NAME" "http://127.0.0.1:${HOST_PORT}/api/health" "replacement container"; then
    log "replacement failed its health check; rolling back"
    podman rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    if [[ -n "$PREVIOUS_CONTAINER" ]]; then
      podman rename "$PREVIOUS_CONTAINER" "$CONTAINER_NAME"
      podman start "$CONTAINER_NAME" >/dev/null || true
      wait_for_ready "$CONTAINER_NAME" "http://127.0.0.1:${HOST_PORT}/api/health" "rolled-back container" || true
    fi
    die "update rolled back because the replacement was unhealthy"
  fi

  if [[ -n "$PREVIOUS_CONTAINER" ]]; then
    podman rm "$PREVIOUS_CONTAINER" >/dev/null
  fi
  reclaim_images

  log "updated successfully to $SHORT_REVISION"
)
