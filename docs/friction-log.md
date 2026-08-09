# KeeperHub Onboarding Friction Log

Running record of every point of confusion, missing doc, and rough edge hit
while integrating KeeperHub — each paired with a concrete proposed fix.

Kept from the first commit, per PRD §16. Reconstructing this from memory later
produces a visibly weaker artefact, so log entries as they happen, not in
batches.

## How to add an entry

Append to the table. One row per distinct friction point. Be specific enough
that a KeeperHub engineer could act on the proposed fix without asking a
follow-up question.

- **Severity** — `blocker` (could not proceed), `friction` (cost real time),
  `polish` (noticed, minor).
- **Area** — docs, SDK, API, CLI, dashboard, workflow builder, MCP, x402.
- **Proposed fix** — the concrete change. "Improve the docs" is not a fix;
  "add the audit-record JSON shape to the /audit endpoint reference page" is.

## Entries

| # | Date | Area | Severity | What happened | Time lost | Proposed fix |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-08-09 | API | blocker | No machine-readable API schema. `GET /api/openapi.json` and `/api/docs` both 404. Every endpoint had to be discovered by guessing paths and reading 404 bodies. | ~30 min | Serve an OpenAPI 3 document at a stable path and link it from the docs nav. It also unlocks generated clients in every language, which removes the "is there an official SDK?" question below. |
| 2 | 2026-08-09 | docs | blocker | The audit-record schema is documented as eight field names in prose (`nodeId, nodeName, nodeType, status, input, output, duration, createdAt`) with no example payload and no statement of whether retries produce additional records. Retry behaviour is the single thing an observability integration needs to know, and it cannot be answered without running a live execution. | unresolved, blocking | Publish one full example response for `GET /api/workflows/executions/{id}/logs` covering an execution that retried at least once, and state explicitly in prose whether retry attempts append rows or mutate one row. |
| 3 | 2026-08-09 | docs | friction | "Retry logic with exponential backoff", "gas optimization", "private routing", and "nonce management and transaction ordering" are listed as platform capabilities but none maps to a documented field, parameter, or endpoint. They read as marketing, so a caller cannot tell whether they are observable, configurable, or neither. | ~20 min | For each capability bullet, link to the field or config that exposes it — or mark it explicitly as internal-only behaviour with no API surface. |
| 4 | 2026-08-09 | docs | friction | `usePrivateMempoolRpc` is a per-chain boolean returned by `GET /api/chains`, and it is `false` for Base and Base Sepolia while `true` for Ethereum. This means private routing simply does not exist on some supported chains. Nothing in the docs says so; it was found by diffing the chains response. A build that assumed private routing was universally available would have been designed wrong. | ~25 min | Add a chain-capability matrix to the docs (chain × private mempool × gas sponsorship × any other per-chain feature). Call out in the private-routing section that availability is chain-dependent, and name the field. |
| 5 | 2026-08-09 | API | friction | The org key (`kh_`) returns 401 on `/api/organizations`, `/api/keys`, and `/api/user` with a bare `{"error":"Unauthorized"}`. No scope list, no hint at which key type is required, no docs page describing key scopes. Indistinguishable from an expired key at first glance. | ~15 min | Return a scoped error body (`{"error":"insufficient_scope","required":"...","granted":[...]}`) and document the key types and their scopes in one table. |
| 6 | 2026-08-09 | API | polish | Two different 404 shapes from the same API: unknown routes return `{"error":"not_found","detail":"Route GET /api/x not found","request_id":"..."}` while unknown sub-resources return `{"error":"Workflow not found"}` with no `request_id`. Inconsistent error envelopes make client-side error handling guesswork. | ~5 min | Use one error envelope everywhere: `error`, `detail`, `request_id`. The `request_id` in particular should never be dropped — it is the only thing that makes a support conversation tractable. |

## Summary

Fill in at the end: counts by severity and area, the three highest-impact
fixes, and the starter template that would have prevented the most entries.
