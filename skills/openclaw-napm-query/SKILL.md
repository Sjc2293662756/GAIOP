---
name: openclaw-napm-query
description: Standalone OpenClaw skill for NetInside / NAPM structured queries. Use when OpenClaw needs NAPM top/ranking queries, trend/time-series queries, average/value queries, overview analysis, drilldown path questions, metadata object lists, metric inventory, metric ownership/scope checks, metric compatibility validation, or Chinese narration input for NAPM results.
---

# OpenClaw NAPM Query Skill

Use this skill as the direct runtime for NetInside / NAPM questions. OpenClaw should construct an executable `resolvedQuery`, then run the skill-local executor:

```bash
node scripts/run_napm_query.js --resolvedQueryFile ./query.json
```

The historical `napm-openclaw-plugin` and `napm-skill-query` tool can wrap this executor, but they are not required for standalone skill deployment.

## Architecture

Runtime path:

```text
OpenClaw user request
  -> openclaw-napm-query skill
  -> scripts/run_napm_query.js
  -> skill-local services/config/src
  -> NetInside / NAPM WebService
  -> machine-readable result and narration input
  -> OpenClaw final Chinese answer
```

Skill-local resources are authoritative:

- `scripts/run_napm_query.js`: CLI and execution entry.
- `services/`: metadata, validation, mapping, execution, and narration contract services.
- `config/`: metrics, hierarchy, ontology, and resolution spec.
- `src/`: runtime constants and utilities.
- `references/`: progressively loaded domain notes.

Do not depend on root-level plugin files, root `src/`, root `config/`, removed gateway routes, or old gateway approval flow when deploying this as a standalone skill.

## Responsibility Split

OpenClaw owns:

- Natural-language understanding and domain boundary judgment.
- Multi-turn follow-up understanding.
- Clarification policy.
- `resolvedQuery` construction.
- Final Chinese user-facing narration.

This skill owns:

- Structured query normalization.
- Query validation and execution guardrails.
- Metadata and metric compatibility checks.
- NAPM API request construction and execution.
- Top, trend, average, overview, drilldown, metadata, and metric inventory execution.
- Machine-readable narration contract output.

If `resolvedQuery` is missing, return the built-in Chinese fallback asking OpenClaw to finish intent resolution or scope clarification first. Do not invent a live query from raw prompt text in standalone mode.

## Setup

For standalone deployment, read `references/standalone-skill-runtime.md`.

Minimum local setup inside the skill directory:

```bash
npm install
cp .env.example .env
npm run check
```

Required `.env` values:

- `NETINSIDE_HOST`
- `NETINSIDE_USERNAME`
- `NETINSIDE_PASSWORD`

Useful defaults:

- `NAPM_GROUPS_TREE_MODE=static`
- `NAPM_STATIC_GROUPS_TREE_FILE=./config/groups-tree.static.json`
- `NAPM_RESOLUTION_BOUNDARY_MODE=strict`
- `SHOW_UPSTREAM_API_IN_REPLY=false`
- `SKILL_FORWARD_DISPLAY_TEXT=false`

`SKILL.md` must start directly with `---`; do not add a UTF-8 BOM before the frontmatter.

## Execution Contract

Accepted inputs:

- `--resolvedQuery '<json>'`: primary interface.
- `--resolvedQueryFile <path>`: primary interface when the caller wants to avoid shell JSON quoting issues.
- `--queryJson '<json>'`: alias for an executable query object.
- `--queryJsonFile <path>`: alias for `--resolvedQueryFile`.
- `--payload '<json>'`: object containing `resolvedQuery`, `decision`, `intent`, `session`, or `sessionState`.
- `--payloadFile <path>`: file form of `--payload`.
- `--session '<json>'`: optional continuation state.
- `--raw`: include raw upstream response when debugging locally.

The output is JSON. Prefer `narrationInput.result.narrationStructure`, `narrationInput.result.timeRange`, `summary`, and returned rows when writing the final Chinese answer.

Every data answer must include the data time range. If the result is empty, still say the metric, object scope, service mode, and queried time range.

Never expose credentials. Show upstream API URLs only when the runtime explicitly enables debug output, and always mask sensitive parameters.

## Query Families

