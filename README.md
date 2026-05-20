# NAPM Semantic Gateway

NAPM Semantic Gateway is an OpenClaw skill runtime for NetInside / NAPM semantic queries. It turns structured OpenClaw `resolvedQuery` input into NAPM WebService requests, executes metadata and metric queries, and returns normalized data plus narration input for Chinese answers.

The repository intentionally does not include production credentials, server addresses, certificates, logs, or deployment-only artifacts. Put environment-specific values in `.env` only.

## Project Goal

- Provide a reusable `openclaw-napm-query` skill for NAPM metric lookup, metadata inventory, ranking, trend, average, drilldown, and overview analysis.
- Keep OpenClaw responsible for intent understanding and structured `resolvedQuery` construction.
- Keep this skill responsible for query normalization, validation, NAPM API construction, execution, result reduction, and narration contract output.
- Protect credentials and debug URLs from being exposed in user-facing replies or committed source.

## Requirements

- Node.js 16 or later
- npm
- Access to a NetInside / NAPM WebService endpoint

## Configuration

Copy the example environment file and fill in local values:

```powershell
Copy-Item .env.example .env
```

Required values:

```env
NETINSIDE_HOST=https://<napm-host>/webservice/NetInside
NETINSIDE_USERNAME=<username>
NETINSIDE_PASSWORD=<password>
```

Optional values are documented in `.env.example`. Do not commit `.env`, certificates, logs, or generated deployment copies.

## Install

```powershell
npm install
```

## Run

Run a direct skill query:

```powershell
npm run query -- --prompt "今天网络整体情况怎么样？"
```

Run with a structured resolved query:

```powershell
npm run query -- --resolvedQuery "{ \"service\": \"overview\", \"queryModeKey\": \"overview\", \"overviewScene\": \"network\" }"
```

## Test

```powershell
npm test
```

## Core Entry Points

- `skills/openclaw-napm-query/SKILL.md`: OpenClaw skill policy, scope, and runtime contract.
- `skills/openclaw-napm-query/scripts/run_napm_query.js`: main CLI/runtime executor.
- `skills/openclaw-napm-query/scripts/overview-module.js`: overview orchestration entry.
- `skills/openclaw-napm-query/services/NapmClient.js`: NetInside / NAPM WebService client.
- `skills/openclaw-napm-query/services/RequirementParserService.js`: structured query normalization and compatibility handling.
- `skills/openclaw-napm-query/services/NapmMetadataService.js`: metadata lookup and catalog access.
- `src/utils/auditLogger.js`: request logging helpers with credential masking.
- `config/`: static metadata, mapping, and query template configuration.
- `test/`: regression tests for query contracts, overview planning, routing guards, and metric ownership.

## Security Notes

- Never commit `.env`, API keys, database passwords, WeCom secrets, certificates, logs, or production server IPs.
- Use placeholder documentation addresses such as `192.0.2.0/24`, `198.51.100.0/24`, and `203.0.113.0/24` in tests and docs.
- Keep `SHOW_UPSTREAM_API_IN_REPLY=false` unless debugging in a controlled local environment.
- Rotate any credential that was ever committed or pushed before cleanup.
