# NAPM Query Context

This context defines how a monitoring question becomes an executable NAPM query and how one runtime turn preserves and delivers its result. It prevents prompt interpretation, query execution, conversation cache, and output hooks from becoming competing truth sources.

## Language

**Monitoring Question**:
The user's natural-language request for NAPM metadata, metric data, analysis, or diagnosis. It is the source text for Query Draft construction and becomes trace-only after a Resolved Query exists.
_Avoid_: prompt intent after query construction

**Conversation Scope**:
The stable `conversationKey` used to group turns and retain a pending clarification. It is not a pointer to the active or latest turn.
_Avoid_: current turn, latest turn id, delivery source

**Run Binding**:
The immutable association between one OpenClaw inbound message/agent run and one `turnId`. OpenClaw message hooks expose `messageId`, while agent and Tool hooks expose `runId`; `QueryTurnCoordinator` bridges them by adopting the fresh `RECEIVED` turn whose trusted conversation scope and source prompt match, then binds the agent run to that same turn. Tool and output hooks resolve the Query Turn only through these bindings. Direct Tool execution must present the plugin-issued trusted `traceId` for that scope and turn, with an exact trusted `toolName` match and a `NAPM_QUERY` route. Missing or mismatched identity/route fails closed before pending-draft restoration, time materialization, validation, or Skill execution; it never falls back to the conversation's latest turn. Because OpenClaw's `before_message_write` contract does not provide run/message identity, that hook must not finalize or replace a Query Turn when identity is absent; authoritative channel delivery remains owned by identity-bearing output hooks.
_Avoid_: mutable conversation turn id, latest-turn lookup

**Query Draft**:
The structured but not-yet-executable interpretation of a Monitoring Question. It may omit a value that must be supplied by the user and must pass Query Decision evaluation before it can become a Resolved Query.
_Avoid_: incomplete Resolved Query, executable query

**Query Decision**:
The authoritative evaluation of a Query Draft. It selects exactly one action: ask a clarifying question, execute a validated Resolved Query, or reject an unsupported query. A clarification is a normal terminal outcome and does not imply Skill or southbound failure.
_Avoid_: model prose, hook-local guess, validation error for missing user input

**Structured Query Intent**:
The shared classification of workflow operation, target object type, and metric semantic. `WorkflowClassifierService` composes object ontology and metric normalization into this structure, and Query Decision consumes it for application-traffic scope checks. Prompt routing, plugin hooks, and Query Decision must not maintain independent application-traffic regexes.
_Avoid_: duplicated prompt regex, hook-local application scope guess

**Validated Group Path**:
An explicit multi-level `pathPlanning` record whose planner proof, `plannedGroups`, `selectedPath`, anchor, and terminal queryability all agree with the static groups tree. Ordinary queries with multiple groups default to `VALIDATION_FAILURE`; merely supplying two groups or an unverified `pathPlanning` object is not sufficient.
_Avoid_: implicit multi-group execution, trusting `groups.length > 1`, unverified path metadata

**Resolved Query**:
The structured, executable NAPM query containing the selected operation, object type, metrics, and time range. Only an `EXECUTE_QUERY` decision may pass it to the Query Skill and southbound adapter.
_Avoid_: repaired prompt, inferred query at output hooks

**Query Turn**:
The lifecycle record for one Monitoring Question, identified by `conversationKey + turnId` and reached through its Run Binding. `QueryTurnCoordinator` owns its immutable route, Query Draft, Query Decision, Query Attempts, repair budget, pending clarification, terminal outcome, authoritative `finalContent`, and delivery claim. A Tool or Tool result cannot reclassify the route after the turn begins. Results and execution failures can only be recorded from `EXECUTING`; abandoned repair and execution-time Skill clarification have separate transitions.
_Avoid_: latest result in a conversation, Skill session, ConversationOperationState query delivery

**Query Attempt**:
One identified construction or execution try within a Query Turn. Replaying the same `attemptId` is idempotent. The first technical construction failure enters `REPAIR_PENDING` and consumes the single repair budget; a second construction failure, or non-streaming final output before repair, terminates with `VALIDATION_FAILURE`. An execution failure terminates immediately with `EXECUTION_FAILURE`.
_Avoid_: untracked retry, cleared failure history, retry after terminal

**Pending Clarification**:
The incomplete Query Draft retained at conversation scope after `CLARIFICATION`. If the next user message is only the missing object name, the model calls `napm-skill-query` with `clarificationAnswer`; the plugin creates a new bound Query Turn, restores the pending draft, fills the declared `groups[n].argument`, and consumes the pending record.
_Avoid_: model reconstruction of the whole query, reuse of the old turn as mutable state

**Terminal Outcome**:
One of `CLARIFICATION`, `RESULT`, `NO_DATA`, `REJECTION`, `VALIDATION_FAILURE`, `EXECUTION_FAILURE`, or `CONTRACT_VIOLATION`. Terminal state and `finalContent` are write-once; only the delivery claim may advance monotonically. All terminal types are delivered by the Coordinator exactly once. A clarification returned by the Skill after execution starts completes the attempt successfully as `CLARIFICATION`, not as a failure. Streaming partial output is never terminal. At non-streaming final output, unfinished `RECEIVED`/`DECIDED` turns become `CONTRACT_VIOLATION`, `REPAIR_PENDING` becomes `VALIDATION_FAILURE`, and `EXECUTING` becomes `EXECUTION_FAILURE`; a late or replayed Tool execution cannot replace the outcome or start another Skill or southbound call.
_Avoid_: terminal rollback, late failure overwrite, model-authored query final

