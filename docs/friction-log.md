# Friction log — building Blackbox on KeeperHub

Where a new builder got stuck, what it cost, and what would fix it.

**Method.** Blackbox is an incident-detection and remediation tool built on
KeeperHub over roughly two weeks. Everything below was hit while building it,
against the live API and the hosted docs. Every claim was then re-verified on
2026-08-10 against the `staging` branch of `KeeperHub/keeperhub` and against
docs.keeperhub.com, and each entry carries a verdict.

**The most important thing in this document is section 2**, where several of our
own complaints turned out to be wrong. We reported things as undocumented that
are documented clearly, and we found by grepping the frontend bundle what was a
docs page away. That is not a docs gap, it is a *discoverability* gap, and it is
a more useful finding than any of the individual entries.

---

## 1. Verified — still reproducible on 2026-08-10

### 1.1 A completed contract-call returns no transaction hash

**Severity: blocker.** This contradicts KeeperHub's own documented behaviour and
costs the caller their audit trail.

`docs/api/direct-execution.md` states:

> `transactionHash` and `transactionLink` are present only when `status` is
> `completed`.

A `POST /api/execute/contract-call` that lands on chain returns:

```json
{ "executionId": "4u327l4wep7q2hwrvqwf2", "status": "completed" }
```

No hash, no link, while the transaction executed — the target contract's state
changed in the same request. `POST /api/execute/transfer` *does* return the hash
inline, so the two execution endpoints disagree in the same API version.

The hash exists and is retrievable from `GET /api/execute/{id}/status`
(`0x487033142c19de9808e71cc15661f4b9ec6b364a29ecda90b6fc00fba3e546a5`, with a
verified receipt). But a caller following the documented behaviour has no reason
to poll: it was told the hash comes back when status is `completed`, and status
*is* `completed`.

Cost us roughly 35 minutes and, worse, a false negative: our remediator recorded
a remediation that had actually succeeded as failed, and discarded the hash,
because it refuses to claim a remediation it cannot point at.

**Fix.** Either return `transactionHash` on the contract-call response when one
exists, or amend that sentence to say the hash is only guaranteed on the status
record and that contract-call callers must poll. One line of documentation
prevents the wrong build; returning the field prevents the question.

### 1.2 The OpenAPI document covers marketplace workflows, not the platform API

An earlier draft of this entry said there was no machine-readable schema at all.
That was wrong, and wrong in an instructive way: we tested
`GET /api/openapi.json`, got a 404, and stopped. The document is served at
`GET /api/openapi` — 100KB of OpenAPI 3.1, and good.

What it describes is 111 marketplace workflow endpoints
(`/api/mcp/workflows/{slug}/call`), so an agent can discover callable
workflows. It contains no path for the platform API a builder integrates
against: no `/api/execute/*`, no `/api/workflows/create`, no `/api/keys`.

So the real gap is narrower than we first claimed and still real: the endpoints
you must call to *build on* KeeperHub have no machine-readable schema, and the
one that exists is at a path a caller is unlikely to guess.

**Fix.** Extend the document to cover the platform API, and serve it from
`/api/openapi.json` as well — that is the path convention every tool tries
first. A generated client cannot miss a documented route, which removes most of
section 2 below.

### 1.3 Direct Execution silently ignores unknown fields

`POST /api/execute/transfer` accepts `nonce`, `maxFeePerGas` and
`maxPriorityFeePerGas` in the body, answers `202`, and ignores all three. The
resulting transaction was sent by a sponsor EOA calling a relayer at the
sponsor's nonce — nonce 29367 against the 1 requested.

The behaviour is correct; sponsored execution cannot honour a caller's nonce.
The problem is silence. The workflow validator, by contrast, is strict and
rejects unknown fields with a precise `UNKNOWN_FIELD` error naming the field —
so the same product does both, and the stricter half is the better half.

**Fix.** Reject unknown fields on the execution endpoints the way the workflow
validator already does. A silently dropped parameter is indistinguishable from
an honoured one, which is how we spent 45 minutes and a design decision on a
capability that does not exist.

