#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BACKUP_DIR=""
NO_RESTART=0
NO_SERVICE_CONTROL=0
SYSTEM_WATCHER_UNIT="napm-syslog-watcher.service"
USER_WATCHER_UNIT="napm-syslog-watcher.service"
SYSTEM_WATCHER_FROZEN_PID=""
SYSTEM_WATCHER_CONTROL="none"

usage() {
  cat <<'EOF'
Usage: bash scripts/rollback-release.sh --backup-dir <path> [--no-restart] [--no-service-control]

  --backup-dir   Deployment backup directory created by install-release.sh.
  --no-restart   Restore files but leave services stopped.
  --no-service-control  Do not stop or start services; only for isolated tests.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir)
      [[ $# -ge 2 ]] || { echo "--backup-dir requires a path" >&2; exit 2; }
      BACKUP_DIR="$2"
      shift
      ;;
    --no-restart) NO_RESTART=1 ;;
    --no-service-control) NO_SERVICE_CONTROL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[[ -n "$BACKUP_DIR" ]] || { usage >&2; exit 2; }

for command_name in id ps realpath sha256sum tar systemctl xargs; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command not found: $command_name" >&2
    exit 1
  }
done

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
OPENCLAW_HOME="$(realpath -m "$OPENCLAW_HOME")"
BACKUP_BASE="$(realpath -m "$OPENCLAW_HOME/deploy_backups")"
BACKUP_DIR="$(realpath -m "$BACKUP_DIR")"
case "$BACKUP_DIR/" in
  "$BACKUP_BASE"/*/) ;;
  *) echo "Backup directory must be inside $BACKUP_BASE" >&2; exit 1 ;;
esac

ARCHIVE="$BACKUP_DIR/runtime-before-deploy.tgz"
CHECKSUM_FILE="$BACKUP_DIR/runtime-before-deploy.sha256"
TARGETS_FILE="$BACKUP_DIR/managed-targets.txt"
STATE_FILE="$BACKUP_DIR/runtime-state.txt"

for required_path in "$ARCHIVE" "$CHECKSUM_FILE" "$TARGETS_FILE" "$STATE_FILE"; do
  [[ -f "$required_path" ]] || {
    echo "Rollback backup is incomplete: $required_path" >&2
    exit 1
  }
done

(cd "$BACKUP_DIR" && sha256sum -c "$(basename "$CHECKSUM_FILE")")
tar -tzf "$ARCHIVE" >/dev/null

is_allowed_target() {
  local target="$1"
  case "$target" in
    extensions/napm-openclaw-plugin|workspace/node_modules) return 0 ;;
    workspace/config|workspace/references|workspace/src|workspace/tools) return 0 ;;
    workspace/AGENTS.md|workspace/CLAUDE.md|workspace/CONTEXT.md|workspace/HEARTBEAT.md) return 0 ;;
    workspace/IDENTITY.md|workspace/MEMORY.md|workspace/PROJECT.md|workspace/README.md) return 0 ;;
    workspace/SOUL.md|workspace/TOOLS.md|workspace/USER.md|workspace/openai.yaml) return 0 ;;
    workspace/package.json|workspace/package-lock.json|workspace/RELEASE-MANIFEST.json) return 0 ;;
  esac
  [[ "$target" =~ ^workspace/skills/[A-Za-z0-9._-]+$ ]]
}

while IFS= read -r target; do
  [[ -n "$target" ]] || continue
  if ! is_allowed_target "$target"; then
    echo "Rollback target is not allowed: $target" >&2
    exit 1
  fi
  resolved_target="$(realpath -m "$OPENCLAW_HOME/$target")"
  case "$resolved_target/" in
    "$OPENCLAW_HOME"/*/) ;;
    *) echo "Rollback target escaped OPENCLAW_HOME: $target" >&2; exit 1 ;;
  esac
done < "$TARGETS_FILE"

is_running_state() {
  case "$1" in
    active|activating|reloading) return 0 ;;
    *) return 1 ;;
  esac
}

system_watcher_state() {
  systemctl is-active "$SYSTEM_WATCHER_UNIT" 2>/dev/null || true
}

system_watcher_main_pid() {
  local pid
  pid="$(systemctl show "$SYSTEM_WATCHER_UNIT" -p MainPID --value 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || pid=0
  printf '%s' "$pid"
}

