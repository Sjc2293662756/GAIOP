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
The immutable association created at `message_received` between the current OpenClaw run/message and one `turnId`. Tool and output hooks resolve the Query Turn only through this binding. Missing run/message identity or a missing binding fails closed; it never falls back to the conversation's latest turn.
_Avoid_: mutable conversation turn id, latest-turn lookup

**Query Draft**:
The structured but not-yet-executable interpretation of a Monitoring Question. It may omit a value that must be supplied by the user and must pass Query Decision evaluation before it can become a Resolved Query.
_Avoid_: incomplete Resolved Query, executable query

**Query Decision**:
The authoritative evaluation of a Query Draft. It selects exactly one action: ask a clarifying question, execute a validated Resolved Query, or reject an unsupported query. A clarification is a normal terminal outcome and does not imply Skill or southbound failure.
_Avoid_: model prose, hook-local guess, validation error for missing user input

**Resolved Query**:
The structured, executable NAPM query containing the selected operation, object type, metrics, and time range. Only an `EXECUTE_QUERY` decision may pass it to the Query Skill and southbound adapter.
_Avoid_: repaired prompt, inferred query at output hooks

**Query Turn**:
The lifecycle record for one Monitoring Question, identified by `conversationKey + turnId` and reached through its Run Binding. `QueryTurnCoordinator` owns its immutable route, Query Draft, Query Decision, Query Attempts, repair budget, pending clarification, terminal outcome, authoritative `finalContent`, and delivery claim. A Tool or Tool result cannot reclassify the route after the turn begins.
_Avoid_: latest result in a conversation, Skill session, ConversationOperationState query delivery

**Query Attempt**:
One identified construction or execution try within a Query Turn. Replaying the same `attemptId` is idempotent. The first technical construction failure enters `REPAIR_PENDING` and consumes the single repair budget; a second construction failure, or non-streaming final output before repair, terminates with `VALIDATION_FAILURE`. An execution failure terminates immediately with `EXECUTION_FAILURE`.
_Avoid_: untracked retry, cleared failure history, retry after terminal

**Pending Clarification**:
The incomplete Query Draft retained at conversation scope after `CLARIFICATION`. If the next user message is only the missing object name, the model calls `napm-skill-query` with `clarificationAnswer`; the plugin creates a new bound Query Turn, restores the pending draft, fills the declared `groups[n].argument`, and consumes the pending record.
_Avoid_: model reconstruction of the whole query, reuse of the old turn as mutable state

**Terminal Outcome**:
One of `CLARIFICATION`, `RESULT`, `NO_DATA`, `REJECTION`, `VALIDATION_FAILURE`, `EXECUTION_FAILURE`, or `CONTRACT_VIOLATION`. Terminal state and `finalContent` are write-once; only the delivery claim may advance monotonically. All terminal types are delivered by the Coordinator exactly once. Streaming partial output is never terminal. At non-streaming final output, unfinished `RECEIVED`/`DECIDED` turns become `CONTRACT_VIOLATION`, `REPAIR_PENDING` becomes `VALIDATION_FAILURE`, and `EXECUTING` becomes `EXECUTION_FAILURE`; a late or replayed Tool execution cannot replace the outcome or start another Skill or southbound call.
_Avoid_: terminal rollback, late failure overwrite, model-authored query final

**Query Result**:
The successful data returned by the NAPM execution adapter for a turn. `RESULT` and `NO_DATA` both produce authoritative `finalContent`; a later failed Query Attempt cannot replace either result.
_Avoid_: latest attempt, cached failure, ConversationOperationState as query reply source

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

## Example Dialogue

Domain expert: “最近一周有哪些业务出现较多 HTTP 500 错误？”

Developer: “This is a Monitoring Question for a WebApplication ranking. The Resolved Query uses `topValues`, `PGHTTP500`, `WebApplication`, and `last7days`; ‘有哪些’ does not turn it into an inventory query.”

Domain expert: “What happens if the first Query Attempt is invalid?”

Developer: “One repair is allowed. A repeated failure terminates, while an existing Query Result remains authoritative.”

Domain expert: “用户被问应用名后只回复 HTTP，会发生什么？”

Developer: “The new run is bound to a new turn. The model supplies `clarificationAnswer=HTTP`; the plugin restores the pending Query Draft, sets `DefinedApp.argument=HTTP`, reevaluates the full policy, and then executes once.”
