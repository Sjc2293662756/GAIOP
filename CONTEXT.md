# NAPM Query Context

This context defines how a monitoring question becomes an executable NAPM query and how one turn preserves its result. It exists to prevent prompt interpretation, query execution, and reply delivery from becoming competing truth sources.

## Language

**Monitoring Question**:
The user's natural-language request for NAPM metadata, metric data, analysis, or diagnosis. It is the source text for query construction and becomes trace-only after a Resolved Query exists.
_Avoid_: prompt intent after query construction

**Resolved Query**:
The structured, executable NAPM query containing the selected operation, object type, metrics, and time range. Once accepted by the query contract, it is the authoritative description of what the query adapter executes.
_Avoid_: repaired prompt, inferred query at plugin hooks

**Query Draft**:
The structured but not-yet-executable interpretation of a Monitoring Question. It may omit a value that must be supplied by the user, and it must pass Query Decision evaluation before it can become a Resolved Query.
_Avoid_: incomplete Resolved Query, executable query

**Query Decision**:
The authoritative evaluation of a Query Draft. It selects exactly one action: ask a clarifying question, execute a validated Resolved Query, or reject an unsupported query. A clarification is a normal terminal outcome and does not imply Skill or southbound failure.
_Avoid_: model prose, hook-local guess, validation error for missing user input

**Query Turn**:
The lifecycle record for one Monitoring Question, identified by conversation scope and turn id. It preserves route, phase, Query Decision, Query Attempt, terminal outcome, and delivery claim without making the Skill stateful.
_Avoid_: latest result in a conversation, Skill session

**Query Attempt**:
One construction or execution try for a Resolved Query within a turn. Failed attempts are recorded separately from a successful Query Result.
_Avoid_: skill result for a failed construction

**Query Result**:
The successful data returned by the NAPM execution adapter for a turn. A later failed Query Attempt must not replace it.
_Avoid_: latest attempt, cached failure

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
