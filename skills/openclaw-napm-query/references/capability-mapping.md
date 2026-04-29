# Capability Mapping (Decision-First v2)

## Purpose

Map existing gateway capabilities into a reusable skill runtime that follows:

`Decision -> Intent -> Metadata Resolution -> Execution -> Output`

The key migration rule is: keep old execution capabilities, but demote them to post-decision layers.

## Layer-to-Module Mapping

### 1) Decision Layer (new upstream layer)

Primary responsibility:

- session continuation detection
- scope boundary control
- task classification
- information sufficiency judgement
- next action selection

Expected outputs:

- `decision` object
- inheritance hints for subject/time/metric/group/result context

### 2) Intent Structuring Layer

Primary responsibility:

- convert request to intermediate intent for `query` / `analysis_entry`
- avoid producing final execution JSON at this step

Expected outputs:

- `intent` object with subject/time/metric/view hints

### 3) Metadata Resolution Layer (existing capabilities reused)

- `skills/openclaw-napm-query/services/RequirementParserService.js`
- `skills/openclaw-napm-query/services/MetricMappingService.js`
- `skills/openclaw-napm-query/services/GroupBuilder.js`
- `skills/openclaw-napm-query/services/QueryValidator.js`
- `src/utils/TimeUtils.js`

Primary responsibility:

- resolve subject existence and object type
- resolve metric and group mappings
- select service mode
- validate and repair safely

Expected outputs:

- final `resolvedQuery`

### 4) Query Execution Layer (existing capabilities reused)

- `skills/openclaw-napm-query/services/RequirementParserService.js` (`executeGatewayRequest`)
- `skills/openclaw-napm-query/services/NapmClient.js`
- `src/utils/CsvParser.js`

Primary responsibility:

- execute `topValues`, `averageValues`, `timeValues`
- return machine-readable rows

### 5) Result Interpretation / Output Layer

Primary responsibility:

- stable payload for OpenClaw
- support direct summary, empty results, interpretation mode, clarification mode, reject mode

## New Skill Contract (v2)

```json
{
  "ok": true,
  "decision": {},
  "intent": {},
  "resolvedQuery": {},
  "data": [],
  "summary": {},
  "error": null
}
```

Notes:

- `resolvedQuery` and `data` are optional for conceptual answer, clarification, rejection, and result-interpretation paths.
- `topValues/averageValues/timeValues` are execution internals and must not be used as entry routing categories.

## Input Modes

The skill executor supports:

1. raw prompt (`--prompt`)
2. structured input (`--payload`) containing any subset of:
   - `decision`
   - `intent`
   - `resolvedQuery`
   - `sessionState`

## Refactor Boundary

Keep this boundary unchanged:

- preserve existing mapping/validation/execution modules
- do not move Express routes into the skill
- do not include transport-layer behavior in skill runtime
