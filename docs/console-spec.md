# Blackbox Console — build spec

Everything needed to build the UI without reading the backend. The API does not
exist yet; a mock that serves the exact shapes does. Build against the mock, and
the real server drops in behind it unchanged.

**What Blackbox is:** it watches onchain agents execute transactions, detects
when execution goes wrong, explains why, and fixes it with a real transaction.
The console is the forensic surface over that.

**The design constraint, before anything else.** This is a tool an SRE keeps
open during an incident, not a marketing dashboard. Dense, monospace-leaning,
information-first. Every number on screen should be a real measured value with
units. No decorative cards, no sparkline that means nothing, no gradient hero.
Credibility comes from looking like something you'd trust at 3am.

---

## Running the mock

```bash
node tools/mock-api.mjs          # http://localhost:4001
PORT=5001 node tools/mock-api.mjs
```

Zero dependencies. It serves five seeded incidents covering every visual state,
advances one through its lifecycle every 6 seconds so the live feed visibly
moves, and streams every change over SSE. Transaction hashes in the fixtures are
real Sepolia transactions, so explorer links resolve.

CORS is wide open. The console runs on a different port in development.

---

## Vocabulary

Seven things can go wrong. The UI never invents its own names for these.

| Class | Means | Typical severity |
| --- | --- | --- |
| `STUCK_TRANSACTION` | Submitted, still pending well past normal | warning |
| `NONCE_GAP` | A hole in the nonce sequence wedges everything behind it | critical |
| `GAS_UNDERPRICED` | Bid has fallen below the market since submission | warning |
| `SIM_PASS_EXEC_REVERT` | Simulated clean, reverted on chain — state drifted underneath | critical |
| `RETRY_STORM` | Same action failing over and over, burning gas | critical |
| `SIGNER_GAS_STARVED` | Balance no longer covers the next action | critical |
| `ADVERSE_INCLUSION` | Landed, but at a materially worse price than quoted | warning |

**Status** is a lifecycle: `open → diagnosing → remediating → resolved`, plus
`acknowledged` (a human took it) and `failed` (remediation could not fix it).

**Severity** is `critical | warning | info`.

**`resolvedBy`** is `blackbox | external | unknown` — did Blackbox fix it, did
something else, or do we not know. This distinction matters more than it looks:
it is the difference between the product working and the problem going away.

**Rule IDs** `R1`–`R7` map to the classes above in order. Show them. Detection
being mechanical and auditable is the point, so the rule that fired is evidence,
not an implementation detail.

---

## Shared shell

Present on every page.

**Left rail or top nav** — three destinations: Timeline, Incidents (same data,
filterable table), Chaos. Keep it to three; there is no settings page.

**Header strip** — always visible, driven by `GET /api/stats` and refreshed by
the `stats.updated` SSE event:

- Open incidents by severity — three counts, colour-coded, critical first
- Remediations: total, succeeded, skipped, failed, and total gas spent
- Mean time to detection
- Mean time to remediation

Format durations as `41s` / `1m 03s`, never `41000ms`. Format wei as gwei or ETH
with the unit stated. Never show a raw wei integer to a human without a unit.

**Live indicator** — a dot showing SSE connection state: connected, reconnecting,
disconnected. When disconnected, the feed is stale and the user must be able to
tell at a glance. Reconnect with backoff and replay `GET /api/incidents` on
reconnect, because events during the gap were missed.

**Chain banner** — the active chain, and whether it is a testnet. If a mainnet
chain is ever active this must be unmistakable.

---

## Page 1 — Incident timeline (landing, `/`)

The demo lives here. Vertical feed, newest first, live-updating.

### Row anatomy

One line per incident, scannable in a column:

```
● CRITICAL  NONCE_GAP    chaos · 0xb9c5…28BA   2m ago
            Nonce 47 unfilled; 1 action blocked behind it        [ RESOLVED ]
```

- **Severity dot** — colour by severity
- **Class badge** — monospace, uppercase
- **Agent + truncated signer** — `0xb9c5…28BA` form, full value on hover/copy
- **Relative time** — `2m ago`, updating live; absolute timestamp on hover
- **Summary** — one line of plain English from `summary`
- **Status pill** — the lifecycle state

### Status transitions animate

