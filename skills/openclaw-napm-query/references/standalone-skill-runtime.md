# Standalone Skill Runtime

Use this reference when deploying `openclaw-napm-query` as a real OpenClaw skill instead of calling it through `napm-openclaw-plugin`.

## Deployment Shape

The standalone package is the directory that contains this file:

```text
openclaw-napm-query/
  SKILL.md
  package.json
  .env.example
  agents/openai.yaml
  config/
  references/
  scripts/
  services/
  src/
```

Copy the whole `skills/openclaw-napm-query` directory into the OpenClaw skills directory, for example:

```bash
cp -R skills/openclaw-napm-query "$OPENCLAW_HOME/skills/openclaw-napm-query"
cd "$OPENCLAW_HOME/skills/openclaw-napm-query"
npm install
cp .env.example .env
```

Fill `.env` with the local NetInside / NAPM endpoint and credentials. Do not commit `.env`.

Verify discovery:

```bash
openclaw skills info openclaw-napm-query --json
```

`SKILL.md` must start directly with `---`. A UTF-8 BOM before the frontmatter can make OpenClaw report the skill as not found.

## Primary Execution Interface

Run from inside the skill directory:

```bash
npm run query -- --resolvedQueryFile ./query.json
```

Or call the script directly:

```bash
node scripts/run_napm_query.js --resolvedQueryFile ./query.json
```

OpenClaw should construct `resolvedQuery` in the main flow, then invoke this skill executor. The plugin tool name `napm-skill-query` is only an optional compatibility wrapper, not a required runtime dependency for the standalone skill.

## Supported Query Families

Top query:

```bash
node scripts/run_napm_query.js --resolvedQuery '{"service":"topValues","queryModeKey":"topn","groups":[{"type":"IPAddress"}],"metric":"TPIO","metrics":["TPIO"],"topMetric":"TPIO","topCount":10,"start":1779410400,"end":1779414000,"format":"json"}'
```

On Windows PowerShell, prefer `--resolvedQueryFile` for these examples to avoid native-command JSON quoting problems.

Trend query:

```bash
node scripts/run_napm_query.js --resolvedQuery '{"service":"timeValues","queryModeKey":"timeseries","groups":[{"type":"IPAddress","argument":"101.254.114.238"}],"metric":"TRTI","metrics":["TRTI"],"granularity":60,"start":1779410400,"end":1779414000,"format":"json"}'
```

Average query:

```bash
node scripts/run_napm_query.js --resolvedQuery '{"service":"averageValues","queryModeKey":"average","groups":[{"type":"IPAddress","argument":"101.254.114.238"}],"metric":"TRTI","metrics":["TRTI"],"start":1779410400,"end":1779414000,"format":"json"}'
```

Drilldown path query:

```bash
node scripts/run_napm_query.js --resolvedQuery '{"service":"drilldownCatalog","groups":[{"type":"BusinessGroup"}],"format":"json"}'
```

Metadata object-list query:

```bash
node scripts/run_napm_query.js --resolvedQuery '{"service":"groups","queryModeKey":"metadata","semanticConstraints":{"operation":"metadata_list"},"groups":[{"type":"WebApplication"}],"format":"json"}'
```

Metric inventory / ownership query:

```bash
node scripts/run_napm_query.js --resolvedQuery '{"service":"metrics","queryModeKey":"metadata","semanticConstraints":{"operation":"metadata_list"},"groups":[{"type":"WebApplication"}],"format":"json"}'
```

## Runtime Responsibilities

OpenClaw owns:

- Natural-language understanding.
- Domain boundary judgment.
- Follow-up inheritance.
- Clarification policy.
- Structured `resolvedQuery` construction.

This skill owns:

- Query normalization and validation.
- Metadata and metric compatibility checks.
- NAPM WebService request construction.
- Top, trend, average, drilldown, metadata, metric inventory, and overview execution.
- Machine-readable narration contract output for OpenClaw to turn into the final Chinese answer.
