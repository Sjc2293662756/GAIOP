#!/usr/bin/env bash
set -Eeuo pipefail

DRY_RUN=0
SKIP_RESTART=0

usage() {
  cat <<'EOF'
Usage: bash scripts/install-release.sh [--dry-run] [--skip-restart]

  --dry-run       Validate the package and print deployment targets only.
  --skip-restart  Install and verify files without restarting the gateway.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-restart) SKIP_RESTART=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

for command_name in node npm rsync tar systemctl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done

RELEASE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="$RELEASE_ROOT/RELEASE-MANIFEST.json"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE:-$OPENCLAW_HOME/workspace}"
EXTENSION_DIR="$OPENCLAW_HOME/extensions/napm-openclaw-plugin"

for required_path in \
  "$MANIFEST_PATH" \
  "$RELEASE_ROOT/package.json" \
  "$RELEASE_ROOT/package-lock.json" \
  "$RELEASE_ROOT/openclaw.plugin.json" \
  "$RELEASE_ROOT/napm-openclaw-plugin.remote.js" \
  "$RELEASE_ROOT/plugin" \
  "$RELEASE_ROOT/skills"; do
  if [[ ! -e "$required_path" ]]; then
    echo "Release package is incomplete: $required_path" >&2
    exit 1
  fi
done

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

echo "NAPM release: $VERSION ($SHORT_COMMIT)"
echo "Source:       $RELEASE_ROOT"
echo "Workspace:    $WORKSPACE_DIR"
echo "Extension:    $EXTENSION_DIR"
echo "Preserved:    .env, logs, output, runtime data, watcher.config.json"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run complete. No files were changed."
  exit 0
fi

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="$OPENCLAW_HOME/deploy_backups/${TIMESTAMP}_napm_${VERSION}_${SHORT_COMMIT}"
mkdir -p "$BACKUP_DIR"

backup_paths=()
for relative_path in \
  "extensions/napm-openclaw-plugin" \
  "workspace/skills" \
  "workspace/package.json" \
  "workspace/package-lock.json"; do
  if [[ -e "$OPENCLAW_HOME/$relative_path" ]]; then
    backup_paths+=("$relative_path")
  fi
done
if [[ ${#backup_paths[@]} -gt 0 ]]; then
  tar -czf "$BACKUP_DIR/runtime-before-deploy.tgz" -C "$OPENCLAW_HOME" "${backup_paths[@]}"
fi
cp "$MANIFEST_PATH" "$BACKUP_DIR/release-manifest.json"

on_error() {
  local exit_code=$?
  echo "Deployment failed with exit code $exit_code." >&2
  echo "Backup: $BACKUP_DIR/runtime-before-deploy.tgz" >&2
  exit "$exit_code"
}
trap on_error ERR

mkdir -p "$WORKSPACE_DIR/skills" "$EXTENSION_DIR"

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

for workspace_directory in config references src tools; do
  if [[ -d "$RELEASE_ROOT/$workspace_directory" ]]; then
    mkdir -p "$WORKSPACE_DIR/$workspace_directory"
    rsync -a --delete "$RELEASE_ROOT/$workspace_directory/" "$WORKSPACE_DIR/$workspace_directory/"
  fi
done

install -m 0644 "$RELEASE_ROOT/napm-openclaw-plugin.remote.js" "$EXTENSION_DIR/index.js"
install -m 0644 "$RELEASE_ROOT/napm-openclaw-plugin.remote.js" "$EXTENSION_DIR/napm-openclaw-plugin.remote.js"
install -m 0644 "$RELEASE_ROOT/napm-openclaw-plugin.index.mjs" "$EXTENSION_DIR/index.mjs"
install -m 0644 "$RELEASE_ROOT/napm-openclaw-plugin.package.json" "$EXTENSION_DIR/package.json"
install -m 0644 "$RELEASE_ROOT/openclaw.plugin.json" "$EXTENSION_DIR/openclaw.plugin.json"
mkdir -p "$EXTENSION_DIR/plugin"
rsync -a --delete "$RELEASE_ROOT/plugin/" "$EXTENSION_DIR/plugin/"

embedded_time_dir="$EXTENSION_DIR/skills/openclaw-napm-query/src/shared"
mkdir -p "$embedded_time_dir"
install -m 0644 \
  "$RELEASE_ROOT/skills/openclaw-napm-query/src/shared/timeResolver.js" \
  "$embedded_time_dir/timeResolver.js"

(cd "$WORKSPACE_DIR" && npm ci --omit=dev)
node --check "$EXTENSION_DIR/index.js"
OPENCLAW_SKILLS_ROOT="$WORKSPACE_DIR/skills" \
  node "$RELEASE_ROOT/scripts/verify-napm-skill-runtime-contract.js"

if [[ "$SKIP_RESTART" -eq 0 ]]; then
  systemctl --user restart openclaw-gateway.service
  systemctl --user is-active --quiet openclaw-gateway.service
fi

trap - ERR
echo "Deployment complete: $VERSION ($SHORT_COMMIT)"
echo "Backup: $BACKUP_DIR/runtime-before-deploy.tgz"
