#!/usr/bin/env bash
#
# Update the production Podman deployment from a trusted Git branch.
#
# This intentionally builds a candidate image from an isolated Git worktree,
# checks it with a disposable data volume, then replaces the production
# container only after the candidate is healthy. If the replacement fails, the
# previous container is renamed back and restarted.
set -Eeuo pipefail

REPO_DIR=${HDU_SNIPER_REPO_DIR:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"}
BRANCH=${HDU_SNIPER_BRANCH:-main}
REMOTE=${HDU_SNIPER_REMOTE:-origin}
CONTAINER_NAME=${HDU_SNIPER_CONTAINER_NAME:-hdu-library-sniper}
IMAGE_ALIAS=${HDU_SNIPER_IMAGE:-localhost/hdu-library-sniper:dev}
VOLUME_NAME=${HDU_SNIPER_VOLUME:-hdu-sniper-data}
ENV_FILE=${HDU_SNIPER_ENV_FILE:-"$REPO_DIR/.env.local"}
HOST_PORT=${HDU_SNIPER_HOST_PORT:-8000}
BIND_ADDRESS=${HDU_SNIPER_BIND_ADDRESS:-0.0.0.0}
READY_TIMEOUT_SECONDS=${HDU_SNIPER_READY_TIMEOUT_SECONDS:-45}
LOCK_FILE=${HDU_SNIPER_UPDATE_LOCK_FILE:-/run/hdu-library-sniper-auto-update.lock}

WORKTREE_DIR=
CANDIDATE_CONTAINER=
CANDIDATE_VOLUME=

log() {
  printf '[hdu-library-sniper auto-update] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

cleanup() {
  local status=$?
  if [[ -n "$CANDIDATE_CONTAINER" ]]; then
    podman rm -f "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "$CANDIDATE_VOLUME" ]]; then
    podman volume rm -f "$CANDIDATE_VOLUME" >/dev/null 2>&1 || true
  fi
  if [[ -n "$WORKTREE_DIR" ]]; then
    git -C "$REPO_DIR" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || rm -rf "$WORKTREE_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

container_exists() {
  podman container exists "$1"
}

container_running() {
  [[ "$(podman inspect --format '{{.State.Running}}' "$1" 2>/dev/null || printf false)" == "true" ]]
}

container_revision() {
  local revision
  revision="$(podman inspect --format '{{index .Config.Labels "com.hdu-library-sniper.source-revision"}}' "$1" 2>/dev/null || true)"
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
    --env HDU_BOOKING_SCHEDULER_INSTALLED=1
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
require_command git
require_command podman

[[ -d "$REPO_DIR/.git" ]] || die "Git repository not found: $REPO_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another update job is already running; skipping"
  exit 0
fi

git -C "$REPO_DIR" fetch --quiet "$REMOTE" "$BRANCH"
TARGET_REVISION="$(git -C "$REPO_DIR" rev-parse "$REMOTE/$BRANCH")"
SHORT_REVISION="${TARGET_REVISION:0:12}"
CURRENT_REVISION=
if container_exists "$CONTAINER_NAME"; then
  CURRENT_REVISION="$(container_revision "$CONTAINER_NAME")"
fi

if [[ "$CURRENT_REVISION" == "$TARGET_REVISION" ]]; then
  if ! container_running "$CONTAINER_NAME"; then
    log "current revision is installed but the service is stopped; starting it"
    podman start "$CONTAINER_NAME" >/dev/null
  fi
  wait_for_ready "$CONTAINER_NAME" "http://127.0.0.1:${HOST_PORT}/api/health" "production container"
  log "already running revision $SHORT_REVISION; no update needed"
  exit 0
fi

log "updating ${CURRENT_REVISION:-unversioned} -> $TARGET_REVISION"
WORKTREE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hdu-library-sniper-update.XXXXXX")"
git -C "$REPO_DIR" worktree add --quiet --detach "$WORKTREE_DIR" "$TARGET_REVISION"

CANDIDATE_IMAGE="${IMAGE_ALIAS%:*}:candidate-${SHORT_REVISION}"
log "building candidate image $CANDIDATE_IMAGE"
podman build \
  --pull=missing \
  --build-arg "SOURCE_REVISION=$TARGET_REVISION" \
  --file "$WORKTREE_DIR/Containerfile" \
  --tag "$CANDIDATE_IMAGE" \
  "$WORKTREE_DIR"

CANDIDATE_CONTAINER="${CONTAINER_NAME}-candidate-${SHORT_REVISION}"
CANDIDATE_VOLUME="${VOLUME_NAME}-candidate-${SHORT_REVISION}"
podman volume create "$CANDIDATE_VOLUME" >/dev/null
start_container \
  "$CANDIDATE_IMAGE" \
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
  "$CANDIDATE_IMAGE" \
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

podman tag "$CANDIDATE_IMAGE" "$IMAGE_ALIAS"
if [[ -n "$PREVIOUS_CONTAINER" ]]; then
  podman rm "$PREVIOUS_CONTAINER" >/dev/null
fi

log "updated successfully to $TARGET_REVISION"
