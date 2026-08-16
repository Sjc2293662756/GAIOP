#!/usr/bin/env bash
set -Eeuo pipefail

: "${WECOM_WEBHOOK_URL:?WECOM_WEBHOOK_URL is required}"

payload_file="$(mktemp)"
trap 'rm -f "$payload_file"' EXIT

cat >"$payload_file" <<'EOF'
{"msgtype":"markdown","markdown":{"content":"test\n\n```\nhello world\n```"}}
EOF

curl --fail --silent --show-error \
  -X POST "$WECOM_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  --data-binary "@$payload_file"
