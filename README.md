# Blackbox

**Autonomous incident intelligence and remediation for onchain agent execution, built on KeeperHub.**

Agents are good at reasoning and bad at execution. Nonce gaps wedge signers, gas
estimates go stale, transactions simulate clean and revert on inclusion, and a
retry loop quietly burns a wallet down.

**Most tooling tells you an agent failed. Blackbox tells you why, with the
numbers it measured.** Not "execution reverted" — *nonce 122 was never filled,
one action is blocked behind it, and that held across five consecutive polls
where two were required*. Ten deterministic rules, each comparing a measured
value against a threshold, so a diagnosis is something you can argue with rather
than a verdict you have to trust. No model decides whether something is wrong.

Then it fixes it, onchain through KeeperHub, as a real transaction with a
retrievable hash. There are no simulated remediations anywhere in the product.

**It is running: [blackbox-kh.parakramlabs.com](https://blackbox-kh.parakramlabs.com/)**
— the console, the live incident feed, and a button that induces a real failure
so you can watch it get caught. No account needed to look.

**Watch it work: [a demo, end to end](https://youtu.be/7dIDS5rjCb0)** — connect
read-only, break something, and watch the incident arrive without a reload.

---

## Proof

Real transactions produced by the system end to end — five on Ethereum Sepolia,
two on **Base mainnet**.

| What happened | Transaction |
| --- | --- |
| **A KeeperHub workflow Blackbox wrote and ran** paused a failing agent's circuit breaker | [`0x783823d5…`](https://sepolia.etherscan.io/tx/0x783823d5ee3afa43222b7ff432faeb45e1e3285d54673ab5b6af5b907248c9a9) |
| Blackbox filled a nonce gap it detected, unwedging the signer | [`0xb1982439…`](https://sepolia.etherscan.io/tx/0xb198243930fc745817914dd6ff4fee5e57d4a357b7c632b55743dafd292a57ed) |
| A user's wallet signed a fix Blackbox planned, which Blackbox then verified | [`0x59563255…`](https://sepolia.etherscan.io/tx/0x5956325573c201d473812a08d0b0aeb96d2c3bace24954835bfda62e0e08d22e) |
| Chaos: a call that simulated clean and reverted one block later | [`0xa0dbdb74…`](https://sepolia.etherscan.io/tx/0xa0dbdb74dc0f19bdcfb6a8cc983b36a9fdbc548af0c716d363500befb45901c6) |
| An agent paid Blackbox over x402 for a diagnosis — USDC settled on **Base mainnet** | [`0x8cd8d6ac…`](https://basescan.org/tx/0x8cd8d6ac5dae125e5f3cf039db1ffb7f6b7dafa44243396d00e30074a93a51f9) |
| **A remediation on Base mainnet, gas sponsored by KeeperHub** — R10 detected on nine real failed runs, then P4 paused the agent's breaker | [`0x1934f328…`](https://basescan.org/tx/0x1934f328c7a32e1d037e992c667d208e80214bb24affd3de6b93c37b3dcf2b3b) |
| A watched wallet ran itself down to no runway, and was told so | [`0x5aa0a47c…`](https://sepolia.etherscan.io/tx/0x5aa0a47c64c7030e3e72dbc5a114cd3ff3c2161c6042ac9aefbe573aa1852070) |

The first one is the interesting one. Blackbox detected a retry storm, decided
to halt the agent, **created a KeeperHub workflow over the API, enabled it, and
executed it** — the remediation is a workflow run in the operator's own
dashboard, with per-node logs, not a side channel only Blackbox can see.

The Base one is worth opening. The `from` address on that receipt is **not**
Blackbox and not the agent — it is KeeperHub's relayer, and the organisation's
managed wallet holds **zero ETH on Base** both before and after. The halt still
executed. That is gas sponsorship demonstrated rather than claimed, and it is
the same structural fact that forces a nonce-filling fix down a different path.

Deployed contracts: [`CircuitBreaker`](https://sepolia.etherscan.io/address/0x69C744Bb9f953D822a52E88604D26C9a895ac0E0) (Sepolia) · [`ChaosTarget`](https://sepolia.etherscan.io/address/0x5d3437a8b5C182B91dC72087f4049ac00b1C528A) (Sepolia) · [`CircuitBreaker`](https://basescan.org/address/0x8ecbE030145794596A98167Fc4b56817CeA1E36c) (**Base mainnet**)

---

## What a chain scanner cannot see

Most monitoring watches transactions or the mempool. That is a reasonable place
to watch, and it has a blind spot: **a workflow refused before broadcast emits
nothing to watch.**

No transaction. No gas. No trace on any chain. Every failed run behind the Base
mainnet remediation above came back from KeeperHub like this:

```
status: error   transactionHashes: 0   gasUsedWei: null
```

Nine of them. A monitor reading the chain sees an agent that has simply gone
quiet — and quiet is indistinguishable from idle.

Three of the ten rules exist only in that gap, and they are the three that read
KeeperHub's audit trail rather than a chain:

| Rule | What it catches | Onchain footprint |
| --- | --- | --- |
| R8 `SPEND_CAP_EXHAUSTED` | The organisation's daily budget is gone, so nothing else will execute | none |
| R9 `EXECUTION_STALLED` | A workflow started and never finished | none |
| R10 `WORKFLOW_MISCONFIGURED` | Refused repeatedly at the same step — broken, not unlucky | none |

That is the whole claim, and it is narrow on purpose: **Blackbox detects agent
failures that produce no transaction at all, and then fixes them with one.** The
Base mainnet arc is that sentence end to end — nine invisible failures, detected
at 0.9 confidence, halted with a transaction anyone can look up.

### Proofs that are inconvenient to fake

- **The remediation's sender is not us.** On the Base transaction, `from` is
  KeeperHub's relayer, and the organisation's wallet holds **zero ETH** before
  and after. Gas sponsorship, demonstrated.
- **The x402 payer holds no ETH either.** Settlement is USDC via EIP-3009, so a
  facilitator submits the transfer and the paying agent needs no native balance.
- **It refuses to act, in public.** The demo incident's remediation plan is
  `signable` and *not* `actionable`: confidence came out at 0.75 against the 0.8
  floor to spend gas. Six guards passed, two failed, and the refusal is recorded
  as carefully as a success would be.
- **You can check our record, not just believe it.**
  [`/api/ledger/verify`](https://blackbox-kh.parakramlabs.com/api/ledger/verify)
  walks the hash chain over every remediation. An entry edited or a failed
  attempt quietly deleted breaks every hash after it.

---

## What we sent back upstream

Six fixes to KeeperHub, each found by building on it and each verified against
their own test suite. **Three are merged, one is approved**, two are in review.

| PR | Fix | |
| --- | --- | --- |
| [#1990](https://github.com/KeeperHub/keeperhub/pull/1990) | A completed `contract-call` returned no `transactionHash`, though the route had it in hand and the docs promise it. It cost us a remediation recorded as failed after it had actually succeeded. | **merged** |
| [#1991](https://github.com/KeeperHub/keeperhub/pull/1991) | `undici` is imported by `lib/safe-fetch.ts` but declared in no dependency block, so their test suite will not start on a fresh clone with current pnpm. We hit this again ourselves a day later, on a branch cut before the merge. | **merged** |
| [#1992](https://github.com/KeeperHub/keeperhub/pull/1992) | Four fields the status endpoint returns — including `retryCount` — were undocumented. | **merged** |
| [#1993](https://github.com/KeeperHub/keeperhub/pull/1993) | Sub-cent marketplace prices were rounded to whole cents at the payment gate while the 402 advertised full precision, so **every payment below $0.01 failed** — most of their documented pricing range. Found by paying for our own listing. | in review |
| [#1995](https://github.com/KeeperHub/keeperhub/pull/1995) | `validate_workflow` reported a workflow whose chain comes from the caller as having an unknown chain id, so a **marketplace workflow that follows their own documented pattern validates as invalid** while executing correctly. The address checks a few lines away already skip template references. | **approved** |
| [#2081](https://github.com/KeeperHub/keeperhub/pull/2081) | `/analytics/runs` returned `network: null` for a run that failed before broadcast, even when its own error named the chain — the aggregate reads the network only from a step that produced gas. A consumer of the audit trail cannot tell which chain a failed run was on. | in review |

Each of the three that merged took two review rounds. The maintainer's second
pass on #1990 caught the transfer paragraph promising a hash on the one response
that cannot carry it, and on #1992 retracted one of their own earlier citations
as wrong — both fixed before merge.

`docs/friction-log.md` is the fuller teardown, including the entries we withdrew
after finding they were documented all along and we simply had not looked.

---

## How KeeperHub is used

KeeperHub is the execution engine, not a client library we call once.

- **Workflows.** Blackbox provisions a KeeperHub workflow per remediation shape,
  reuses it across incidents, and executes it on detection. Created, enabled and
  run entirely over the API.
- **Direct Execution** as the fallback path, following the documented safe
  sequence: simulate, check `wouldRevert`, execute with a derived
  `Idempotency-Key`, poll on `X-Poll-Interval-Hint`, and trust the verified
  receipt over the self-reported hash.
- **Audit trail.** Execution records are normalised into the same event stream
  as chain observations, so KeeperHub's own history is evidence the rules
  reason over.
- **Gas sponsorship.** Remediations execute through the sponsored relayer.
- **MCP, both directions, and load-bearing.** Blackbox exposes its own MCP
  server so other agents can ask why a transaction failed, and consumes
  KeeperHub's: every workflow is checked with `validate_workflow` immediately
  before a remediation runs, and **the verdict is recorded on the attempt and
  shown in the console** rather than logged and discarded. "We asked their
  validator" is a claim; the verdict is the evidence for it.

  Advisory, never blocking — an incident does not wait on a validator being up,
  and a validator that is unreachable is recorded as unreachable rather than
  counted as a pass. Their validator also rejects templated chain fields that
  execute fine; that specific complaint is marked as a known false positive,
  citing [#1995](https://github.com/KeeperHub/keeperhub/pull/1995) — which we
  found by using it, and fixed upstream. Marked rather than hidden, because
  silently discounting a validator is how a real complaint gets missed.
- **x402.** Blackbox publishes one of its own rules to the KeeperHub Marketplace
  as a paid workflow, so another agent can pay per call for it. Settlement is
  USDC on Base via EIP-3009, and the payer needs no ETH — a facilitator submits
  the transfer. See below.

One structural finding shaped the architecture, established by probing rather
than assuming: KeeperHub executes through a sponsored relayer at the *sponsor's*
nonce, so it can never occupy a specific nonce belonging to an agent's signer.
Playbooks that must fill a nonce gap therefore route to a held key or to the
owner's wallet. Everything that does not name a nonce goes through KeeperHub,
because that keeps the remediation inside the operator's own audit trail and
spend controls — including the halt described under **What it detects**.

---

## It works on agents that have integrated nothing

Two paths need no cooperation from the agent being watched.

```bash
# Explain any transaction hash. Nothing registered, nothing installed.
curl -XPOST localhost:4000/api/diagnose \
  -H 'content-type: application/json' \
  -d '{"txHash":"0x..."}'

# Watch any address. Its transactions are discovered by scanning blocks.
curl -XPOST localhost:4000/api/watched \
  -H 'content-type: application/json' \
  -d '{"signer":"0x...","label":"their agent"}'
```

A reverted transaction is replayed against the block *before* it was mined. If
it would have succeeded there, the state drifted underneath it — that is
`SIM_PASS_EXEC_REVERT`, measured by Blackbox rather than asserted by whoever
sent it. If it would have reverted anyway, no rule fires, because a doomed call
is a different and less interesting failure.

---

## What it detects

Ten rules, all deterministic. No model decides whether something is wrong. Each
compares a measured value against a threshold, so a detection can be argued
with rather than merely trusted.

| Rule | Class | Proven live |
| --- | --- | --- |
| R1 | `STUCK_TRANSACTION` | yes |
| R2 | `NONCE_GAP` | yes |
| R3 | `GAS_UNDERPRICED` | suppression path only |
| R4 | `SIM_PASS_EXEC_REVERT` | yes |
| R5 | `RETRY_STORM` | yes |
| R6 | `SIGNER_GAS_STARVED` | yes |
| R7 | `ADVERSE_INCLUSION` | no — see below |
| R8 | `SPEND_CAP_EXHAUSTED` | yes |
| R9 | `EXECUTION_STALLED` | no — needs a run that starts and never finishes |
| R10 | `WORKFLOW_MISCONFIGURED` | yes — this is what the public demo raises |

R1–R7 read a signer's own transactions. R8–R10 read a KeeperHub organisation's
execution history, and catch failures no chain scan can see: a workflow that
stalls before it produces a transaction, one refused at the same step every
time, and an organisation that has spent its daily budget.

**R7 is the honest gap.** It needs an inclusion analysis — expected against
actual output, block position, neighbouring transactions — and nothing builds
that yet, so it fires in tests and cannot fire live no matter what the chaos
harness does. The field is declared and unpopulated.

Seven playbooks. P2 (fill a nonce gap) and P4 (halt via circuit breaker) have
run against a live chain; P1, P3 and P5 have not. Three of the seven exist to
say *why no transaction can help* — a stalled workflow has to be cancelled in
KeeperHub, an exhausted spend cap is a billing action, and a reroute needs the
agent's own signer. Naming the reason is more use to an operator than silence,
and that refusal is recorded as carefully as a success.

Every remediation attempt records **which path executed it**:
`keeperhub-workflow`, `keeperhub`, `signer` or `user-signed`. A fix a human
signed resolves as `blackbox-proposed`, never as `blackbox`.

### Halting a KeeperHub agent

Detection needs nothing from you but a read-only connection. **Remediation on a
KeeperHub agent needs one more step**, and it is worth understanding why.

KeeperHub executes through a sponsored relayer at the *sponsor's* nonce, so
Blackbox can never act *as* your agent — it cannot replace your transaction or
fill your nonce gap, because neither is its to occupy. What it can do is call a
contract you have authorised it to call. So halting a runaway agent means
pausing a **circuit breaker you deploy and grant Blackbox the pauser role on**.

Register it per agent, on the Watched page or over the API:

```bash
curl -XPOST $BLACKBOX/api/agents/<agentId>/breaker \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"address":"0x…","chainId":11155111}'
```

The pauser role is checked **at registration**, not during the incident it was
meant to stop — a breaker Blackbox cannot pause registers in amber with the
reason rather than looking done. Once registered, R4, R5 and R10 on that agent
can be halted, and the halt runs as a KeeperHub workflow in your own account.
`CircuitBreaker` allows pausing and nothing else: it cannot unpause, change
roles, or move funds.

---

## The console

Served by the API itself at the deployment root, so the console and the API
share an origin — which is what makes the KeeperHub OAuth return work without a
proxy. `/` is the product page; `/dashboard` is the instrument.

Three things there are worth a judge's time:

- **Break something now.** Runs a workflow that asks to spend beyond the
  organisation's daily cap. KeeperHub refuses it before any chain is involved,
  so it costs no gas, and Blackbox reads the refusal out of the audit trail —
  the same way it would read yours. The incident appears **without a reload**,
  about ten seconds later. One press per 30 minutes, shared by everyone
  watching.
- **The run log.** For the runs behind an incident, the per-node record from
  KeeperHub: which step failed, what it said, gas used, and the transaction
  where there is one. Read through the operator's own connection, so it needs
  the account that owns the agent.
- **`GET /api/ledger/verify`.** Every remediation entry carries the SHA-256 of
  the one before it, so the record is tamper-evident: an entry edited, or a
  failed attempt quietly deleted, breaks every hash after it. Public and
  read-only, because a check only its author can run is not evidence.

---

## Architecture

```
chaos ──▶ chain ──▶ recorder ──▶ rules ──▶ incident ──▶ diagnostician
                        ▲                      │
                   block scanner               ▼
                  (any address)          remediator ──▶ KeeperHub workflow
                                                   └──▶ Direct Execution
                                                   └──▶ held key / user wallet
```

| Package | Responsibility |
| --- | --- |
| `core` | Schemas, chain registry, KeeperHub client |
| `store` | Postgres via Drizzle; events, incidents, ledger, cursors |
| `recorder` | Ingest and normalise; block scanner for watched addresses |
| `detector` | Rules R1–R10 and incident lifecycle. No LLM |
| `diagnostician` | Root cause analysis via Gemini, with a deterministic template floor |
| `remediator` | Guards, playbooks P1–P7, and the four execution paths |
| `chaos` | Induces each failure class on testnet; doubles as the E2E suite |
| `api` | Fastify REST + SSE, the detection loop, and the console it serves |
| `mcp` | MCP server exposing Blackbox to other agents |

900 TypeScript tests and 19 Foundry tests.

---

## Quickstart

Needs Node 24, pnpm 11, Docker, and Foundry for the contracts.

```bash
pnpm install
pnpm db:up                                     # Postgres on 5433
cd packages/store && pnpm exec drizzle-kit migrate && cd ../..
pnpm build
node packages/api/dist/server.js               # http://localhost:4000
```

For the console alongside it:

```bash
VITE_API_URL=http://localhost:4000 pnpm --filter @blackbox/console dev
```

Leave `VITE_API_URL` empty to build the console for a deployment that serves it
from the API, where every call is relative. Set `BLACKBOX_CONSOLE_DIR` on the
API to the built `dist` and it serves the console itself, with `/api/*`
untouched and a SPA fallback for client routes.

There is also a mock of the whole API, if you want to work on the console
without a chain or a database:

```bash
node tools/mock-api.mjs                        # http://localhost:4001
```

`.env.local` needs, at minimum:

```bash
KEEPERHUB_ORG_KEY=kh_...        # organisation key; a wfb_ webhook key cannot execute
ALCHEMY_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/...
DATABASE_URL=postgres://blackbox:blackbox@localhost:5433/blackbox

# optional
CHAOS_SIGNER_PRIVATE_KEY=0x...  # enables chaos scenarios and held-key remediation
CIRCUIT_BREAKER_ADDRESS=0x...   # enables P4
CHAOS_TARGET_ADDRESS=0x...      # enables C3 and C4
GOOGLE_CLOUD_PROJECT=...        # enables root cause analysis, via gcloud ADC
BLACKBOX_DRY_RUN=false          # live remediation is opt-in, always
```

The server reports what it can actually do at `GET /api/config` under
`capabilities`, and routes it cannot serve do not exist rather than failing at
call time.

### Seeing it work

```bash
curl -XPOST localhost:4000/api/chaos/run -d '{"scenario":"C4"}' -H 'content-type: application/json'
curl localhost:4000/api/incidents
curl -XPOST localhost:4000/api/incidents/<id>/remediate -d '{}' -H 'content-type: application/json'
```

Or run the arcs directly — each spends real testnet gas:

```bash
cd packages/chaos
node e2e/c4-retry-storm.mjs          # induce, detect, explain
node e2e/p4-keeperhub-breaker.mjs    # detect, then halt via a KeeperHub workflow
node e2e/c5-gas-starved.mjs          # starve a throwaway wallet until R6 fires
node e2e/zero-integration.mjs        # watch an address that registered nothing
node e2e/x402-pay.mjs                # pay for a listed workflow over x402
node e2e/p4-base-mainnet.mjs         # detect on Base mainnet, halt via KeeperHub
```

See `packages/chaos/e2e/README.md` — one of them deliberately leaves the
circuit breaker paused and prints the command to undo it.

---

## Selling a rule over x402

`signer-gas-runway` is R6 published to the KeeperHub Marketplace: give it an
address and it answers whether that signer can still pay for its next
transaction. KeeperHub registers it on x402scan under its own server entry, and
an agent that has never heard of Blackbox can discover it, pay, and get an
answer.

```bash
# discover it in KeeperHub's public OpenAPI
curl -s https://app.keeperhub.com/openapi.json | jq '.paths | keys[] | select(contains("signer-gas-runway"))'

# call it without paying
curl -XPOST https://app.keeperhub.com/api/mcp/workflows/signer-gas-runway/call \
  -H 'content-type: application/json' -d '{"address":"0x...","network":"sepolia"}'
# -> 402, with the amount, asset and payTo to sign against

# pay and get the answer
cd packages/chaos && node e2e/x402-pay.mjs
```

The client is `packages/chaos/e2e/x402-pay.mjs`: it takes the 402, signs an
EIP-3009 `TransferWithAuthorization` with the reference `@x402/core` client,
retries with the `PAYMENT-SIGNATURE` header, and confirms the USDC moved. The
paying wallet holds **no ETH at all**.

## MCP server

```bash
BLACKBOX_API_URL=http://localhost:4000 node packages/mcp/dist/stdio.js
```

| Tool | Does |
| --- | --- |
| `diagnose_execution` | Explain any transaction hash |
| `get_signer_health` | Balance, nonces, missing nonces, open incidents |
| `list_incidents` | Filterable incident list |
| `get_remediation_plan` | The exact transaction that would fix an incident |
| `request_remediation` | Ask Blackbox to fix it. Requires `authorized: true` |
| `watch_address` | Register an address for monitoring |

`request_remediation` is the only tool that spends money, and a guard refusal
comes back as an answer naming what blocked it rather than as an error.

---

## Chaos harness

**Five of the six failure modes are induced on a live chain, detected, and
correctly classified — the sixth needs control over block ordering that no
wallet has.** These are real transactions on Sepolia, not fixtures: the harness
breaks something, and the same detection path that watches a customer's agent
picks it up.

Hard-restricted to testnets in code, with no runtime override.

| | Induces | Determinism |
| --- | --- | --- |
| C1 | `GAS_UNDERPRICED` → `STUCK_TRANSACTION` | depends on the market |
| C2 | `NONCE_GAP` | deterministic |
| C3 | `SIM_PASS_EXEC_REVERT` | deterministic |
| C4 | `RETRY_STORM` | deterministic |
| C5 | `SIGNER_GAS_STARVED` | deterministic — starves a throwaway wallet, not the chaos signer |
| C6 | `ADVERSE_INCLUSION` | needs a local fork |

C3 is the one worth reading: `armTrap()` records a block number, and `work()`
reverts only once a block has passed. The call therefore simulates clean and
reverts on inclusion — real state drift, not a contrived revert.

---

## Docs

- `docs/console-spec.md` — page-by-page console spec and API reference
- `docs/friction-log.md` — KeeperHub onboarding teardown, with every claim
  verified and the ones that turned out wrong withdrawn
- `docs/design-system.md` — the console's visual rules and why each one exists
- `docs/deploy.md` — how the deployment is built and rolled out
- `tools/mock-api.mjs` — zero-dependency mock of the whole API, for building the
  console without a chain
- `tools/demo/drive.mjs` — drives the demo in a real browser, one beat per
  keypress, so a walkthrough can be recorded without a rehearsed mouse
- `tools/demo/script.md` — what to say over each beat

## License

Apache 2.0.
