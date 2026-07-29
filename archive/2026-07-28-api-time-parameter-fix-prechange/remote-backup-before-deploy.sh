#!/bin/sh
set -eu

backup="/home/netinside/.openclaw/archive/2026-07-28-api-time-parameter-fix-deploy-$(date +%Y%m%dT%H%M%S%z)"

for label in workspace extension; do
  if [ "$label" = "workspace" ]; then
    root="/home/netinside/.openclaw/workspace"
  else
    root="/home/netinside/.openclaw/extensions/napm-openclaw-plugin"
  fi

  for rel in \
    napm-openclaw-plugin.remote.js \
    skills/openclaw-napm-query/services/ResolvedQueryTimeRangeService.js \
    skills/openclaw-napm-query/src/shared/timeResolver.js \
    skills/openclaw-napm-alert-query/scripts/run_alert_query.js \
    skills/openclaw-napm-summary/scripts/run_summary.js \
    skills/openclaw-napm-fault-diagnosis/scripts/run_fault_diagnosis.js \
    skills/openclaw-napm-summary/services/SummaryClient.js
  do
    if [ ! -f "$root/$rel" ]; then
      printf 'absent=%s/%s\n' "$label" "$rel"
      continue
    fi
    mkdir -p "$backup/$label/$(dirname "$rel")"
    cp -p "$root/$rel" "$backup/$label/$rel"
  done
done

printf 'backup=%s\n' "$backup"
find "$backup" -type f | wc -l
