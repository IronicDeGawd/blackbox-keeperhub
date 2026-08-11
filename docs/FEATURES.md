# Blackbox — feature audit

Every capability, what proves it, and what actually happened when it was run.

Audited **2026-08-11** against the live deployment
`https://blackbox-kh.parakramlabs.com`, the live KeeperHub organisation
`7xqazg6qi91img6phh7gu`, and Sepolia. Nothing below is inferred from the test
suite alone — where a row says *live*, it was exercised against the real thing.

**Result: 71 of 74 checks passed** on the first pass, over 74 checks; a second
pass added the MCP surface and a real second tenant, for **94 checks in total**. Three failed and are
listed as findings, with seven more raised by reading output that had passed —
and one more found while fixing another, making eleven.

**All eleven are now fixed and verified against the same live system.** The HTTP
sweep re-run afterwards is **40 of 40**. Each finding below carries its fix and
the evidence for it.

Harnesses:

| Harness | What it covers | How to run |
| --- | --- | --- |
| `tools/audit/http-audit.sh` | all 29 HTTP routes, live | `H=<host> bash tools/audit/http-audit.sh` |
| `packages/api/src/features.test.ts` | every rule, playbook, alert and normaliser (pure, no I/O) | `pnpm --filter @blackbox/api exec vitest run src/features.test.ts` |
| `tools/audit/audit-live.ts` | KeeperHub-facing features, live | copy into `packages/api/src`, run with vitest |
| `tools/audit/audit-cycle.ts` | wallet-signed chaos, end to end | as above — **spends real gas** |
| `tools/audit/audit-fix.ts` | propose-and-verify remediation | as above — **spends real gas** |
| `tools/audit/audit-mcp.ts` | the MCP surface, and a new tenant | as above — **creates a real KeeperHub account** |

The last three live in `tools/` rather than in a package on purpose: they mutate
a real organisation and spend real money, and must never run in CI.

---

## 1. Detection — the rule set

Each rule was evaluated against a window built for it and its output recorded.

| Rule | Class | Applies to | Result |
| --- | --- | --- | --- |
| R1 | STUCK_TRANSACTION | signer | ✅ fired, `pendingDurationMs 900000` vs threshold `90000` |
| R2 | NONCE_GAP | signer | ✅ fired, `missingNonces [7,8]` |
| R3 | GAS_UNDERPRICED | both | ✅ fired, `feeDeficitPct 99.95` |
| R4 | SIM_PASS_EXEC_REVERT | both | ✅ fired, `blockDrift 4`, reason carried through |
| R5 | RETRY_STORM | both | ✅ fired, 4 attempts, `84000000000000` burned |
| R6 | SIGNER_GAS_STARVED | signer | ✅ fired, `projectedActionsRemaining 0` |
| R7 | ADVERSE_INCLUSION | both | ✅ fired, `deltaBps 1000` — **only for a publicly-routed transaction**, which is correct and was initially mis-tested by the audit itself |
| R8 | SPEND_CAP_EXHAUSTED | keeperhub | ✅ fired `warning` at ratio 0.86; **live** against the real cap, and `critical` at 1.72 |
| R9 | EXECUTION_STALLED | keeperhub | ✅ fired at `stalledMs 700000` |
| R10 | WORKFLOW_MISCONFIGURED | keeperhub | ✅ fired, 3 rejections at the same step |

Cross-cutting behaviour:

- **Applicability** — `keeperhub` is offered `R3 R4 R5 R7 R8 R9 R10`; `signer` is
  offered `R1 R2 R3 R4 R5 R6 R7`. ✅ published live at `/api/config`.
- **Suppression** — R10 fires and absorbs R5 (`suppressed: ["R5"]`). ✅
- **Managed nonces** — the recorder does not derive a nonce gap for a managed
  wallet, and records `corroboration.managedNonces` instead. ✅ (regression test
  proven to fail without the guard)

## 2. Ingestion

