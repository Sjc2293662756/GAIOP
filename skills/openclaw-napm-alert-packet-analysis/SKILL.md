---
name: openclaw-napm-alert-packet-analysis
description: Deterministic OpenClaw workflow for a specified NAPM alert event that must query alertsDetail with bounded consistency retries and then analyze the returned packet candidates with the existing packet-analysis Skill.
---

# OpenClaw NAPM Alert Packet Analysis

Use this Skill only for combined alert and packet requests that contain a numeric `eventId` and a fixed Unix-second `start/end` window.

The JavaScript runtime owns the complete sequence:

1. Parse and validate `eventId/start/end/triggerMetrics` from the canonical prompt.
2. Query `openclaw-napm-alert-query` with `mode=detail` only.
3. Retry a successful but empty detail result at bounded delays `0/2/4/8` seconds.
4. Consume only `packetInstruction` or `packetHandoff` `suggestedPacketQuery` values.
5. Call `openclaw-napm-packet-analysis` in-process for each bounded candidate.
6. Return one composite structured result for the current OpenClaw turn.

Never use `alertsSummary`, `mode=analysis`, `mode=summary`, `mode=timeline`, `timeRange.key`, shell/curl, guessed IP addresses, or alert `eventId` as a packet ID unless the alert Skill explicitly supplies it in `suggestedPacketQuery`.

This Skill orchestrates the existing packet Skill. It does not change packet download or analysis algorithms.
