#!/usr/bin/env bash
set -Eeuo pipefail

SKIP_DEPENDENCIES=0
EXTENSION_VERIFY_DIR=""
WORKSPACE_VERIFY_DIR=""

cleanup() {
  if [[ -n "$EXTENSION_VERIFY_DIR" && -d "$EXTENSION_VERIFY_DIR" ]]; then
    case "$EXTENSION_VERIFY_DIR/" in
      /tmp/napm-extension-verify-*/) rm -rf -- "$EXTENSION_VERIFY_DIR" ;;
      *) echo "Refusing to remove unexpected extension verification directory: $EXTENSION_VERIFY_DIR" >&2 ;;
    esac
  fi
  if [[ -n "$WORKSPACE_VERIFY_DIR" && -d "$WORKSPACE_VERIFY_DIR" ]]; then
    case "$WORKSPACE_VERIFY_DIR/" in
      /tmp/napm-workspace-verify-*/) rm -rf -- "$WORKSPACE_VERIFY_DIR" ;;
      *) echo "Refusing to remove unexpected workspace verification directory: $WORKSPACE_VERIFY_DIR" >&2 ;;
    esac
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: bash scripts/verify-staged-release.sh [--skip-dependencies]

Runs checks entirely inside an extracted release directory. It does not touch
the active OpenClaw workspace, extension, services, or private configuration.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-dependencies) SKIP_DEPENDENCIES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

for command_name in bash find grep install mktemp node npm realpath rsync; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command not found: $command_name" >&2
    exit 1
  }
done

RELEASE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="$RELEASE_ROOT/RELEASE-MANIFEST.json"

for required_path in \
  "$MANIFEST_PATH" \
  "$RELEASE_ROOT/package.json" \
  "$RELEASE_ROOT/package-lock.json" \
  "$RELEASE_ROOT/openclaw.plugin.json" \
  "$RELEASE_ROOT/napm-openclaw-plugin.remote.js" \
  "$RELEASE_ROOT/plugin" \
  "$RELEASE_ROOT/skills" \
  "$RELEASE_ROOT/scripts/verify-napm-skill-runtime-contract.js"; do
  [[ -e "$required_path" ]] || {
    echo "Release package is incomplete: $required_path" >&2
    exit 1
  }
done
[[ -f "$RELEASE_ROOT/scripts/stage-openclaw-extension.sh" ]] || {
  echo "Release package is missing extension staging script" >&2
  exit 1
}
[[ -f "$RELEASE_ROOT/scripts/verify-openclaw-extension-runtime.js" ]] || {
  echo "Release package is missing extension runtime verifier" >&2
  exit 1
}

node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""));
  if (manifest.schema !== "gaiop_napm_release.v1") throw new Error("Unsupported release manifest schema");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(manifest.version || ""))) throw new Error("Invalid release version");
  if (!/^[0-9a-f]{40}$/.test(String(manifest.commit || ""))) throw new Error("Invalid release commit");
' "$MANIFEST_PATH"

for forbidden_name in .env watcher.config.json alert_packet_query.json; do
  if find "$RELEASE_ROOT" -type f -name "$forbidden_name" -print -quit | grep -q .; then
    echo "Forbidden runtime file found in release: $forbidden_name" >&2
    exit 1
  fi
done
for forbidden_dir in logs output data; do
  if find "$RELEASE_ROOT/skills" -type d -name "$forbidden_dir" -print -quit | grep -q .; then
    echo "Forbidden runtime directory found in release: $forbidden_dir" >&2
    exit 1
  fi
done
if find "$RELEASE_ROOT" -type f \( -name 'query_*.json' -o -name '*.docx' -o -name '*.log' \) -print -quit | grep -q .; then
  echo "Forbidden generated artifact found in release." >&2
  exit 1
fi

if [[ "$SKIP_DEPENDENCIES" -eq 0 ]]; then
  (cd "$RELEASE_ROOT" && npm ci --omit=dev)
fi

node --check "$RELEASE_ROOT/napm-openclaw-plugin.remote.js"
OPENCLAW_SKILLS_ROOT="$RELEASE_ROOT/skills" \
  node "$RELEASE_ROOT/scripts/verify-napm-skill-runtime-contract.js"

WORKSPACE_VERIFY_DIR="$(mktemp -d /tmp/napm-workspace-verify-XXXXXXXX)"
mkdir -p "$WORKSPACE_VERIFY_DIR/skills" "$WORKSPACE_VERIFY_DIR/plugin"
rsync -a --delete "$RELEASE_ROOT/skills/" "$WORKSPACE_VERIFY_DIR/skills/"
rsync -a --delete "$RELEASE_ROOT/plugin/" "$WORKSPACE_VERIFY_DIR/plugin/"
NODE_PATH="$RELEASE_ROOT/node_modules" \
OPENCLAW_SKILLS_ROOT="$WORKSPACE_VERIFY_DIR/skills" \
  node "$RELEASE_ROOT/scripts/verify-napm-skill-runtime-contract.js"

EXTENSION_VERIFY_DIR="$(mktemp -d /tmp/napm-extension-verify-XXXXXXXX)"
bash "$RELEASE_ROOT/scripts/stage-openclaw-extension.sh" "$RELEASE_ROOT" "$EXTENSION_VERIFY_DIR"
node "$RELEASE_ROOT/scripts/verify-openclaw-extension-runtime.js" \
  --extensionRoot "$EXTENSION_VERIFY_DIR" \
  --skillsRoot "$RELEASE_ROOT/skills"

echo "Staged release verification complete. Active OpenClaw files were not changed."
