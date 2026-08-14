# Blackbox

**Autonomous incident intelligence and remediation for onchain agent execution, built on KeeperHub.**

- **Live:** [https://blackbox-kh.parakramlabs.com](https://blackbox-kh.parakramlabs.com/)
- **Demo:** [https://youtu.be/7dIDS5rjCb0](https://youtu.be/7dIDS5rjCb0)
- **Code:** [https://github.com/IronicDeGawd/blackbox-keeperhub](https://github.com/IronicDeGawd/blackbox-keeperhub)

## The problem

**Most tooling tells you an agent failed. Blackbox tells you why, with the
numbers it measured.** Not "execution reverted" — *nonce 122 was never filled,
one action is blocked behind it, and that held across five consecutive polls
where two were required*. A dozen tools react to failure; diagnosing it is the
rarer thing, and it is what the rest of the product is built on.

Agents are good at reasoning and bad at execution.

A nonce gap wedges a signer and everything queued behind it stops. A gas estimate goes stale and the transaction sits. A call simulates clean and reverts on inclusion because the state moved underneath it. A retry loop quietly burns a wallet down.

None of it raises an error the agent knows how to report. The agent believes it acted; the chain disagrees.

You find out from a user, or from the balance.

## What it does

Watches execution, decides what went wrong, explains it with the numbers it measured, then executes the fix onchain through KeeperHub as a real transaction.

**Ten deterministic rules.** No model decides whether something is wrong. Each compares a measured value against a threshold, so a detection can be argued with rather than merely trusted.

| Rule | Class | Proven live |
|------|-------|--------------|
| R1 | `STUCK_TRANSACTION` | Yes |
| R2 | `NONCE_GAP` | Yes |
| R3 | `GAS_UNDERPRICED` | Suppression path only |
| R4 | `SIM_PASS_EXEC_REVERT` | Yes |
| R5 | `RETRY_STORM` | Yes |
| R6 | `SIGNER_GAS_STARVED` | Yes |
| R7 | `ADVERSE_INCLUSION` | No — needs inclusion analysis |
| R8 | `SPEND_CAP_EXHAUSTED` | Yes |
| R9 | `EXECUTION_STALLED` | No |
| R10 | `WORKFLOW_MISCONFIGURED` | Yes — public demo |

R1–R7 read a signer's own transactions. R8–R10 read a KeeperHub organisation's execution history and catch failures no chain scan can see: a workflow that stalls before producing a transaction, one refused at the same step every time, and an organisation that has spent its daily budget.

**Seven playbooks**, each recording which path executed it — `keeperhub-workflow`, `keeperhub`, `signer` or `user-signed`.

A fix a human signed resolves as `blackbox-proposed`, never as `blackbox`.

Three of the seven exist to say *why no transaction can help*, which is a verdict rather than a gap: a stalled workflow has to be cancelled or re-run in KeeperHub, an exhausted spend cap is a billing action, and a rerouting fix needs the agent's own signer. Naming the reason is more use to an operator than silence.

## The workflows Blackbox runs on KeeperHub

Blackbox does not only read KeeperHub's API. It **authors workflows there, enables them over the API, and fires them** — so a remediation is a workflow run in the operator's own KeeperHub account, under their spend controls, with per-node logs.

| Workflow | What it is |
|---|---|
| `blackbox/remediation/11155111/pause/0x69c744bb…` | Written by Blackbox at remediation time. The name is machine-generated and encodes chain, action and target contract. Webhook trigger → `web3/write-contract`. This is the workflow behind the transaction below. |
| `Blackbox Incident Responder` | Webhook trigger → `web3/write-contract`. The general execution path the detector fires. |
| `Blackbox: signer gas runway` | R6 published to the KeeperHub Marketplace as a paid workflow, callable by any agent over x402. |
| `blackbox/demo/refused-transfer` | Asks to spend beyond the daily cap. KeeperHub refuses it before any chain is touched, so it costs no gas — this is what the public demo button runs. |
| `blackbox/demo/insufficient-funds` | A second inducible failure shape. |
| `blackbox/audit-probe` | Used by the audit scripts to exercise the live integration. |

The division of labour is the one the hackathon prescribes: **the deciding is ours, every write is KeeperHub's.** Detection runs in our own backend against KeeperHub's audit trail; the moment a fix is chosen, execution moves to KeeperHub. Workflows are reused across incidents rather than recreated — the same pause workflow serves every future halt on that chain and target.

## Proof

Real transactions produced by the system end to end — five on Ethereum Sepolia,
one on **Base mainnet**.

| What happened | Transaction |
|---|---|
| **A KeeperHub workflow Blackbox wrote and ran** paused a failing agent's circuit breaker | [0x783823d5…](https://sepolia.etherscan.io/tx/0x783823d5ee3afa43222b7ff432faeb45e1e3285d54673ab5b6af5b907248c9a9) |
| Blackbox filled a nonce gap it detected, unwedging the signer | [0xb1982439…](https://sepolia.etherscan.io/tx/0xb198243930fc745817914dd6ff4fee5e57d4a357b7c632b55743dafd292a57ed) |
| A user's wallet signed a fix Blackbox planned, which Blackbox then verified | [0x59563255…](https://sepolia.etherscan.io/tx/0x5956325573c201d473812a08d0b0aeb96d2c3bace24954835bfda62e0e08d22e) |
| Chaos: a call that simulated clean and reverted one block later | [0xa0dbdb74…](https://sepolia.etherscan.io/tx/0xa0dbdb74dc0f19bdcfb6a8cc983b36a9fdbc548af0c716d363500befb45901c6) |
| An agent paid Blackbox over x402 for a diagnosis — USDC settled on **Base mainnet** | [0x8cd8d6ac…](https://basescan.org/tx/0x8cd8d6ac5dae125e5f3cf039db1ffb7f6b7dafa44243396d00e30074a93a51f9) |
| A watched wallet ran itself down to no runway, and was told so | [0x5aa0a47c…](https://sepolia.etherscan.io/tx/0x5aa0a47c64c7030e3e72dbc5a114cd3ff3c2161c6042ac9aefbe573aa1852070) |

The first one is the interesting one.

Blackbox detected a retry storm, decided to halt the agent, **created a KeeperHub workflow over the API, enabled it, and executed it** — so the remediation is a workflow run in the operator's own dashboard with per-node logs, not a side channel only Blackbox can see. That workflow is `blackbox/remediation/11155111/pause/0x69c744bb…`, still enabled in the org today.

**Contracts on Sepolia:**

- [CircuitBreaker](https://sepolia.etherscan.io/address/0x69C744Bb9f953D822a52E88604D26C9a895ac0E0)
- [ChaosTarget](https://sepolia.etherscan.io/address/0x5d3437a8b5C182B91dC72087f4049ac00b1C528A)

## How KeeperHub is used

KeeperHub is the execution engine, not a client library called once.

- **Workflows** — provisioned per remediation shape, reused across incidents, created, enabled and executed entirely over the API. See the table above for the ones live in the org today.
- **Direct Execution** — the fallback, following the documented safe sequence: simulate, check `wouldRevert`, execute with a derived `Idempotency-Key`, poll on `X-Poll-Interval-Hint`, and trust the verified receipt over the self-reported hash.
- **Audit trail** — execution records are normalised into the same event stream as chain observations, so KeeperHub's own history is evidence the rules reason over. Three of the ten rules exist only because of it.
- **Gas sponsorship** — remediations execute through the sponsored relayer.
- **MCP, both directions** — Blackbox exposes its own MCP server so other agents can ask why a transaction failed, and consumes KeeperHub's, checking every workflow with `validate_workflow` before a remediation runs.
- **x402** — one rule is published to the KeeperHub Marketplace as a paid workflow. Settlement is USDC on Base via EIP-3009, and the paying wallet holds no ETH.

Execution routing prefers KeeperHub for every plan it can serve. A held key is the fallback for exactly one case, and that case is forced by what KeeperHub is: it executes through a sponsored relayer at the *sponsor's* nonce, so it can never occupy a specific nonce belonging to an agent's signer. Filling a nonce gap therefore routes to a held key or to the owner's own wallet. Everything that does not name a nonce goes through KeeperHub, because that keeps the remediation inside the customer's existing audit trail and spend controls.

## What we sent back upstream

Five fixes to KeeperHub, each found by building on it and each verified against their own test suite. **Three merged, two in review.**

| PR | Fix |
|---|---|
| [#1990](https://github.com/KeeperHub/keeperhub/pull/1990) **merged** | A completed `contract-call` returned no `transactionHash`, though the route had it in hand and the docs promise it. It cost us a remediation recorded as failed after it had actually succeeded. |
| [#1991](https://github.com/KeeperHub/keeperhub/pull/1991) **merged** | `undici` is imported by `lib/safe-fetch.ts` but declared in no dependency block, so their test suite will not start on a fresh clone. |
| [#1992](https://github.com/KeeperHub/keeperhub/pull/1992) **merged** | Four fields the status endpoint returns — including `retryCount` — were undocumented. |
| [#1993](https://github.com/KeeperHub/keeperhub/pull/1993) | Sub-cent marketplace prices were rounded to whole cents at the payment gate while the 402 advertised full precision, so **every payment below $0.01 failed** — most of their documented pricing range. Found by paying for our own listing. |
| [#1995](https://github.com/KeeperHub/keeperhub/pull/1995) | `validate_workflow` reported a workflow whose chain comes from the caller as having an unknown chain id, so a marketplace workflow following their own documented pattern validated as invalid while executing correctly. |

Each merge took two review rounds. On #1990 the maintainer caught a docs paragraph promising a hash on the one response that cannot carry it; on #1992 they retracted one of their own earlier citations as wrong. Both were fixed before merge.

## Build

pnpm monorepo, eleven packages, TypeScript 5 strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

| Package | Responsibility |
|---|---|
| `core` | Schemas, chain registry, KeeperHub client |
| `store` | Postgres via Drizzle; events, incidents, hash-chained ledger, cursors |
| `recorder` | Ingest and normalise; block scanner for watched addresses |
| `detector` | Rules R1–R10 and incident lifecycle. No LLM |
| `diagnostician` | Root cause analysis via Gemini, with a deterministic template floor |
| `remediator` | Guards, playbooks P1–P7, and the four execution paths |
| `chaos` | Induces each failure class on testnet; doubles as the E2E suite |
| `api` | Fastify REST + SSE, the detection loop, and the console it serves |
| `mcp` | MCP server exposing Blackbox to other agents |
| `alerter` | Email and webhook delivery |
| `console` | React 19 + Vite + TanStack Router |

**No agent framework.**

Detection is a deterministic rule engine; the only LLM call is the written explanation, and it sits after the evidence, never in the detection path.

**Stack:** Fastify 5, Drizzle, Postgres 16, viem, zod, `@modelcontextprotocol/sdk`, `@x402/core`, React 19, Vite 6, Node 24.

**900 TypeScript tests and 19 Foundry tests.**

Deployed on GCP: one VM running Postgres, the API and Caddy, with the console served by the API itself so both share an origin — which is what makes the KeeperHub OAuth return work without a proxy.

## Worth checking

- **Break something now** on the dashboard. Runs a workflow that asks to spend beyond the organisation's daily cap. KeeperHub refuses it before any chain is involved, so it costs no gas, and Blackbox reads the refusal out of the audit trail. The incident appears **without a reload**, about ten seconds later. One press per 30 minutes, shared by everyone watching.
- **`GET /api/ledger/verify`** — every remediation entry carries the SHA-256 of the one before it, so an entry edited or a failed attempt quietly deleted breaks every hash after it. Public and read-only, because a check only its author can run is not evidence.
- **It works on agents that integrated nothing** — give it a transaction hash and it explains what happened, or give it an address and it discovers the transactions by scanning blocks.
