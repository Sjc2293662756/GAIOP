#!/usr/bin/env bash
set -Eeuo pipefail

DRY_RUN=0
SKIP_RESTART=0
NO_SERVICE_CONTROL=0
MUTATION_STARTED=0
BACKUP_DIR=""
EXTENSION_STAGE=""

usage() {
  cat <<'EOF'
Usage: bash scripts/install-release.sh [--dry-run] [--skip-restart] [--no-service-control]

  --dry-run       Validate the package and print deployment targets only.
  --skip-restart  Allowed only when managed services are already inactive.
  --no-service-control  Only for isolated homes outside the active .openclaw.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-restart) SKIP_RESTART=1 ;;
    --no-service-control) NO_SERVICE_CONTROL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

for command_name in install mktemp node npm realpath rsync sha256sum tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command not found: $command_name" >&2
    exit 1
  }
done

RELEASE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="$RELEASE_ROOT/RELEASE-MANIFEST.json"
ROLLBACK_SCRIPT="$RELEASE_ROOT/scripts/rollback-release.sh"
STAGE_EXTENSION_SCRIPT="$RELEASE_ROOT/scripts/stage-openclaw-extension.sh"
VERIFY_EXTENSION_RUNTIME_SCRIPT="$RELEASE_ROOT/scripts/verify-openclaw-extension-runtime.js"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
OPENCLAW_HOME="$(realpath -m "$OPENCLAW_HOME")"
ACTIVE_OPENCLAW_HOME="$(realpath -m "$HOME/.openclaw")"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE:-$OPENCLAW_HOME/workspace}"
WORKSPACE_DIR="$(realpath -m "$WORKSPACE_DIR")"
EXTENSION_DIR="$OPENCLAW_HOME/extensions/napm-openclaw-plugin"

