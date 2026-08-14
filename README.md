# NAPM OpenClaw Skill

This repository contains a standalone OpenClaw skill runtime for NetInside / NAPM semantic queries. It turns structured OpenClaw `resolvedQuery` input into NAPM WebService requests, executes metadata and metric queries, and returns normalized data plus narration input for Chinese answers.

The production runtime should be the skill directory:

```text
skills/openclaw-napm-query
```

Root plugin files such as `openclaw.plugin.json` and `napm-openclaw-plugin.*` are optional compatibility wrappers around the skill executor. They are not required for standalone skill deployment.

## Project Goal

- Provide a reusable standalone `openclaw-napm-query` skill for NAPM metric lookup, metadata inventory, ranking, trend, average, drilldown, metric ownership, and overview analysis.
- Keep OpenClaw responsible for intent understanding and structured `resolvedQuery` construction.
- Keep this skill responsible for query normalization, validation, NAPM API construction, execution, result reduction, and narration contract output.
- Protect credentials and debug URLs from being exposed in user-facing replies or committed source.

## Requirements

- Node.js 16 or later
- npm
- Access to a NetInside / NAPM WebService endpoint

## Standalone Skill Setup

Copy or deploy the whole skill directory into OpenClaw's skills directory, then install dependencies inside the skill:

```powershell
Set-Location skills\openclaw-napm-query
npm install
Copy-Item .env.example .env
npm run check
```

Fill `.env` with local values:

```env
NETINSIDE_HOST=https://<napm-host>/webservice/NetInside
NETINSIDE_USERNAME=<username>
NETINSIDE_PASSWORD=<password>
```

Verify OpenClaw discovery after deployment:

```powershell
openclaw skills info openclaw-napm-query --json
```

`skills/openclaw-napm-query/SKILL.md` must start directly with `---`. A UTF-8 BOM before the frontmatter can make OpenClaw fail to discover the skill.

## Run

From the skill directory:

```powershell
npm run query -- --resolvedQueryFile .\query.json
```

From the repository root:

```powershell
npm run query -- --resolvedQueryFile .\query.json
```

## Test

```powershell
npm test
```

## Core Entry Points

- `skills/openclaw-napm-query/SKILL.md`: OpenClaw skill policy, scope, and runtime contract.
- `skills/openclaw-napm-query/package.json`: skill-local dependency and command manifest.
- `skills/openclaw-napm-query/.env.example`: skill-local environment template.
- `skills/openclaw-napm-query/scripts/run_napm_query.js`: main CLI/runtime executor.
- `skills/openclaw-napm-query/services/NapmClient.js`: NetInside / NAPM WebService client.
- `skills/openclaw-napm-query/services/RequirementParserService.js`: structured query normalization and compatibility handling.
- `skills/openclaw-napm-query/services/NapmMetadataService.js`: metadata lookup and catalog access.
- `skills/openclaw-napm-query/config/`: static metadata, mapping, hierarchy, ontology, and resolution spec.
- `skills/openclaw-napm-query/src/`: runtime constants and utilities.
- `skills/openclaw-napm-query/references/standalone-skill-runtime.md`: standalone deployment and CLI examples.
- `test/`: regression tests for query contracts, overview planning, routing guards, and metric ownership.

## Security Notes

- Never commit `.env`, API keys, database passwords, certificates, logs, or production-only deployment artifacts.
- Use placeholder documentation addresses such as `192.0.2.0/24`, `198.51.100.0/24`, and `203.0.113.0/24` in tests and docs.
- Keep `SHOW_UPSTREAM_API_IN_REPLY=false` unless debugging in a controlled local environment.
- Rotate any credential that was ever committed or pushed before cleanup.
