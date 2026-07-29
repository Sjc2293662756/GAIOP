# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

观枢AI (GuanShu AI) — an enterprise WeChat NAPM/NetInside intelligent operations assistant. Users send natural-language network operations questions via WeChat; OpenClaw Gateway routes them to NAPM skills, which query the NAPM WebService API and return structured Chinese answers, reports, and charts.

## Commands

```bash
# Install
npm install

# Run a single NAPM query (CLI)
npm run query -- --resolvedQuery '{...}'

# Run tests
npm test

# Lint (note: src/ now lives inside skills/openclaw-napm-query/src/)
npx eslint skills/openclaw-napm-query/scripts/**/*.js skills/openclaw-napm-query/services/**/*.js skills/openclaw-napm-query/src/**/*.js
```

## Architecture

### Request flow

```
WeChat → OpenClaw Gateway (:18789) → napm-openclaw-plugin.remote.js
  → loadSkill() in-process require() → skill/scripts/run_*.js
  → skill services → NapmClient (axios) → NetInside NAPM WebService
  → narration contract → OpenClaw → Chinese reply / report back to WeChat
```

### Plugin: `napm-openclaw-plugin.remote.js`

A monolithic plugin loaded by OpenClaw Gateway. It:

1. Declares 7 production tool contracts plus 2 opt-in diagnostic tool contracts in `openclaw.plugin.json`
2. Loads each skill's `scripts/run_*.js` **in-process** via `require()` with cache-busting (`delete require.cache`) to support hot-reload on push
3. Maintains in-memory conversation state (`napmConversationState`), result cache (90s), and guard state
4. Applies time overrides via `before_tool_call` hook using `skills/openclaw-napm-query/src/shared/timeResolver.js`

Skills are NOT spawned as subprocesses — they run synchronously in the Gateway process. This means skill code changes take effect immediately on push (cache-busted reload), no restart needed.

### Skills (9 total, each self-contained under `skills/<name>/`)

Each skill follows the same structure:

```
skills/<skill-name>/
├── SKILL.md          # OpenClaw skill policy: scope, boundary, anti-patterns
├── scripts/          # Runtime entry point (run_*.js) and orchestration modules
├── services/         # Business logic: API client, parsers, resolvers, narrators
├── references/       # Lookup tables, contracts, source indices
├── agents/           # OpenClaw agent configs (some skills)
└── templates/        # Report templates (report/fault-diagnosis skills)
```

The query skill (`openclaw-napm-query`) is the most complex — its `services/` layer includes:
- **NapmClient.js** — HTTP client wrapping NAPM WebService (axios, TLS config, credential masking)
- **RequirementParserService.js** — structured query normalization, execution, and compatibility
- **NapmMetadataService.js** — metadata/catalog lookups with local cache
- **OpenClawNarrationContractService.js** — converts query results into Chinese narration input
- **NapmResolvedQueryResolverService.js** — resolves structured queries into executable form

### `src/` location

As of 2026-07-15, the shared `src/` (constants, utils, timeResolver) lives inside `skills/openclaw-napm-query/src/` — it was moved from project root because only that skill used it. Do not recreate a root-level `src/`; keep skill-internal dependencies inside the skill directory.

### Config files (`config/`)

Static configuration consumed at runtime — no database, no dynamic config server:
- `groups-tree.static.json` — authoritative drilldown hierarchy tree
- `object-ontology.v1.json` — object type definitions and Chinese aliases
- `metrics-config.yml` — metric code definitions
- `napm-resolution-spec.v1.json` — query service/mode/field contracts

### Two remote paths (critical for deploy)

The Gateway loads the plugin from TWO locations, and both must be kept in sync on push:

| Path | Purpose |
|---|---|
| `/home/netinside/.openclaw/workspace/` | Skill source files, mirrors local repo structure |
| `/home/netinside/.openclaw/extensions/napm-openclaw-plugin/` | Plugin runtime — Gateway loads `napm-openclaw-plugin.remote.js` and `openclaw.plugin.json` from here |

When pushing `timeResolver.js`, it must go to both `workspace/skills/openclaw-napm-query/src/shared/` (for workspace resolution) and `extensions/napm-openclaw-plugin/skills/openclaw-napm-query/src/shared/` (for `__dirname`-based resolution inside the plugin).

### Deploy

Push to remote server `101.254.114.237` via `pscp` (not git push — remote has no git):

```bash
# Skill files → workspace
/d/PUTTY/pscp -pw netinside_123 "<local-file>" "netinside@101.254.114.237:/home/netinside/.openclaw/workspace/<remote-path>/"

# Plugin → both workspace and extensions
/d/PUTTY/pscp -pw netinside_123 "napm-openclaw-plugin.remote.js" "netinside@101.254.114.237:/home/netinside/.openclaw/workspace/"
/d/PUTTY/pscp -pw netinside_123 "napm-openclaw-plugin.remote.js" "netinside@101.254.114.237:/home/netinside/.openclaw/extensions/napm-openclaw-plugin/"
```

Create remote directories first with plink if needed: `echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "mkdir -p <path>"`. Full details in `memory/deploy-push-config.md`.

### Key constraints

- Never expose credentials, internal IPs, or debug URLs in user-facing replies or committed code
- Skill boundary rules in each `SKILL.md` are authoritative — respect them (e.g., packet analysis questions go to `openclaw-napm-packet-analysis`, NOT query)
- Fault diagnosis requests MUST use `napm-fault-diagnosis` as a single tool call; never decompose into multiple query calls
- `resolvedQuery` must be fully structured before execution; local prompt parsing is disabled in production
- All answers must include data time range and distinguish: query results vs system facts vs inference
- Project persona and behavior boundaries are in `SOUL.md` — read it before making changes that affect user-facing behavior