case "$WORKSPACE_DIR/" in
  "$OPENCLAW_HOME"/*/) ;;
  *) echo "Workspace must be inside OPENCLAW_HOME: $WORKSPACE_DIR" >&2; exit 1 ;;
esac
[[ "$WORKSPACE_DIR" == "$OPENCLAW_HOME/workspace" ]] || {
  echo "Custom workspace paths are not supported by the rollback contract: $WORKSPACE_DIR" >&2
  exit 1
}
if [[ "$NO_SERVICE_CONTROL" -eq 1 && "$OPENCLAW_HOME" == "$ACTIVE_OPENCLAW_HOME" ]]; then
  echo "--no-service-control is refused for the active OpenClaw home." >&2
  exit 1
fi
if [[ "$NO_SERVICE_CONTROL" -eq 0 ]]; then
  command -v systemctl >/dev/null 2>&1 || {
    echo "Required command not found: systemctl" >&2
    exit 1
  }
fi

for required_path in \
  "$MANIFEST_PATH" \
  "$RELEASE_ROOT/package.json" \
  "$RELEASE_ROOT/package-lock.json" \
  "$RELEASE_ROOT/openclaw.plugin.json" \
  "$RELEASE_ROOT/napm-openclaw-plugin.remote.js" \
  "$RELEASE_ROOT/napm-openclaw-plugin.index.mjs" \
  "$RELEASE_ROOT/napm-openclaw-plugin.package.json" \
  "$RELEASE_ROOT/plugin" \
  "$RELEASE_ROOT/skills" \
  "$ROLLBACK_SCRIPT" \
  "$RELEASE_ROOT/scripts/verify-napm-skill-runtime-contract.js"; do
  [[ -e "$required_path" ]] || {
    echo "Release package is incomplete: $required_path" >&2
    exit 1
  }
done
[[ -f "$STAGE_EXTENSION_SCRIPT" ]] || { echo "Missing extension staging script: $STAGE_EXTENSION_SCRIPT" >&2; exit 1; }
[[ -f "$VERIFY_EXTENSION_RUNTIME_SCRIPT" ]] || { echo "Missing extension runtime verifier: $VERIFY_EXTENSION_RUNTIME_SCRIPT" >&2; exit 1; }

read_manifest_field() {
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""));
    const value = manifest[process.argv[2]];
    if (value == null || value === "") process.exit(2);
    process.stdout.write(String(value));
  ' "$MANIFEST_PATH" "$1"
}

VERSION="$(read_manifest_field version)"
COMMIT="$(read_manifest_field commit)"
SHORT_COMMIT="${COMMIT:0:8}"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid release commit: $COMMIT" >&2; exit 1; }

if [[ "$NO_SERVICE_CONTROL" -eq 1 ]]; then
  gateway_state="inactive"
  watcher_state="inactive"
else
  gateway_state="$(systemctl --user is-active openclaw-gateway.service 2>/dev/null || true)"
  watcher_state="$(systemctl --user is-active napm-syslog-watcher.service 2>/dev/null || true)"
fi

echo "NAPM release: $VERSION ($SHORT_COMMIT)"
echo "Source:       $RELEASE_ROOT"
echo "Workspace:    $WORKSPACE_DIR"
echo "Extension:    $EXTENSION_DIR"
echo "Gateway:      $gateway_state"
echo "Watcher:      $watcher_state"
echo "Preserved:    .env, logs, output, runtime data, watcher.config.json"

if [[ "$SKIP_RESTART" -eq 1 && ( "$gateway_state" == "active" || "$watcher_state" == "active" ) ]]; then
  echo "--skip-restart is refused while managed services are active." >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  node --check "$RELEASE_ROOT/napm-openclaw-plugin.remote.js"
  echo "Dry run complete. No files were changed."
  exit 0
fi

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="$OPENCLAW_HOME/deploy_backups/${TIMESTAMP}_napm_${VERSION}_${SHORT_COMMIT}"
MANAGED_TARGETS="$BACKUP_DIR/managed-targets.txt"
EXISTING_TARGETS="$BACKUP_DIR/existing-targets.txt"
BACKUP_ARCHIVE="$BACKUP_DIR/runtime-before-deploy.tgz"
mkdir -p "$BACKUP_DIR"
: > "$MANAGED_TARGETS"

add_managed_target() {
  local target="$1"
  grep -Fxq "$target" "$MANAGED_TARGETS" 2>/dev/null || printf '%s\n' "$target" >> "$MANAGED_TARGETS"
}

add_managed_target "extensions/napm-openclaw-plugin"
add_managed_target "workspace/plugin"
add_managed_target "workspace/node_modules"
add_managed_target "workspace/RELEASE-MANIFEST.json"

for skill_source in "$RELEASE_ROOT"/skills/*; do
  [[ -d "$skill_source" ]] || continue
  skill_name="$(basename "$skill_source")"
  [[ "$skill_name" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "Invalid Skill directory name: $skill_name" >&2
    exit 1
  }
  add_managed_target "workspace/skills/$skill_name"
done

for workspace_file in \
  AGENTS.md CLAUDE.md CONTEXT.md HEARTBEAT.md IDENTITY.md MEMORY.md \
  PROJECT.md README.md SOUL.md TOOLS.md USER.md openai.yaml package.json package-lock.json; do
  [[ ! -f "$RELEASE_ROOT/$workspace_file" ]] || add_managed_target "workspace/$workspace_file"
done

for workspace_directory in config references src tools; do
  [[ ! -d "$RELEASE_ROOT/$workspace_directory" ]] || add_managed_target "workspace/$workspace_directory"
done

: > "$EXISTING_TARGETS"
while IFS= read -r target; do
  [[ ! -e "$OPENCLAW_HOME/$target" ]] || printf '%s\n' "$target" >> "$EXISTING_TARGETS"
done < "$MANAGED_TARGETS"

if [[ -s "$EXISTING_TARGETS" ]]; then
  tar -czf "$BACKUP_ARCHIVE" -C "$OPENCLAW_HOME" -T "$EXISTING_TARGETS"
else
  tar -czf "$BACKUP_ARCHIVE" --files-from /dev/null
fi
(cd "$BACKUP_DIR" && sha256sum "$(basename "$BACKUP_ARCHIVE")" > runtime-before-deploy.sha256)
cp "$MANIFEST_PATH" "$BACKUP_DIR/release-manifest.json"
cp "$ROLLBACK_SCRIPT" "$BACKUP_DIR/rollback-release.sh"
{
  printf 'captured_at=%s\n' "$(date --iso-8601=seconds)"
  printf 'gateway_active=%s\n' "$gateway_state"
  printf 'watcher_active=%s\n' "$watcher_state"
} > "$BACKUP_DIR/runtime-state.txt"
chmod 700 "$BACKUP_DIR"
chmod 600 "$BACKUP_DIR"/*
chmod 700 "$BACKUP_DIR/rollback-release.sh"

cleanup_temp() {
  if [[ -n "$EXTENSION_STAGE" && -d "$EXTENSION_STAGE" ]]; then
    case "$EXTENSION_STAGE/" in
      /tmp/napm-extension-stage-*/) rm -rf -- "$EXTENSION_STAGE" ;;
      *) echo "Refusing to remove unexpected extension stage: $EXTENSION_STAGE" >&2 ;;
    esac
  fi
}