**Execution Claim**:
The single execution attempt that moved a Query Turn from `DECIDED` to `EXECUTING`. A concurrent Tool replay is rejected before its Draft is materialized or validated and receives `QUERY_EXECUTION_IN_PROGRESS`; only the claimant may call the Query Skill and southbound adapter.
_Avoid_: validate-then-dedupe, second execution attempt, replay-owned southbound call

**Query Result**:
The successful data returned by the NAPM execution adapter for a turn. `RESULT` and `NO_DATA` both produce authoritative `finalContent`; a later failed Query Attempt cannot replace either result.
_Avoid_: latest attempt, cached failure, ConversationOperationState as query reply source

**Authoritative Ranking Result Set**:
The minimal projection retained after a successful `topValues` query whose terminal group is `WebApplication` or `PageFamily`. It contains only `resultSetId`, source turn, inherited time range, object type, ordinal, row reference, label, and the required follow-up value: a business argument for `WebApplication`, or `pageFamilyId` for `PageFamily`. TopN rows are numerically normalized and reranked before storage. The set is frozen when a follow-up Query Turn begins, scoped to one conversation, and expires after 30 minutes.
_Avoid_: full cached result rows, unnormalized upstream order, conversation-latest lookup during execution, model-invented object argument or pageFamilyId

**Page View Detail Query**:
The executable `service=pageViews`, `queryModeKey=detail` request for visit instances under one Page Family. It requires a trusted numeric `pageFamilyId`, minute-aligned root time range, and validated `maxLimit`; it has no groups, metrics, topMetric, or granularity. `PageFamilyDetail` is not a group type. Returned `pageFamilyDetailId` identifies one visit and may support a later packet action.
_Avoid_: PageFamilyDetail drilldown, metric query, page-family aggregate ranking

**Result Reference**:
An ordinal selection from the current Query Turn's frozen source set. `{objectType:"WebApplication", ordinal}` selects a business for the explicit `WebApplication > PageFamilies > PageFamily` drilldown; `{objectType:"PageFamily", ordinal}` selects a page for `pageViews`. The plugin resolves it before time materialization and execution, strips caller-supplied provenance flags, and issues the trusted `sourceReference`. Invalid, expired, cross-scope, wrong-type, or out-of-range references fail closed without a Query Skill or southbound call.
_Avoid_: raw object names or pageFamilyId guessed from prose, caller-authored sourceReference, mutable latest-result pointer, cross-conversation reference

**TopN Normalization**:
The deterministic ordering applied to every `topValues` result before narration or ranking-result storage. Values are parsed numerically using `topMetric`, structured ascending/descending intent determines direction, source ranks are replaced, ties remain stable, and blank/missing values stay last. The narration object type is the effective terminal group.
_Avoid_: string sorting, trusting upstream row order, treating blank values as zero, labeling a terminal PageFamily result as WebApplication

**Contract Violation**:
The deterministic terminal outcome recorded when a `NAPM_QUERY` turn reaches final output without the required `napm-skill-query` call, or after the Tool call was accepted but before its adapter started execution. It produces a safe final response and never fabricates data or starts a southbound request. If adapter execution already started but no result exists at final output, the distinct terminal outcome is `EXECUTION_FAILURE`.
_Avoid_: heuristic-only guard, direct model answer for a required query

**Business**:
The monitoring object represented by `WebApplication` in NAPM queries.
_Avoid_: application, business group

**Application**:
The defined application catalog represented by `DefinedApp` in NAPM queries.
_Avoid_: business, WebApplication

**Business Group**:
The monitoring grouping represented by `BusinessGroup` in NAPM queries.
_Avoid_: business, WebApplication

## Flagged Ambiguities

- Chinese inventory wording such as “有哪些” does not by itself define the operation. An explicit metric comparison, average, or trend in the same Monitoring Question takes precedence.
- `Business`, `Application`, and `Business Group` are distinct object types and must not be used as aliases for each other.
- `PageFamily`, a `pageViews` visit instance, and `pageFamilyDetailId` are distinct concepts; only `PageFamily` is a query group.

## Example Dialogue

Domain expert: “最近一周有哪些业务出现较多 HTTP 500 错误？”

Developer: “This is a Monitoring Question for a WebApplication ranking. The Resolved Query uses `topValues`, `PGHTTP500`, `WebApplication`, and `last7days`; ‘有哪些’ does not turn it into an inventory query.”

Domain expert: “What happens if the first Query Attempt is invalid?”

Developer: “One repair is allowed. A repeated failure terminates, while an existing Query Result remains authoritative.”

Domain expert: “用户被问应用名后只回复 HTTP，会发生什么？”

Developer: “The new run is bound to a new turn. The model supplies `clarificationAnswer=HTTP`; the plugin restores the pending Query Draft, sets `DefinedApp.argument=HTTP`, reevaluates the full policy, and then executes once.”

Domain expert: “页面排行后只说‘详细查看第一名的前 20 个’会怎样？”

Developer: “The new Query Turn freezes the prior Authoritative Ranking Result Set. The model supplies a `PageFamily` Result Reference; the plugin resolves its trusted `pageFamilyId`, inherits the source time range, and executes one `pageViews` request with `maxLimit=20`.”

Domain expert: “第一轮问哪些业务页面访问量最高，第二轮只问排名第一的都访问了什么，会怎样？”

Developer: “The first turn returns a normalized `WebApplication` ranking. The second turn resolves ordinal 1 from that frozen set, fills the business argument, and executes the validated path to a `PageFamily` ranking. It never treats the first question as an implicit page drilldown.”