`open → diagnosing → remediating → resolved` in a single row is the whole
product told in one motion. When a `remediation.succeeded` event arrives, the
row should visibly resolve and surface its transaction hash as an explorer link.
This is the moment the demo turns on — give it real attention.

### Filters

Class, severity, status, agent, chain. All map to query parameters on
`GET /api/incidents`. Filter state belongs in the URL so a view is shareable.

### States to build

| State | What to show |
| --- | --- |
| Loading | Skeleton rows, not a spinner — the layout should not jump |
| Empty (no incidents) | "No incidents. Induce one from the Chaos panel." with a link |
| Empty (filters exclude everything) | Distinguish from the above; offer to clear filters |
| Error | The `detail` field from the error body, plus a retry control |
| Disconnected | Banner: the feed is stale, with reconnect state |

---

## Page 2 — Incident detail (`/incidents/:id`)

Four panels. Order matters — evidence before narrative, because the mechanical
facts are what make the narrative trustworthy.

### 2.1 Evidence

The raw facts that tripped the rule, with the rule ID and the threshold each
fact was compared against. Render `evidence.facts` as a key/value table in
monospace, and `evidence.thresholds` beside the fact it bounds where possible:

```
R2  NONCE_GAP                              confidence 0.90
missingNonces          [47]
latestNonce            47
pendingNonce           47
blockedActionCount     1
consecutiveGapPolls    2        threshold  2
```

Also render `evidence.corroboration` — the independent chain readings taken at
detection time (balance, base fee, nonces). It is what separates a claim from a
measurement. `evidence.suppressedRules` lists rules that also fired but were
suppressed by a more specific one; show it when non-empty, since a hidden R1
under an R3 is otherwise confusing.

Wei values arrive as decimal strings. They exceed `Number.MAX_SAFE_INTEGER` —
use `BigInt` and format for display. Never `parseInt` them.

### 2.2 Event timeline

Event by event, oldest first, with timestamps and block numbers. Each event has
a `kind` (`submission`, `detection`, `rca`, `remediation`, `inclusion`) — give
each a distinct icon. Rows with a `txHash` link to the explorer.

### 2.3 Root cause analysis

`rca` is LLM-generated and **must be visually distinguished** from measured
facts — different background, a label saying so. Fields: `narrative`,
`contributingFactors[]`, `prevention`, `confidence`, `model`, `generatedAt`.

`rca` is `null` until diagnosis runs. Show a quiet placeholder, not an error.

### 2.4 Remediation

Playbook name and ID, then the outcome. Three shapes, all equally important:

**Succeeded** — the transaction hash as a prominent explorer link. This is the
product's proof of work; it should be the most visually significant element on
the page. Show gas used and which executor submitted it (`signer` or
`keeperhub`).

**Skipped** — `finalStatus` of `skipped_by_guard` or `skipped_by_policy`, with
the reason rendered at *equal prominence to a success*. Blackbox declining to
act with a stated reason is correct behaviour and a feature. Do not grey it out
or tuck it away.

**Failed** — `failureReason`, plus any transaction hash that was submitted.

Always render `guardsPassed` and `guardsFailed`. Eight guards run and all are
evaluated independently, so several can fail at once — show all of them, not
just the first.

### Actions

- **Acknowledge** — `POST /api/incidents/:id/acknowledge`
- **Remediate now** — `POST /api/incidents/:id/remediate`. Confirm first: this
  spends real gas. The response may come back `accepted: false` with
  `guardsFailed` — that is a normal outcome, render it in place, not as an error
  toast.

---

## Page 3 — Chaos panel (`/chaos`)

Induces real failures against real testnet contracts. Everything here spends
real testnet gas.

- **Warning banner naming the active chain.** Non-negotiable. The harness is
  hard-restricted to testnets in code, but the UI must still say which one.
- **Scenario buttons**, one per `C1`–`C6`, each showing what it induces, whether
  it is deterministic, and its note. Disabled scenarios (`enabled: false`) must
  show *why* — `C6` needs controllable block ordering and only runs on a local
  fork.
- **Chaos signer balance and address**, live. A drained signer is the most
  common reason a scenario silently does nothing.
- **Target contract addresses** — `chaosTarget` and `circuitBreaker`, with
  explorer links.
- **Run full sweep** — fires every enabled scenario in sequence.

