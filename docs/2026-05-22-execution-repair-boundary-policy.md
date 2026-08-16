# Execution Repair Boundary Policy

Date: 2026-05-22

## Background

The NAPM query chain previously had several execution-time repair paths after `resolvedQuery` was produced. That made it possible for a correct upstream `resolvedQuery` to be changed again by the skill runtime before execution.

The risky paths were:

- `run_napm_query.js`: session continuation and static path planning could rewrite `groups` / `pathPlanning` from prompt text.
- `RequirementParserService`: metadata finalization, path planning, stable templates, inventory fallback, and service fallback could alter the request.
- `QueryMetadataConstraintService`: missing or invalid metric/group values could be silently replaced with defaults such as `TPIO` and `IPAddress`.

The target boundary is:

- OpenClaw / mainflow resolver owns semantic construction of `resolvedQuery`.
- Skill runtime executes the explicit `resolvedQuery`.
- Execution layer may validate and normalize safe mechanical fields.
- Semantic repair is disabled by default and must be explicitly requested in `resolvedQuery`.

## Changes

### 1. `run_napm_query.js`

Default execution no longer performs prompt-based static path planning.

`applyStaticPathPlanningIfNeeded()` now only runs when one of these flags is present:

- `executionOptions.allowPathRepair === true`
- `executionHints.allowPathRepair === true`
- `pathPlanning.allowExecutionRepair === true`

Session continuation is also explicit now:

- `executionHints.inheritMetric === true` or `pathPlanning.followUpAction === "inherit_metric"` is required to inherit metric.
- `executionHints.inheritGroups === true` or `pathPlanning.followUpAction === "inherit_groups"` is required to inherit groups.
- `executionHints.inheritTimeRange === true` or `pathPlanning.followUpAction === "inherit_time_range"` is required to inherit time range.
- Prompt-only drilldown text no longer causes `groups` to be inferred during execution.

### 2. `RequirementParserService`

Execution-time semantic repair is gated by explicit flags.

New policy helpers:

- `shouldAllowPathRepair()`
- `shouldAllowMetadataRepair()`
- `shouldAllowServiceFallback()`
- `shouldAllowInventoryFallback()`
- `shouldAllowStableTemplateRepair()`

Default behavior:

- Static group path planning is skipped.
- Metadata-driven group argument fill is skipped.
- Metadata-driven metric replacement is skipped.
- Stable template bindings are skipped.
- Multilevel inventory fallback is skipped.
- Multilevel service fallback is skipped.

Explicit opt-in flags:

- `executionOptions.allowPathRepair === true`
- `executionOptions.allowMetadataRepair === true`
- `executionOptions.allowInventoryFallback === true`
- `executionOptions.allowServiceFallback === true`
- `executionOptions.allowStableTemplateRepair === true`

The same flags are also accepted under `executionHints` for compatibility with existing structured query hints.

### 3. `QueryMetadataConstraintService`

Semantic fallback is disabled by default.

Default behavior:

- Missing metric is not replaced with `TPIO`.
- Missing groups are not replaced with `IPAddress`.
- Invalid metric is preserved instead of being replaced.
- Unknown root group is preserved instead of being replaced.
- Incompatible metric/group pairs are reported in compatibility warnings but not rewritten.

Explicit opt-in:

- `executionOptions.allowMetadataRepair === true`
- `executionHints.allowMetadataRepair === true`

When opted in, legacy repair behavior remains available.

## Why This Matters

This prevents the common failure mode:

1. Resolver constructs the correct path, for example:
   `IPAddress(192.0.2.10) -> Applications -> DefinedApp`
2. Skill runtime sees words like "application" or "detail".
3. Runtime appends or replaces groups before calling NetInside.
4. The actual API request no longer matches the upstream `resolvedQuery`.

After this change, the execution layer preserves the upstream path unless repair is explicitly allowed.

## Test Coverage

Added and updated tests cover:

- Explicit multilevel path is preserved by default.
- Path planning only runs when `allowPathRepair` is set.
- Missing metric/group are not defaulted without `allowMetadataRepair`.
- Legacy metadata repair still works when explicitly enabled.
- Inventory and service fallback only run when explicitly enabled.
- Session continuation only inherits fields when requested.
- Full test suite passes.

Verification:

```text
npm test -- --runInBand
Test Suites: 28 passed, 28 total
Tests:       169 passed, 169 total
```

## Operational Guidance

Normal resolver-produced `resolvedQuery` should not include repair flags.

Only add repair flags for controlled migration or intentionally supported fallback flows. If a query cannot execute without repair, prefer fixing upstream resolution first and use execution repair only as an auditable exception.
