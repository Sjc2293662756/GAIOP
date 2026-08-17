#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: bash scripts/stage-openclaw-extension.sh <release-root> <extension-stage-dir>" >&2
  exit 2
fi

RELEASE_ROOT="$(realpath "$1")"
EXTENSION_STAGE="$(realpath -m "$2")"

case "$EXTENSION_STAGE/" in
  /tmp/napm-extension-stage-*/|/tmp/napm-extension-verify-*/) ;;
  *)
    echo "Extension stage must use a managed /tmp/napm-extension-* directory: $EXTENSION_STAGE" >&2
    exit 1
    ;;
esac

for required_path in \
  "$RELEASE_ROOT/napm-openclaw-plugin.remote.js" \
  "$RELEASE_ROOT/napm-openclaw-plugin.index.mjs" \
  "$RELEASE_ROOT/napm-openclaw-plugin.package.json" \
  "$RELEASE_ROOT/openclaw.plugin.json" \
  "$RELEASE_ROOT/RELEASE-MANIFEST.json" \
  "$RELEASE_ROOT/plugin"; do
  [[ -e "$required_path" ]] || {
    echo "Cannot stage extension; missing release path: $required_path" >&2
    exit 1
  }
done

mkdir -p "$EXTENSION_STAGE/plugin"
install -m 0644 "$RELEASE_ROOT/napm-openclaw-plugin.remote.js" "$EXTENSION_STAGE/index.js"
install -m 0644 "$RELEASE_ROOT/napm-openclaw-plugin.remote.js" "$EXTENSION_STAGE/napm-openclaw-plugin.remote.js"
install -m 0644 "$RELEASE_ROOT/napm-openclaw-plugin.index.mjs" "$EXTENSION_STAGE/index.mjs"
install -m 0644 "$RELEASE_ROOT/napm-openclaw-plugin.package.json" "$EXTENSION_STAGE/package.json"
install -m 0644 "$RELEASE_ROOT/openclaw.plugin.json" "$EXTENSION_STAGE/openclaw.plugin.json"
install -m 0644 "$RELEASE_ROOT/RELEASE-MANIFEST.json" "$EXTENSION_STAGE/RELEASE-MANIFEST.json"
rsync -a --delete "$RELEASE_ROOT/plugin/" "$EXTENSION_STAGE/plugin/"

if [[ -d "$EXTENSION_STAGE/skills" ]]; then
  echo "Extension stage must not contain a partial Skill runtime: $EXTENSION_STAGE/skills" >&2
  exit 1
fi
