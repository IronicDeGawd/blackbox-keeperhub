# Blackbox

**Autonomous incident intelligence and remediation for onchain agent execution, built on KeeperHub.**

Agents are good at reasoning and bad at execution. Nonce gaps wedge signers, gas
estimates go stale, transactions simulate clean and revert on inclusion, and a
retry loop quietly burns a wallet down. Blackbox watches execution, works out
what went wrong with a deterministic rule engine, explains it in plain language,
and then executes the fix onchain through KeeperHub.

Every remediation is a real transaction with a retrievable hash. There are no
simulated remediations anywhere in the product.

---

## Proof

Real transactions on Ethereum Sepolia, produced by the system end to end.

| What happened | Transaction |
| --- | --- |
| **A KeeperHub workflow Blackbox wrote and ran** paused a failing agent's circuit breaker | [`0x783823d5…`](https://sepolia.etherscan.io/tx/0x783823d5ee3afa43222b7ff432faeb45e1e3285d54673ab5b6af5b907248c9a9) |
| Blackbox filled a nonce gap it detected, unwedging the signer | [`0xb1982439…`](https://sepolia.etherscan.io/tx/0xb198243930fc745817914dd6ff4fee5e57d4a357b7c632b55743dafd292a57ed) |
| A user's wallet signed a fix Blackbox planned, which Blackbox then verified | [`0x59563255…`](https://sepolia.etherscan.io/tx/0x5956325573c201d473812a08d0b0aeb96d2c3bace24954835bfda62e0e08d22e) |
| Chaos: a call that simulated clean and reverted one block later | [`0xa0dbdb74…`](https://sepolia.etherscan.io/tx/0xa0dbdb74dc0f19bdcfb6a8cc983b36a9fdbc548af0c716d363500befb45901c6) |
| An agent paid Blackbox over x402 for a diagnosis — USDC settled on Base | [`0x8cd8d6ac…`](https://basescan.org/tx/0x8cd8d6ac5dae125e5f3cf039db1ffb7f6b7dafa44243396d00e30074a93a51f9) |

The first one is the interesting one. Blackbox detected a retry storm, decided
to halt the agent, **created a KeeperHub workflow over the API, enabled it, and
executed it** — the remediation is a workflow run in the operator's own
dashboard, with per-node logs, not a side channel only Blackbox can see.

Deployed contracts (Sepolia): [`CircuitBreaker`](https://sepolia.etherscan.io/address/0x69C744Bb9f953D822a52E88604D26C9a895ac0E0) · [`ChaosTarget`](https://sepolia.etherscan.io/address/0x5d3437a8b5C182B91dC72087f4049ac00b1C528A)

---

## What we sent back upstream

Four fixes to KeeperHub, each found by building on it and each verified against
their own test suite.

| PR | Fix |
| --- | --- |
| [#1993](https://github.com/KeeperHub/keeperhub/pull/1993) | Sub-cent marketplace prices were rounded to whole cents at the payment gate while the 402 advertised full precision, so **every payment below $0.01 failed** — most of their documented pricing range. Found by paying for our own listing. |
| [#1990](https://github.com/KeeperHub/keeperhub/pull/1990) | A completed `contract-call` returned no `transactionHash`, though the route had it in hand and the docs promise it. It cost us a remediation recorded as failed after it had actually succeeded. |
| [#1991](https://github.com/KeeperHub/keeperhub/pull/1991) | `undici` is imported by `lib/safe-fetch.ts` but declared in no dependency block, so their test suite will not start on a fresh clone with current pnpm. |
| [#1992](https://github.com/KeeperHub/keeperhub/pull/1992) | Four fields the status endpoint returns — including `retryCount` — were undocumented. |

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
- **MCP.** Blackbox exposes its own MCP server so other agents can ask why a
  transaction failed.
- **x402.** Blackbox publishes one of its own rules to the KeeperHub Marketplace
  as a paid workflow, so another agent can pay per call for it. Settlement is
  USDC on Base via EIP-3009, and the payer needs no ETH — a facilitator submits
  the transfer. See below.

One structural finding shaped the architecture, established by probing rather
than assuming: KeeperHub executes through a sponsored relayer at the *sponsor's*
nonce, so it can never occupy a specific nonce belonging to an agent's signer.
Playbooks that must fill a nonce gap therefore route to a held key or to the
owner's wallet. Written up in `context/plan/blackbox-prd.md` §6.2.

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

Seven rules, all deterministic. No model decides whether something is wrong.

| Rule | Class | Proven live |
| --- | --- | --- |
| R1 | `STUCK_TRANSACTION` | yes |
| R2 | `NONCE_GAP` | yes |
| R3 | `GAS_UNDERPRICED` | suppression path only |
| R4 | `SIM_PASS_EXEC_REVERT` | yes |
| R5 | `RETRY_STORM` | yes |
| R6 | `SIGNER_GAS_STARVED` | tests only |
| R7 | `ADVERSE_INCLUSION` | tests only |

Five playbooks. P2 (fill a nonce gap) and P4 (halt via circuit breaker) have run
against a live chain; P1, P3 and P5 have not. Where a playbook cannot act it
declines with a stated reason, and that refusal is recorded as carefully as a
success — P3 on a chain with no private mempool is the clearest example.

Every remediation attempt records **which path executed it**:
`keeperhub-workflow`, `keeperhub`, `signer` or `user-signed`. A fix a human
signed resolves as `blackbox-proposed`, never as `blackbox`.

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
| `detector` | Rules R1–R7 and incident lifecycle. No LLM |
| `diagnostician` | Root cause analysis via Gemini, with a deterministic template floor |
| `remediator` | Guards, playbooks P1–P5, and the four execution paths |
| `chaos` | Induces each failure class on testnet; doubles as the E2E suite |
| `api` | Fastify REST + SSE, and the long-running detection loop |
| `mcp` | MCP server exposing Blackbox to other agents |

397 TypeScript tests and 19 Foundry tests.

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
node e2e/zero-integration.mjs        # watch an address that registered nothing
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

Hard-restricted to testnets in code, with no runtime override.

| | Induces | Determinism |
| --- | --- | --- |
| C1 | `GAS_UNDERPRICED` → `STUCK_TRANSACTION` | depends on the market |
| C2 | `NONCE_GAP` | deterministic |
| C3 | `SIM_PASS_EXEC_REVERT` | deterministic |
| C4 | `RETRY_STORM` | deterministic |
| C5 | `SIGNER_GAS_STARVED` | written, unrun — it drains the signer |
| C6 | `ADVERSE_INCLUSION` | needs a local fork |

C3 is the one worth reading: `armTrap()` records a block number, and `work()`
reverts only once a block has passed. The call therefore simulates clean and
reverts on inclusion — real state drift, not a contrived revert.

---

## Docs

- `docs/console-spec.md` — page-by-page console spec and API reference
- `docs/friction-log.md` — KeeperHub onboarding teardown, with every claim
  verified and the ones that turned out wrong withdrawn
- `tools/mock-api.mjs` — zero-dependency mock of the whole API, for building the
  UI without a chain
- `context/plan/blackbox-prd.md` — the spec, with amendments recording what
  probing the live API changed

## License

Apache 2.0.