| Feature | Result |
| --- | --- |
| KeeperHub run listing (`/api/analytics/runs`) | ✅ **live** — 20 runs: 7 direct/success, 6 workflow/success, 6 workflow/error, 1 direct/error |
| Verified receipts read from their side | ✅ **live** — 4 runs carried a verified receipt |
| Pre-flight rejections captured | ✅ **live** — 7 runs failed before producing any transaction |
| High-water-mark sweep, idempotent | ✅ first sweep stored 19 runs, second stored 0 |
| Run normalisation — workflow success | ✅ `included` |
| Run normalisation — pre-flight rejection | ✅ `rejected`, simulation marked failed |
| Run normalisation — direct run by network *name* | ✅ `included` |
| Run normalisation — unreadable chain | ✅ dropped, counted, not guessed |
| `resolveNetwork` both forms | ✅ `11155111` → 11155111, `sepolia` → 11155111, `solana` → null |
| Chain scanning for signer-kind agents | ✅ **live** — the block scanner watches 2 registered signers |

## 3. Remediation

| Feature | Result |
| --- | --- |
| Class → playbook routing | ✅ 8 of 10 classes route (see finding 3) |
| P1 replacement / P2 fill-nonce / P3 reroute / P4 breaker / P5 top-up | ✅ all declare `appliesTo` and `executors` |
| Routing honesty (E4) | ✅ **live** — `P2 needs one of signer, user-signed; this deployment has keeperhub, keeperhub-workflow` |
| Guarded pause (E1) | ✅ acts when live, skips with `already_paused` when not |
| Guarded pause against a real contract | ❌ **finding 4** — their API demands an ABI for an unverified contract |
| Protocol actions (E2) | ✅ **live** — catalogue fetched |
| Tempo sign-and-hold (E3) | ⚠️ client implemented; **not executed** — it moves real money, so the audit read the route rather than firing it |
| Seven guards | ✅ **live** — 6 passed, `signer_allowlist` correctly blocked autonomous action |
| Propose-and-verify | ✅ **live, end to end** — see §7 |

## 4. Alerting

| Feature | Result |
| --- | --- |
| A human sentence for all 10 incident classes | ✅ e.g. *"audit: nonce 47 unfilled, 2 actions blocked"*, *"daily spending cap 86% used"* |
| Lifecycle: opened → escalated → resolved | ✅ exactly three alerts from four evaluations |
| Deduplication | ✅ a repeated incident says nothing |
| Default policy is critical-only | ✅ a warning is dropped |
| Quiet hours, wrapping midnight, with offsets | ✅ drops a warning, passes a resolution |
| Discord / Slack renderers | ✅ `{"content":"**opened** · audit: nonce 47 unfilled…"}` |
| Webhook channel | ✅ posts, throws on a non-2xx |
| KeeperHub email channel | ✅ reuses one workflow rather than creating many |
| A dead channel does not block the others | ✅ and does not cause a re-announcement |
| Raw event webhook (D5) | ✅ signed `t=…,v1=…`, saturation drops counted, replay-proof |

## 5. Identity and ownership

| Feature | Result (all **live**) |
| --- | --- |
| Sign in with an organisation key | ✅ 201, org `7xqazg6qi91img6phh7gu` |
| Reject a webhook (`wfb_`) key | ✅ 400 |
| Reject an invalid key | ✅ 401 |
| Session lookup | ✅ 200 with the org; 401 without a token |
| Sign out revokes | ✅ 401 afterwards |
| OAuth "Connect KeeperHub" | ✅ authorize URL, `mcp:read`, PKCE `S256` |
| OAuth open-redirect guard | ✅ 400 for an offsite `returnTo` |
| OAuth replayed/unknown state | ✅ 401 |
| Wallet challenge | ✅ names the domain, disclaims transactions |
| Wallet signature accepted, replay refused | ✅ `unknown_nonce` on the second try |
| Claim on registration | ⚠️ **finding 2** — skipped when the address is already watched |
| Cross-tenant reads blocked | ✅ 404 (not 403, so an id is not confirmed) |
| Cross-tenant actions blocked | ✅ 403 |
| Keys and tokens at rest | ✅ zero rows contain a `kh_` or `bb_` value |

## 6. KeeperHub-driven triggers and webhooks