Use `topValues` for TopN and ranking:

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "groups": [{ "type": "IPAddress" }],
  "metric": "TPIO",
  "metrics": ["TPIO"],
  "topMetric": "TPIO",
  "topCount": 10,
  "start": 1779410400,
  "end": 1779414000,
  "format": "json"
}
```

Use `timeValues` for trend and time-series:

```json
{
  "service": "timeValues",
  "queryModeKey": "timeseries",
  "groups": [{ "type": "IPAddress", "argument": "101.254.114.238" }],
  "metric": "TRTI",
  "metrics": ["TRTI"],
  "granularity": 60,
  "start": 1779410400,
  "end": 1779414000,
  "format": "json"
}
```

Use `averageValues` for interval average/value queries:

```json
{
  "service": "averageValues",
  "queryModeKey": "average",
  "groups": [{ "type": "IPAddress", "argument": "101.254.114.238" }],
  "metric": "TRTI",
  "metrics": ["TRTI"],
  "start": 1779410400,
  "end": 1779414000,
  "format": "json"
}
```

Object argument policy:

- A single-object `DefinedApp` or `WebApplication` `timeValues`/`averageValues` query must include the concrete object name in `groups[0].argument`.
- If that argument is missing, stop before metadata or metric execution and return a clarification asking for the application or Web application name. Do not interpret the resulting empty set as `no_data`.
- `TotalTraffic` is the global traffic scope and must not carry a group argument. Use it for overall traffic trends.
- `topValues` discovery and `groups` inventory queries may omit the argument because they discover or enumerate objects.
- An explicit but unknown object argument must fail metadata validation and may include runtime candidates; never silently select the first candidate.

Use `drilldownCatalog` for drilldown path questions:

```json
{
  "service": "drilldownCatalog",
  "groups": [{ "type": "BusinessGroup" }],
  "format": "json"
}
```

Use `groups` for metadata object-list queries:

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": { "operation": "metadata_list" },
  "groups": [{ "type": "WebApplication" }],
  "format": "json"
}
```

Use `metrics` for metric inventory and ownership queries:

```json
{
  "service": "metrics",
  "queryModeKey": "metadata",
  "semanticConstraints": { "operation": "metadata_list" },
  "groups": [{ "type": "WebApplication" }],
  "format": "json"
}
```

Use `overview` for broad or composite analysis. For "find the worst object, then analyze it" requests, put discovery in `analysisPipeline.discoveryQuery`, usually with `service=topValues`, then let the overview stage focus on the selected object.

## Semantic Guardrails

Object mapping:

- Plain application / "what applications are in the system" means `DefinedApp` from `applications Type=2`.
- Plain business / business system usually means `WebApplication`.
- Business group / workgroup / grouped business means `BusinessGroup`.
- Web application / website / site means `WebApplication`.
- Explicit IP address generally uses `IPAddress`.
- Client side IP uses `ClientIPs` or a client-side IP path where the group hierarchy requires it.
- Server side IP uses `IPAddress` or server-side path according to query scope.
- Explicitly defined / known / server application also means `DefinedApp` from `applications Type=2`.
- Auto-recognized / composite protocol / composite application means `CompositeApplication` from `applications Type=4`.
- Builtin application means `BuiltinApplication` from `applications Type=1`.

Metric mapping:

- Packet count / packet volume means `PKIO`.
- Throughput / bandwidth / traffic rate usually means `TPIO`.
- Byte traffic / byte volume means `BYTIO`.
- Server response time means `TRTI`, not RTT.
- RTT / network delay / latency means RTT-family metrics such as `RTTI`.
- Web visits / page visits means `PGNPGE`.
- Page timing / page response means `PGTME` or the page timing metric supported by metadata.
- Packet loss means `PLI` or `PLO`.
- Retransmission means retransmission metrics.
- HTTP 4xx / 5xx / error rate means the corresponding HTTP error metrics.

Ranking rules:

- Singular "who / which one / highest" ranking usually uses `topCount=1`.
- Keep `topMetric` aligned with the user's selection condition.
- Do not rewrite packet-loss ranking into throughput ranking unless the user explicitly asks for throughput sorting.

Metadata and ownership:

- Use `groups-tree.static.json` for structural drilldown hierarchy when available.
- Do not use the groups tree as the application catalog.
- Application inventory should come from the runtime metadata service and `applications` type filtering.
- Plain business metric inventory should stay centered on the `WebApplication` view unless the user explicitly asks for `BusinessGroup`.
- Use static ownership rules to choose candidates, then validate with runtime metadata such as `metricsForGroup` when execution compatibility matters.

## References

Load references only when needed:

- `references/standalone-skill-runtime.md`: standalone deployment and CLI examples.
- `references/service-modes.md`: Top, average, trend, metadata, overview, and composite-analysis semantics.
- `references/query-construction.md`: required query fields and group path construction.
- `references/group-hierarchy.md`: object scope and drilldown hierarchy.
- `references/metric-definitions.md`: metric meanings and aliases.
- `references/metric-category-mapping.md`: category-to-metric-code mapping.
- `references/top-level-metric-ownership.md`: top-level business vs non-business ownership split.
- `references/metric-dimension-ownership.md`: metric families by group dimension.
- `references/runtime-lookup-notes.md`: runtime metadata lookup constraints.
- `references/openclaw-integration.md`: OpenClaw invocation notes.

## Anti-Patterns

- Do not require the plugin shape or `napm-skill-query` tool to exist for standalone execution.
- Do not route standalone skill execution through root plugin files.
- Do not require an upstream `decision` object before executing a valid `resolvedQuery`.
- Do not stop the final answer at raw JSON, `Groups list completed`, `Average query completed`, or `[object Object]`.
- Do not answer drilldown hierarchy failures with 403-style wording when local static hierarchy exists.
- Do not reuse stale historical data as the current answer when a fresh query fails.