After firing, show the returned `txHashes`, the `expectedIncidentClass`, and
`expectedDetectionSeconds` — then let the user watch the incident appear in the
timeline. Wiring the button to the resulting incident is the demo.

---

## API reference

Base URL `http://localhost:4001`. All responses JSON. Errors:

```json
{ "error": "not_found", "detail": "Incident inc-99 not found", "requestId": "req-104" }
```

### `GET /api/incidents`

Query: `status`, `class`, `severity`, `agentId`, `signer`, `chainId`, `limit`.

```json
{
  "items": [{
    "id": "inc-1",
    "class": "NONCE_GAP",
    "severity": "critical",
    "status": "resolved",
    "agentId": "chaos",
    "signer": "0xb9c58185d09D0aCf3b237cD45C67345E32e628BA",
    "chainId": 11155111,
    "summary": "Nonce 47 unfilled; cleared by Blackbox",
    "detectedAt": "2026-08-10T06:29:26.557Z",
    "lastSeenAt": "2026-08-10T06:31:06.557Z",
    "resolvedAt": "2026-08-10T06:31:01.557Z",
    "resolvedBy": "blackbox",
    "confidence": 0.9,
    "ruleId": "R2",
    "hasRca": true,
    "remediationStatus": "succeeded",
    "remediationTxHash": "0x68a38ff1…"
  }],
  "nextCursor": null,
  "total": 5
}
```

### `GET /api/incidents/:id`

The summary fields above plus `evidence`, `rca`, `remediation`, `events[]`,
`explorerUrls[]`. See the mock for a full example of each.

### `POST /api/incidents/:id/remediate`

`202` with `{ accepted: true, playbookId, attemptId }`, **or** `200` with
`{ accepted: false, guardsFailed: [{ guard, reason }] }`. Both are normal.

### `POST /api/incidents/:id/acknowledge` → updated summary.

### `GET /api/stats`

```json
{
  "openBySeverity": { "critical": 2, "warning": 2, "info": 0 },
  "remediations": { "total": 2, "succeeded": 1, "skipped": 1, "failed": 0, "gasWei": "21000" },
  "meanTimeToDetectionMs": 41000,
  "meanTimeToRemediationMs": 63000,
  "updatedAt": "2026-08-10T06:31:28.695Z"
}
```

### `GET /api/signers/:signer/health?chainId=`

Balance, latest/pending nonce, `missingNonces[]`, runway in actions, open
incidents, recent failure rate.

### `GET /api/config`

Chains with `privateMempool` and explorer URL templates, remediation policy
(`dryRun`, allowlists, budget). Use it to build explorer links rather than
hardcoding a chain.

### `GET /api/agents`, `GET /api/chaos/scenarios`, `POST /api/chaos/run`

See the mock. `chaos/run` takes `{ "scenario": "C2" }`.

### `GET /api/stream` — SSE

| Event | Payload |
| --- | --- |
| `hello` | `{ at, chainId }` on connect |
| `incident.created` | incident summary |
| `incident.updated` | incident summary |
| `remediation.started` | `{ incidentId, playbookId }` |
| `remediation.succeeded` | `{ incidentId, txHash, explorerUrl }` |
| `remediation.failed` | `{ incidentId, reason }` |
| `chaos.started` | `{ runId, scenario, at }` |
| `chaos.completed` | `{ runId, scenario, incidentIds[] }` |
| `stats.updated` | the stats object |

Comment frames (`: ping`) arrive every 15s as keepalive — ignore them.

---

## Rules that are easy to get wrong

1. **Wei is a decimal string, always.** `BigInt`, never `Number`.
2. **Timestamps are ISO 8601 UTC strings.** Render relative, but keep the
   absolute value available on hover.
3. **A skipped remediation is not a failure.** Same visual weight as a success.
4. **`resolvedBy: "external"` means Blackbox did not fix it.** Do not show a
   success state for it.
5. **Reconnecting SSE is not enough** — refetch the list, because events during
   the gap are gone.
6. **Truncate addresses in display, never in copy.** Copy gives the full value.
7. **The rule ID and thresholds are content, not debug output.** Ship them.

---

## Out of scope

Auth, multi-tenancy, settings/config editing, dark/light toggle (pick one look
and commit), mobile-first layouts. This is a desktop operator tool; it should
degrade gracefully below 1280px but is not designed for phones.