| Feature | Result |
| --- | --- |
| Inbound nudge requires a secret | ✅ **live** 401 without, 200 with |
| Nudge ignores its body | ✅ **live** — a fabricated run in the body created nothing |
| Nudge is idempotent | ✅ repeated calls sweep again, no duplicate incident |
| Secret minting requires a session | ✅ **live** 401, then 201 with a `whsec_` and the code-node snippet |
| Secret stored as a hash | ✅ the table contains no secret |
| Schedule trigger install | ❌ **finding 5** — `code/run-code` needs a paid plan (402) |
| Contract-event trigger install | ❌ same cause |
| Interval floor | ✅ refuses 30s with a clear message |
| Block / Transfer triggers | ⚪ deliberately not offered — their config fields are unpublished |

## 7. The headline path, end to end and live

Run against the deployment on 2026-08-11. Every step is a real transaction.

1. **Plan** — `POST /api/chaos/plan` returned a C2 plan: *"Send at nonce 123,
   skipping 122"*, detection estimated at 90s.
2. **Sign** — our wallet, not Blackbox, broadcast
   [`0xf77e253a…`](https://sepolia.etherscan.io/tx/0xf77e253a2500ffe26aeb6852e918f9e2c332f2db883765c169077673b2713e00)
   at nonce 123, leaving 122 unused.
3. **Observe** — `POST /api/chaos/observe` attributed it to the signer read from
   chain, nonce 123. This is the only way Blackbox could learn of it: a queued
   transaction is in no block.
4. **Detect** — unattended, in **≈40 seconds** (estimate was 90):
   `NONCE_GAP · "Nonce 122 unfilled; 1 action(s) blocked behind it"`, rule R2.
5. **Refuse honestly** — `remediate` returned
   `skipped_by_policy: P2 needs one of signer, user-signed; this deployment has
   keeperhub, keeperhub-workflow`, with 6 guards passed and `signer_allowlist`
   failed.
6. **Offer the fix** — the plan carried the exact transaction: *"fill missing
   nonce 122"*.
7. **Sign the fix** — [`0x5f80b82d…`](https://sepolia.etherscan.io/tx/0x5f80b82d4aeb446b81b74e76bfd7ac4be7445ac7e6a5bed68738d2168252afa8),
   mined in block 11466514.
8. **Verify** — `remediation-tx` answered `accepted: true, included: true,
   gasUsed: 21000`, recorded the attempt as `user-signed`, and the incident is
   `resolved`. The queued transaction then executed: the account's nonce moved
   from 122 to **124**, so both the fill and the previously stuck transaction
   landed.

## 8. MCP — Blackbox as a tool, and KeeperHub as one

The surface an *agent* uses rather than a person, which the first pass missed
entirely. All exercised live against the deployment.

| Tool | Result |
| --- | --- |
| `list_incidents` | ✅ returned the audit's own NONCE_GAP, resolved |
| `get_signer_health` | ✅ *"holds 60331275632120200 wei, nonce 124 (pending 124), 0 open incident(s)"* |
| `diagnose_execution` | ✅ explained a real hash, and said plainly that no rule fired |
| `watch_address` | ✅ registered and confirmed |
| `get_remediation_plan` | ✅ *"P2: fill missing nonce 122 … must be signed by 0xb9c5…"* |
| `request_remediation` | ✅ **refused without `authorized: true`** — the only tool that spends money, and an agent must not reach it by accident while exploring |
| malformed arguments | ✅ returned as a readable result an agent can correct, not a transport error |
| tool descriptions | ✅ all six present, so a model can choose between them |

And the other direction — Blackbox as an MCP *client* of KeeperHub:

| Feature | Result |
| --- | --- |
| List their tools | ✅ **live** — 44 tools |
| Call one | ✅ **live** — `list_executions` returned real runs |

## 9. A genuinely new tenant

Tenancy had only ever been proven against fixtures. This created a real second
organisation and checked it from the outside.

A fresh wallet `0xe6abB952…` signed in to KeeperHub, which creates a new user
*and* a new organisation for an address it has not seen. That organisation
minted its own key, and used it to sign in to Blackbox:

| Check | Result |
| --- | --- |
| Blackbox sign-in with a brand-new org key | ✅ 201, org `ox6545scegkdi3k01lkhj` |
| Resolves to a *different* tenant from ours | ✅ not `7xqazg6qi91img6phh7gu` |
| Owns nothing on arrival | ✅ `agents: []` |
| Claiming an agent we own | ✅ **403 — "Agent 0xb9c58185 belongs to another organisation"** |
| Registering something of its own | ✅ 201, `owned: true` |
| Reading the public demo | ✅ sees the demo incidents |

That is the ownership model working against a stranger rather than a stub.

## 10. Package coverage

Every package has its own suite, run in CI:

| Package | Tests |
| --- | --- |
| core | 74 |
| detector | 89 |
| recorder | 69 |
| remediator | 99 |
| api | 157 |
| store | 32 |
| diagnostician | 37 |
| alerter | 21 |
| mcp | 21 |
| chaos | 16 |

The one surface never exercised live is **server-signed chaos** (`/api/chaos/run`
and the harness behind it). It needs a spendable key, which this deployment
deliberately does not hold — its 404 there is the feature working. It is covered
by the chaos package's own suite and by the wallet-signed path, which is the
one a visitor actually uses.

## 11. Deployment

| Feature | Result |
| --- | --- |
| HTTPS with a real certificate | ✅ Let's Encrypt, `CN=blackbox-kh.parakramlabs.com`, to 9 Nov |
| HTTP redirects | ✅ 308 |
| Both hostnames served | ✅ the sslip.io name still resolves |
| Migrations on deploy | ✅ 11 applied |
| SSE stream | ✅ `event: hello` |
| Rate limiting | ✅ per-route budgets in place |
| Mainnet chaos refused | ✅ 400 |
| `chaos/run` absent without a key | ✅ 404 — the deployment holds no spendable key |
| Vertex diagnosis | ✅ **live** — explained a real hash |
| Scenario catalogue | ❌ **finding 1** — 404 on this deployment |

---

## Findings

Ordered by what they cost, not by how hard they are to fix.

### 1. The scenario catalogue is invisible on the public deployment
`GET /api/chaos/scenarios` is gated behind `options.chaos`, which is off here
because the deployment holds no key. But `chaos/plan` — the wallet-signed path a
visitor actually uses — *is* on. So a console can offer the scenarios it cannot
list. **Fix:** gate the catalogue on `chaos || chaosPlan`.

**Fixed** (`4676748` line of work, catalogue in `chaos-plans.ts`). A deployment offering only wallet-signed chaos now serves its own catalogue. Live: six scenarios listed, four marked signable, C5 and C6 explained rather than hidden.

### 2. Registering an already-watched address skips the ownership claim
`registerWatch` returns early when the signer is already watched — a guard
against relabelling somebody else's row — but that return happens *before* the
agent is claimed. An operator registering an address that is already watched
therefore never takes ownership. Observed live: the response carried no `owned`
field, and a second caller could then register under the same agent id.
**Fix:** claim the agent id even when the watch row already exists; the early
return should only protect the row, not skip the claim.

**Fixed.** The early return still protects the row from being rewritten, but the claim now happens either way — it is about the agent id the caller named, not the row. Live: registering an address watched earlier by an anonymous visitor returned `owned: true`, and a second organisation was then refused with 403.

### 3. Two new detections have no remediation
`EXECUTION_STALLED` and `SPEND_CAP_EXHAUSTED` route to no playbook, so Blackbox
can see them and can do nothing about them. That is arguably correct for a spend
cap — raising it is a KeeperHub billing action, not a transaction — but it
should say so rather than answer "no playbook handles this".
**Fix:** a declining playbook for each, carrying the instruction ("raise the cap
in KeeperHub", "the workflow is still running; here is its id").

**Fixed.** P6 and P7 decline with the instruction: a stalled workflow is KeeperHub's to cancel or re-run and no transaction can end it; a spend cap is raised in their organisation settings. Both name the workflow or the numbers rather than answering "no playbook handles this".

### 4. Guarded pause cannot read an unverified contract
`check-and-execute` answered
`ABI is required. Could not auto-fetch ABI … Contract may not be verified` for
our own circuit breaker. E1 therefore works only against a verified contract
unless we pass the ABI. **Fix:** send the breaker ABI with the call — we own the
contract and have its ABI — and surface a clear error when one is missing.

**Fixed.** A minimal breaker ABI is always sent, on the read and on the action. Verified against the same unverified contract that failed: 200, and it correctly declined because the breaker is already tripped.

### 5. KeeperHub-driven triggers need a paid plan
Installing either trigger fails with 402 `upgrade_required`: the `code/run-code`
action is Pro-only, and it is the only action type on their platform that can
call an external URL. Their other actions are contract calls, transfers, Discord,
SendGrid and AI text. **Fix:** enable the Pro trial on the organisation and
re-run the install; and until then, say so in `/api/config` rather than failing
at install time. Our own tick already covers the gap.

**Fixed** as far as it can be without paying. The gate is read at startup and published at `/api/config`; an install that hits it answers 402 with the reason instead of 502. Live: `{"available": false, "reason": "KeeperHub triggers need a paid plan…"}`. The Pro trial is 14 days, confirmed live from their billing endpoint, and this organisation is eligible — the trigger install itself stays unproven until it is started.

### 6. *(upstream)* KeeperHub lists soft-deleted workflows
`DELETE /api/workflows/{id}` soft-deletes by setting `deleted_at`, but
`GET /api/workflows` filters only on `organizationId`, so a deleted workflow
still appears. Verified: deleted a probe workflow, got 200, and it remained in
the list. This bites us directly — our installer matches by name against that
list and would patch a dead row instead of creating a live one.
**Fix:** a PR to KeeperHub adding the `deleted_at` filter; on our side, tolerate
it by treating a patch failure as a reason to create.

**Tolerated on our side.** A failed patch is now taken as a reason to create, so a deleted row can no longer swallow an install — while the plan gate is still recognised for what it is rather than retried as a missing workflow. The upstream fix is still worth a PR.

### 7. `actionable: false` is ambiguous
The remediation plan sets `actionable: false` when Blackbox cannot act
autonomously, *even when it is offering a transaction for a wallet to sign*. A
console reading that field would hide the sign button on a plan that has one.
**Fix:** separate "Blackbox can act" from "there is something to sign".

**Fixed.** `signable` says whether a wallet has something to sign; `actionable` keeps its narrower meaning of whether Blackbox could act unattended. Live on the audit's own incident: `actionable false, signable true`.

### 8. A wallet-signed fix is recorded as resolved `external`
The incident above was planned by Blackbox and signed through its own route, but
`resolvedBy` reads `external`. The attempt correctly records
`executor: user-signed`, so the information is there — the summary field is what
understates it. **Fix:** a `user-signed` value for `resolvedBy`.

**Fixed.** It records `blackbox-proposed`, a value the attribution type already had and nothing was using. The historical incident was corrected in place.

### 9. `meanTimeToRemediationMs` ignores wallet-signed fixes
It counts only incidents resolved by `blackbox`, so the run above — a genuine
Blackbox-planned remediation — left it `null`. Follows from finding 8.

**Fixed.** Both attributions count. Live: `60009 ms`, where it had been `null`.

### 10. The ledger's `gasWei` holds gas units
`/api/stats` reported `remediations.gasWei: "21000"` for a transaction that used
21,000 *gas* at ~4 gwei — roughly 84 µETH, not 21,000 wei. The ledger is storing
`gasUsed` in a field named for wei. **Fix:** store `gasUsed × effectiveGasPrice`,
and correct the existing row.

*(Note: this is the same class of mistake found in KeeperHub's own `gasCostWei`
for direct runs, which is documented in `context/plan/keeperhub-native.md`. Easy
mistake, worth being able to point at ours as fixed.)*

**Fixed.** Both write paths multiply by the effective price, which the receipt already carried and neither was reading. The existing row was corrected from `21000` to `65429748111000` — the true cost of 21,000 gas at 3.11 gwei. Live: `/api/stats` now reports that figure.

### 11. The condition verdict was read from a field that does not exist

Found while fixing finding 4, by looking at what their API actually returned.
`check-and-execute` reports the verdict as `conditionResult.met`; the client was
reading a top-level `conditionMet`. A condition that *held* would therefore have
been reported as not held whenever no execution record came back — which is
every simulation. **Fixed**, and the observed value is now carried through as
evidence.

### Not a finding, but worth recording

The audit's own first run reported the headline demo as broken. It was the
harness: the chaos plan carries an **absolute nonce inside `step.transaction`**,
and the harness had invented top-level fields. Re-run against the real schema,
the cycle passed in 40 seconds. A test that fails is not the same as a product
that is broken, and the difference took one API call to establish.