### 1.4 Wallet sign-in silently creates a second account

Signing in with a wallet whose address is not yet linked creates a brand new
user and organization rather than offering to link it. An operator who signed up
with Google and later signs in with their wallet lands in an empty org with none
of their workflows, keys or wallets, and nothing on screen says a new
organization was created. **Fix:** on wallet sign-in with an unlinked address,
ask whether to create a new account or link to an existing one. At minimum,
confirm on screen that a new organization was created.

### 1.5 Rate-limited step-up challenges are single-use and self-invalidating

Sensitive actions answer with `{"code":"signature_required","challenge":"…"}`.
Every subsequent request to that endpoint mints a *fresh* challenge, including
requests that are themselves attempts to answer one. Probing a few candidate
response shapes therefore invalidates the challenge you are holding, and then
trips a rate limiter that returns `{"code":"rate_limited"}` with no
`Retry-After`. **Fix:** give an issued challenge a short TTL instead of
superseding it on the next request, and send `Retry-After` on 429 — the
quickstart tells clients to read that header, so the auth path should send it.

### 1.6 Three fields on the status record are undocumented

`retryCount`, `gasPriceWei` and `estimatedCostUsd` appear on
`GET /api/execute/{id}/status` and in no documentation. `receipts` and
`sponsored` are documented and were genuinely useful. **Fix:** add the three to
the status schema reference. `retryCount` in particular is the answer to "does
the audit trail expose retries", which is the first question an observability
integration asks.

---

## 2. Withdrawn — documented, and we failed to find it

These were in an earlier draft of this log as "undocumented". They are not. We
report them anyway because *why* we missed them is the actionable part.

| We claimed | Reality |
| --- | --- |
| The two API key types are undocumented | `docs/api/api-keys.md` opens with a table naming `kh_` and `wfb_`, the route that mints each, and what each unlocks |
| `POST /api/workflows` is 405, so programmatic creation is not discoverable | `docs/api/workflows.md` documents `POST /api/workflows/create`. We guessed a REST-conventional path, got 405, and concluded the feature was missing |
| Workflow action field names are undocumented | `docs/api/workflows.md` has a gotcha table for exactly this, and warns that the legacy `functionName`/`args` shape saves but fails at runtime |
| Per-chain private mempool availability is undocumented | Documented, and further clarified by PR #1983 during this hackathon |

**What actually went wrong.** We started from the API rather than the docs,
and every time the API answered ambiguously we escalated to reading the
frontend bundle instead of searching the documentation. The docs were good; our
path into them was not. Two things would have caught every one of these:

1. **An OpenAPI document** (see 1.2). We would have generated a client and never
   guessed a route.
2. **Error bodies that link to their own docs page.** The 405 on
   `POST /api/workflows` is a dead end. `405, see /api/workflows#create-workflow`
   would have ended that detour in seconds, and the same pattern would have
   pointed us at the key-type table the first time a `wfb_` key returned 401.

That second one is a small, mechanical change with a large effect on exactly the
moment a new builder is most likely to give up.

---

## 3. What this cost us, and what it caught

Following the documented sequence in `docs/api/direct-execution.md` — simulate,
check `wouldRevert`, execute with an `Idempotency-Key`, poll on
`X-Poll-Interval-Hint`, trust the verified receipt — turned out to matter more
than any individual endpoint detail. We were not doing any of it, because we
built from the API surface rather than the guide.

Adopting it changed the product: remediations are now pre-flighted, so one that
would revert is never broadcast; retries carry a derived idempotency key, so an
interrupted client cannot double-spend; and the transaction hash comes from a
verified receipt rather than a self-reported field.

**Fix, and the highest-leverage one in this document.** That sequence is the
single most valuable page in the docs and it is reachable only by already
knowing to open Direct Execution. Put it in the quickstart, before the first
`curl`. A builder who follows the quickstart today writes the naive version we
wrote.
