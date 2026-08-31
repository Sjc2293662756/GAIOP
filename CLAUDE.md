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
  → message_received binds run/message to an immutable Query Turn
  → napm-skill-query(queryDraft | clarificationAnswer)
  → QueryDecisionPolicy → QueryTurnCoordinator
  → EXECUTE_QUERY only → loadSkill() in-process require() → skill/scripts/run_*.js
  → skill services → NapmClient (axios) → NetInside NAPM WebService
  → authoritative finalContent → exactly-once Chinese reply back to WeChat
```

`conversationKey` is only a scope. Tool and output hooks resolve the immutable `turnId` bound to the current run/message and must not read the conversation's latest turn; missing lifecycle identity or binding fails closed. A Query Turn's route is immutable after creation, so another Tool or Tool result cannot reclassify a `NAPM_QUERY` as `OTHER_SKILL`. `QueryTurnCoordinator` owns ordinary-query drafts, attempts, the one-repair budget, pending clarifications, terminal content, and delivery claims. `ConversationOperationState` is not the authority for ordinary-query repair, result, or final delivery.

### Plugin: `napm-openclaw-plugin.remote.js`

A monolithic plugin loaded by OpenClaw Gateway. It:

1. Declares 7 production tool contracts plus 2 opt-in diagnostic tool contracts in `openclaw.plugin.json`
2. Binds every incoming run/message to one immutable Query Turn and routes Tool/output hooks through that binding
3. Evaluates Query Drafts at both Hook and direct Tool-execute boundaries, then records attempts, pending clarification, terminal content, and exactly-once delivery in `QueryTurnCoordinator`
4. Loads each skill's `scripts/run_*.js` in-process via `require()`; this implementation detail is not a deployment or hot-reload contract
5. Maintains compatibility state for non-query workflows and applies time overrides before complete Resolved Queries execute

Skills are not spawned as subprocesses; they run in the Gateway process. Runtime changes are installed only through the approved complete release package. Do not infer that copying one file makes all plugin and Coordinator changes live, and do not perform an ad hoc restart outside the approved deployment workflow.

### Query Turn contract

- `message_received` creates a `turnId` and immutable run/message binding. Overlapping runs in one conversation remain isolated.
- Direct Tool execution requires a plugin-issued trusted `traceId` that resolves to the same scope and turn. Missing identity or binding fails before time materialization, validation, Skill loading, or any southbound request.
- The route chosen when the turn is created is immutable. A production `NAPM_QUERY` accepts only `napm-skill-query`; a wrong NAPM Tool is blocked without southbound execution or route mutation. Opt-in resolver tools remain development diagnostics.
- A first technical validation failure enters `REPAIR_PENDING` and consumes the one-repair budget. Replaying the same attempt id is idempotent; a second failed construction terminates. Execution failure terminates immediately.
- A Tool replay while the turn is already `EXECUTING` returns `QUERY_EXECUTION_IN_PROGRESS` before processing the replayed Draft. It cannot revalidate, change state, start a second attempt, or call southbound again.
- After clarification, a name-only reply such as `HTTP` is sent as `clarificationAnswer`; the plugin restores the policy-normalized pending Query Draft and fills `DefinedApp.argument` before reevaluating the full policy. An application draft incorrectly mapped to `TotalTraffic` is normalized to `DefinedApp` before it is retained.
- Hook and direct execute paths enforce the same high-risk checks: application trend/average/ranking versus `TotalTraffic`, `CompositeApplication` and general object-inventory shape, promptless `overview/auto_apps`, and the single-group requirement for object inventories.
- `CLARIFICATION`, `RESULT`, `NO_DATA`, `REJECTION`, `VALIDATION_FAILURE`, `EXECUTION_FAILURE`, and `CONTRACT_VIOLATION` all have write-once authoritative `finalContent`. Streaming partial output does not terminate a turn; a Tool replay after terminal returns the existing authoritative result without another Skill or southbound call.
- A non-streaming final cannot leave an ordinary query nonterminal. `RECEIVED` without a Decision/Attempt and `DECIDED` without adapter execution terminate as contract violations; `REPAIR_PENDING` terminates as a validation failure; `EXECUTING` without a result terminates as an execution failure. A late adapter result cannot overwrite that outcome.
- Other Skills retain their own delivery workflows; the ordinary-query Coordinator only owns `NAPM_QUERY` turns.

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

### Deploy

The only supported deployment path is the versioned complete release package described in `docs/版本管理与统一部署-新手指南.md`. Build only from an approved clean commit, stage and verify the whole package, run the installer in dry-run mode, and perform installation or service restart only after explicit approval. Do not copy individual repository files into active runtime directories and do not use direct `pscp`/`plink` as a release mechanism.

The current query-turn change is local development only: no version change, package build, server connection, deployment, or service restart is part of this task.

### Key constraints

- Never expose credentials, internal IPs, or debug URLs in user-facing replies or committed code
- Skill boundary rules in each `SKILL.md` are authoritative — respect them (e.g., packet analysis questions go to `openclaw-napm-packet-analysis`, NOT query)
- Fault diagnosis requests MUST use `napm-fault-diagnosis` as a single tool call; never decompose into multiple query calls
- `napm-skill-query` accepts a structured Query Draft or `clarificationAnswer`; the Query Skill receives only a fully validated Resolved Query, and local prompt parsing is disabled in production
- All answers must include data time range and distinguish: query results vs system facts vs inference
- Project persona and behavior boundaries are in `SOUL.md` — read it before making changes that affect user-facing behavior
