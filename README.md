# Blackbox

**Autonomous incident intelligence and remediation for onchain agent execution, built on KeeperHub.**

Agents are good at reasoning and bad at execution. Nonce gaps wedge signers,
gas estimates go stale, transactions simulate clean and revert on inclusion,
signers run dry. When it happens to an unattended agent, nobody is watching and
the agent cannot diagnose itself.

KeeperHub already records the evidence — trigger, simulation, submitted
transaction, gas, outcome, timestamp. Blackbox consumes that record, classifies
what went wrong with a deterministic rule engine, explains it in plain language,
and then executes the fix onchain through the same execution layer.

Every remediation is a real transaction with a retrievable hash. There are no
simulated remediations anywhere in the product.

## Status

Pre-implementation. Spec is complete; scaffolding starts next.

## Components

| Component | Responsibility |
| --- | --- |
| Recorder | Ingest KeeperHub audit records, normalise, persist |
| Detector | Deterministic rules R1–R7 → `Incident` records. No LLM |
| Diagnostician | LLM root-cause narrative. Explains only, never decides |
| Remediator | Incident class → playbook → onchain execution via KeeperHub |
| Chaos harness | Induces each failure class on testnet; doubles as the E2E suite |
| Console | Live incident timeline, evidence + RCA + remediation tx link |

## Chains

- Base Sepolia (84532) — chaos harness, all testing
- Base mainnet (8453) — gas sponsorship demo only

Chaos is hard-restricted to 84532 in code. No runtime override.

## Setup

To be written at scaffold time. Will cover: pnpm install, Docker Compose
Postgres, `.env.local` (KeeperHub org key, RPC URLs, OpenRouter key), Drizzle
migrations, running the engine and the console.

## Onboarding an agent

To be written. Will cover breaker registration, signer allowlisting, and the
submission wrapper if the audit trail turns out to be final-outcome-only.

## Docs

- `docs/friction-log.md` — KeeperHub onboarding teardown, kept from commit one.

## License

Apache 2.0.
