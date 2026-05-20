# Capability Mapping (Direct Skill Runtime)

## Purpose

Map the active skill-local modules into the current OpenClaw NAPM direct-query runtime.

```text
OpenClaw resolvedQuery / session
  -> Input normalization and runtime guard
  -> Metadata resolution and validation
  -> Query execution
  -> Narration contract output
```

The removed project gateway layer is no longer part of the active request path. This document should describe only the modules that still exist in `skills/openclaw-napm-query/`.

## Layer-to-Module Mapping

### 1. Input Normalization and Runtime Guard

Primary responsibility:

- accept structured `resolvedQuery` as the standard execution contract
- normalize `metric` / `metrics`, `topCount`, `topMetric`, and `granularity`
- merge continuation context from runtime session state when available
- return Chinese fallback payloads for missing executable query or blocked execution
- keep only execution-side guardrails such as sensitive-credential refusal and structured continuation merge

Relevant modules and scripts:

- `scripts/run_napm_query.js`
- `RequirementParserService.js`
- `ClarificationGateService.js`

Expected output:

- executable `resolvedQuery`, or
- machine-readable decision-style payload when execution should not continue

### 2. Metadata Resolution and Validation

Primary responsibility:

- resolve metric aliases and dimension names into executable NAPM query fields
- build or repair group chains
- confirm runtime metadata compatibility
- apply validation and execution guardrails before calling NAPM

Relevant modules:

- `MetricMappingService.js`
- `DimensionMappingService.js`
- `GroupBuilder.js`
- `NapmMetadataService.js`
- `QueryMetadataConstraintService.js`
- `QueryValidator.js`

Expected output:

- validated metric / group / argument shape that can be executed safely

### 3. Query Execution

Primary responsibility:

- execute metadata services such as `groups`, `metrics`, `groupArguments`, and `metricsForGroup`
- execute data services such as `topValues`, `averageValues`, and `timeValues`
- run overview expansion when the resolved query enters overview mode

Relevant modules and scripts:

- `RequirementParserService.js`
- `NapmClient.js`
- `scripts/run_napm_query.js`
- `scripts/overview-module.js`

Expected output:

- structured rows, series, overview aggregates, or metadata result sets

### 4. Narration Contract

Primary responsibility:

- convert execution result into OpenClaw-facing machine payload
- preserve time range, summary, empty-result explanation, and follow-up hints
- avoid raw JSON acknowledgement and `[object Object]` style output

Relevant modules:

- `OpenClawNarrationContractService.js`

Preferred narration source:

1. `narrationInput.result.narrationStructure`
2. `narrationInput.result.timeRange` or `narrationInput.summary.timeRange`
3. structured rows / series / overview data
4. `narrationInput.summary`
5. `displayText` or `replyText` only as fallback

## Input Modes

The current runner supports:

1. standard structured execution via `--resolvedQuery`, `--query`, or `payload.resolvedQuery`
2. optional companion fields:
   - `decision`
   - `intent`
   - `session` via `--session`, `payload.session`, or `payload.sessionState`

Notes:

- `resolvedQuery` is the normal execution contract.
- Missing `decision` must not block execution.
- Local prompt parsing is not part of the active runtime contract.

## Boundary

- Do not depend on removed gateway routes, project-level `src/services`, or deleted skill-local modules.
- Do not treat `topValues / averageValues / timeValues` as the first-level planner intent.
- Keep NAPM credentials in environment or runtime configuration, not in the reference files.
- OpenClaw remains the owner of top-level NLU, scope judgement, and final user-facing narration.