wait_for_system_watcher() {
  local expected_pid="${1:-}" attempt state pid cwd
  for attempt in $(seq 1 30); do
    state="$(system_watcher_state)"
    pid="$(system_watcher_main_pid)"
    if is_running_state "$state" && [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
      cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
      [[ "$cwd" == *"(deleted)"* ]] || {
        [[ -z "$expected_pid" || "$pid" != "$expected_pid" ]] && return 0
      }
    fi
    sleep 1
  done
  echo "System watcher did not become healthy after rollback: state=$(system_watcher_state) pid=$(system_watcher_main_pid)" >&2
  return 1
}

stop_system_watcher() {
  local pid pid_user pid_args
  if systemctl stop "$SYSTEM_WATCHER_UNIT" >/dev/null 2>&1; then
    SYSTEM_WATCHER_CONTROL="systemctl"
    return 0
  fi

  pid="$(system_watcher_main_pid)"
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
    pid_user="$(ps -o user= -p "$pid" 2>/dev/null | xargs)"
    pid_args="$(ps -o args= -p "$pid" 2>/dev/null || true)"
    [[ "$pid_user" == "$(id -un)" && "$pid_args" == *"run_syslog_watcher.js"* ]] || {
      echo "Refusing to signal unexpected system watcher MainPID=$pid during rollback." >&2
      return 1
    }
    kill -STOP "$pid"
    SYSTEM_WATCHER_FROZEN_PID="$pid"
    SYSTEM_WATCHER_CONTROL="frozen-process"
    return 0
  fi

  if [[ "$(system_watcher_state)" == "activating" || "$(system_watcher_state)" == "failed" ]]; then
    SYSTEM_WATCHER_CONTROL="auto-restart"
    return 0
  fi

  echo "Unable to stop system watcher during rollback." >&2
  return 1
}

start_system_watcher() {
  case "$SYSTEM_WATCHER_CONTROL" in
    systemctl)
      systemctl start "$SYSTEM_WATCHER_UNIT" >/dev/null 2>&1 || return 1
      ;;
    frozen-process)
      kill -CONT "$SYSTEM_WATCHER_FROZEN_PID" 2>/dev/null || true
      kill -TERM "$SYSTEM_WATCHER_FROZEN_PID" 2>/dev/null || true
      ;;
    auto-restart) ;;
    none) return 0 ;;
  esac
  wait_for_system_watcher "$SYSTEM_WATCHER_FROZEN_PID"
}

read_state() {
  local key="$1"
  local value
  value="$(sed -n "s/^$key=//p" "$STATE_FILE" | tail -n 1)"
  printf '%s' "$value"
}

gateway_was_active="$(read_state gateway_active)"
watcher_scope="$(read_state watcher_scope)"
system_watcher_was_active="$(read_state system_watcher_active)"
user_watcher_was_active="$(read_state user_watcher_active)"

# Backward compatibility with backups created before system-level watcher
# detection was added.
if [[ -z "$watcher_scope" ]]; then
  legacy_watcher_state="$(read_state watcher_active)"
  if [[ "$legacy_watcher_state" == "active" ]]; then
    watcher_scope="user"
    user_watcher_was_active="$legacy_watcher_state"
  else
    watcher_scope="none"
  fi
fi

if [[ "$NO_SERVICE_CONTROL" -eq 0 ]]; then
  systemctl --user stop openclaw-gateway.service 2>/dev/null || true
  if [[ "$watcher_scope" == "system" ]]; then
    stop_system_watcher
  elif [[ "$watcher_scope" == "user" ]]; then
    systemctl --user stop "$USER_WATCHER_UNIT" 2>/dev/null || true
  fi
fi

failed_archive="$BACKUP_DIR/failed-runtime-before-rollback-$(date +%Y%m%d_%H%M%S).tgz"
current_targets="$BACKUP_DIR/current-targets-before-rollback.txt"
: > "$current_targets"
while IFS= read -r target; do
  [[ ! -e "$OPENCLAW_HOME/$target" ]] || printf '%s\n' "$target" >> "$current_targets"
done < "$TARGETS_FILE"
if [[ -s "$current_targets" ]]; then
  tar -czf "$failed_archive" -C "$OPENCLAW_HOME" -T "$current_targets"
fi

while IFS= read -r target; do
  [[ -n "$target" ]] || continue
  rm -rf -- "$OPENCLAW_HOME/$target"
done < "$TARGETS_FILE"

tar -xzf "$ARCHIVE" -C "$OPENCLAW_HOME"

if [[ "$NO_RESTART" -eq 0 && "$NO_SERVICE_CONTROL" -eq 0 ]]; then
  if [[ "$gateway_was_active" == "active" ]]; then
    systemctl --user start openclaw-gateway.service
    systemctl --user is-active --quiet openclaw-gateway.service
  fi
  if [[ "$watcher_scope" == "system" ]]; then
    start_system_watcher
  elif [[ "$watcher_scope" == "user" && "$user_watcher_was_active" == "active" ]]; then
    systemctl --user start "$USER_WATCHER_UNIT"
    systemctl --user is-active --quiet "$USER_WATCHER_UNIT"
  fi
fi

echo "Rollback complete."
echo "Restored backup: $BACKUP_DIR"
if [[ -f "$failed_archive" ]]; then
  echo "Failed deployment snapshot: $failed_archive"
fi