on_error() {
  local exit_code=$?
  trap - ERR
  set +e
  cleanup_temp
  if [[ "$MUTATION_STARTED" -eq 1 ]]; then
    echo "Deployment failed; restoring the previous runtime." >&2
    rollback_args=(--backup-dir "$BACKUP_DIR")
    if [[ "$SKIP_RESTART" -eq 1 ]]; then
      rollback_args+=(--no-restart)
    fi
    if [[ "$NO_SERVICE_CONTROL" -eq 1 ]]; then
      rollback_args+=(--no-service-control)
    fi
    bash "$ROLLBACK_SCRIPT" "${rollback_args[@]}"
    rollback_code=$?
    if [[ "$rollback_code" -ne 0 ]]; then
      echo "Automatic rollback also failed. Keep services stopped and inspect: $BACKUP_DIR" >&2
    fi
  fi
  exit "$exit_code"
}

trap cleanup_temp EXIT
trap on_error ERR

MUTATION_STARTED=1
if [[ "$NO_SERVICE_CONTROL" -eq 0 && "$gateway_state" == "active" ]]; then
  systemctl --user stop openclaw-gateway.service
fi
if [[ "$NO_SERVICE_CONTROL" -eq 0 && "$watcher_state" == "active" ]]; then
  systemctl --user stop napm-syslog-watcher.service
fi

mkdir -p "$WORKSPACE_DIR/skills" "$WORKSPACE_DIR/plugin" "$EXTENSION_DIR"

rsync -a --delete "$RELEASE_ROOT/plugin/" "$WORKSPACE_DIR/plugin/"

rsync_options=(
  -a
  --delete
  --exclude=.env
  --exclude=logs/
  --exclude=output/
  --exclude=data/
  --exclude='query_*.json'
  --exclude=alert_packet_query.json
  --exclude=config/watcher.config.json
)

for skill_source in "$RELEASE_ROOT"/skills/*; do
  [[ -d "$skill_source" ]] || continue
  skill_name="$(basename "$skill_source")"
  mkdir -p "$WORKSPACE_DIR/skills/$skill_name"
  rsync "${rsync_options[@]}" "$skill_source/" "$WORKSPACE_DIR/skills/$skill_name/"
done

for workspace_file in \
  AGENTS.md CLAUDE.md CONTEXT.md HEARTBEAT.md IDENTITY.md MEMORY.md \
  PROJECT.md README.md SOUL.md TOOLS.md USER.md openai.yaml package.json package-lock.json; do
  if [[ -f "$RELEASE_ROOT/$workspace_file" ]]; then
    install -m 0644 "$RELEASE_ROOT/$workspace_file" "$WORKSPACE_DIR/$workspace_file"
  fi
done
install -m 0644 "$MANIFEST_PATH" "$WORKSPACE_DIR/RELEASE-MANIFEST.json"

for workspace_directory in config references src tools; do
  if [[ -d "$RELEASE_ROOT/$workspace_directory" ]]; then
    mkdir -p "$WORKSPACE_DIR/$workspace_directory"
    rsync -a --delete "$RELEASE_ROOT/$workspace_directory/" "$WORKSPACE_DIR/$workspace_directory/"
  fi
done

EXTENSION_STAGE="$(mktemp -d /tmp/napm-extension-stage-XXXXXXXX)"
bash "$STAGE_EXTENSION_SCRIPT" "$RELEASE_ROOT" "$EXTENSION_STAGE"

rsync -a --delete --exclude=node_modules/ "$EXTENSION_STAGE/" "$EXTENSION_DIR/"
cleanup_temp
EXTENSION_STAGE=""

(cd "$WORKSPACE_DIR" && npm ci --omit=dev)
node --check "$EXTENSION_DIR/index.js"
OPENCLAW_SKILLS_ROOT="$WORKSPACE_DIR/skills" \
  node "$RELEASE_ROOT/scripts/verify-napm-skill-runtime-contract.js"
node "$VERIFY_EXTENSION_RUNTIME_SCRIPT" \
  --extensionRoot "$EXTENSION_DIR" \
  --skillsRoot "$WORKSPACE_DIR/skills"

if [[ "$SKIP_RESTART" -eq 0 && "$NO_SERVICE_CONTROL" -eq 0 ]]; then
  if [[ "$gateway_state" == "active" ]]; then
    systemctl --user start openclaw-gateway.service
    systemctl --user is-active --quiet openclaw-gateway.service
  fi
  if [[ "$watcher_state" == "active" ]]; then
    systemctl --user start napm-syslog-watcher.service
    systemctl --user is-active --quiet napm-syslog-watcher.service
  fi
fi

trap - ERR
MUTATION_STARTED=0
echo "Deployment complete: $VERSION ($SHORT_COMMIT)"
echo "Backup: $BACKUP_DIR/runtime-before-deploy.tgz"
