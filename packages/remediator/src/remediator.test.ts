import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blackboxConfigSchema, CHAIN_IDS, type BlackboxConfig, type Incident } from '@blackbox/core';
import {
  createDb,
  recordRemediationAttempt,
  remediationLedger,
  type Database,
} from '@blackbox/store';
import { evaluateGuards, mutexKey } from './guards.js';
import { P1, P2, P3, P4, P5, playbookFor, servability } from './playbooks.js';
import { Remediator, type RemediationExecutor } from './remediator.js';

const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const SIGNER = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5' as `0x${string}`;
const T0 = new Date('2026-08-10T12:00:00.000Z');
const TX = `0x${'a'.repeat(64)}` as `0x${string}`;

let db: Database;
let close: () => Promise<void>;

beforeAll(() => {
  ({ db, close } = createDb(URL));
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await db.delete(remediationLedger);
});

/** Live config: everything opted in, so each test can break one thing. */
const liveConfig = (over: Record<string, unknown> = {}): BlackboxConfig =>
  blackboxConfigSchema.parse({
    keeperHub: { orgKey: 'kh_test' },
    databaseUrl: URL,
    remediation: {
      dryRun: false,
      signerAllowlist: [SIGNER],
      chainAllowlist: [CHAIN_IDS.sepolia],
      ...over,
    },
  });

const incident = (over: Partial<Incident> = {}): Incident =>
  ({
    id: 'inc-1',
    class: 'STUCK_TRANSACTION',
    severity: 'warning',
    status: 'open',
    agentId: 'chaos',
    signer: SIGNER,
    chainId: CHAIN_IDS.sepolia,
    detectedAt: T0,
    firstEventAt: T0,
    confidence: 0.95,
    evidence: {
      eventIds: ['e0'],
      ruleId: 'R1',
      facts: { nonce: 5, submittedMaxFee: '1000000000' },
    },
    ...over,
  }) as Incident;

const guardCtx = (over: Record<string, unknown> = {}) => ({
  db,
  config: liveConfig(),
  incident: incident(),
  now: T0,
  inFlight: new Set<string>(),
  ...over,
});

describe('universal guards block independently', () => {
  it('passes them all when everything is opted in', async () => {
    const r = await evaluateGuards(guardCtx());
    expect(r.failed).toEqual([]);
  });

  it('dry run blocks on its own', async () => {
    const r = await evaluateGuards(guardCtx({ config: liveConfig({ dryRun: true }) }));
    expect(r.failed.map((f) => f.guard)).toEqual(['dry_run']);
  });

  it('low confidence blocks on its own', async () => {
    const r = await evaluateGuards(guardCtx({ incident: incident({ confidence: 0.5 }) }));
    expect(r.failed.map((f) => f.guard)).toEqual(['min_confidence']);
    expect(r.failed[0]!.reason).toMatch(/below the 0.8 required/);
  });

  it('an unlisted signer blocks on its own', async () => {
    const r = await evaluateGuards(guardCtx({ config: liveConfig({ signerAllowlist: [] }) }));
    expect(r.failed.map((f) => f.guard)).toEqual(['signer_allowlist']);
  });

  it('an unlisted chain blocks on its own', async () => {
    const r = await evaluateGuards(guardCtx({ config: liveConfig({ chainAllowlist: [] }) }));
    expect(r.failed.map((f) => f.guard)).toEqual(['chain_allowlist']);
  });

  it('a Blackbox self-incident blocks on its own', async () => {
    // Blackbox watches itself; remediating its own failures would loop.
    const r = await evaluateGuards(guardCtx({ incident: incident({ agentId: 'blackbox' }) }));
    expect(r.failed.map((f) => f.guard)).toEqual(['not_self']);
  });

  it('an in-flight remediation on the same signer blocks on its own', async () => {
    const r = await evaluateGuards({
      ...guardCtx(),
      inFlight: new Set([mutexKey(SIGNER, CHAIN_IDS.sepolia)]),
    });
    expect(r.failed.map((f) => f.guard)).toEqual(['no_remediation_in_flight']);
    expect(r.failed[0]!.reason).toMatch(/collide on nonce/);
  });

  it('exhausted attempts block on their own', async () => {
    for (const id of ['a', 'b']) {
      await recordRemediationAttempt(db, {
        id,
        incidentId: 'inc-1',
        playbookId: 'P1',
        signer: SIGNER,
        chainId: CHAIN_IDS.sepolia,
        attemptedAt: T0,
        status: 'failed',
      });
    }
    const r = await evaluateGuards(guardCtx());
    expect(r.failed.map((f) => f.guard)).toEqual(['max_attempts']);
  });

  it('the hourly count cap blocks on its own', async () => {
    for (let i = 0; i < 10; i++) {
      await recordRemediationAttempt(db, {
        id: `c${i}`,
        incidentId: `other-${i}`,
        playbookId: 'P1',
        signer: SIGNER,
        chainId: CHAIN_IDS.sepolia,
        attemptedAt: T0,
        status: 'succeeded',
      });
    }
    const r = await evaluateGuards(guardCtx());
    expect(r.failed.map((f) => f.guard)).toEqual(['budget']);
    expect(r.failed[0]!.reason).toMatch(/reaches the cap of 10/);
  });

  it('the hourly gas cap blocks on its own', async () => {
    await recordRemediationAttempt(db, {
      id: 'g1',
      incidentId: 'other',
      playbookId: 'P1',
      signer: SIGNER,
      chainId: CHAIN_IDS.sepolia,
      attemptedAt: T0,
      gasSpentWei: 999_000_000_000_000_000n,
      status: 'succeeded',
    });
    const r = await evaluateGuards(guardCtx());
    expect(r.failed.map((f) => f.guard)).toEqual(['budget']);
    expect(r.failed[0]!.reason).toMatch(/wei spent/);
  });

  /**
   * Every workflow in a KeeperHub organisation executes from one managed
   * wallet, so the per-signer cap above is a single bucket shared by all of
   * them. This is the workflow's own allowance.
   */
  it("one workflow's daily cap blocks on its own", async () => {
    for (let i = 0; i < 3; i++) {
      await recordRemediationAttempt(db, {
        id: `d${i}`,
        incidentId: `other-${i}`,
        playbookId: 'P1',
        signer: SIGNER,
        chainId: CHAIN_IDS.sepolia,
        agentId: 'chaos',
        attemptedAt: new Date(T0.getTime() - i * 60 * 60_000),
        status: 'succeeded',
      });
    }
    const r = await evaluateGuards(guardCtx());
    expect(r.failed.map((f) => f.guard)).toEqual(['agent_daily_budget']);
    expect(r.failed[0]!.reason).toMatch(/reaches its cap of 3/);
  });

  it("another workflow's spending does not count against this one", async () => {
    for (let i = 0; i < 5; i++) {
      await recordRemediationAttempt(db, {
        id: `e${i}`,
        incidentId: `other-${i}`,
        playbookId: 'P1',
        signer: SIGNER,
        chainId: CHAIN_IDS.sepolia,
        agentId: 'kh:some-other-workflow',
        attemptedAt: new Date(T0.getTime() - i * 60 * 60_000),
        status: 'succeeded',
      });
    }
    // Five on the shared wallet, none on this workflow: the hourly per-signer
    // ceiling still applies, and it is nowhere near reached.
    expect((await evaluateGuards(guardCtx())).failed).toEqual([]);
  });

  it('yesterday does not count against today', async () => {
    for (let i = 0; i < 3; i++) {
      await recordRemediationAttempt(db, {
        id: `f${i}`,
        incidentId: `other-${i}`,
        playbookId: 'P1',
        signer: SIGNER,
        chainId: CHAIN_IDS.sepolia,
        agentId: 'chaos',
        attemptedAt: new Date(T0.getTime() - 25 * 60 * 60_000),
        status: 'succeeded',
      });
    }
    expect((await evaluateGuards(guardCtx())).failed).toEqual([]);
  });

  it('spend outside the rolling hour does not count', async () => {
    await recordRemediationAttempt(db, {
      id: 'old',
      incidentId: 'other',
      playbookId: 'P1',
      signer: SIGNER,
      chainId: CHAIN_IDS.sepolia,
      attemptedAt: new Date(T0.getTime() - 2 * 60 * 60_000),
      gasSpentWei: 999_000_000_000_000_000n,
      status: 'succeeded',
    });
    expect((await evaluateGuards(guardCtx())).failed).toEqual([]);
  });

  it('reports every failing guard, not just the first', async () => {
    const r = await evaluateGuards(
      guardCtx({
        config: liveConfig({ dryRun: true, signerAllowlist: [], chainAllowlist: [] }),
        incident: incident({ confidence: 0.1 }),
      }),
    );
    // An operator fixing one blocker at a time would go round the loop four
    // times to learn all of this.
    expect(r.failed.map((f) => f.guard).sort()).toEqual(
      ['chain_allowlist', 'dry_run', 'min_confidence', 'signer_allowlist'].sort(),
    );
  });
});

describe('playbook selection', () => {
  it('maps each class to its playbook', () => {
    expect(playbookFor('STUCK_TRANSACTION')?.id).toBe('P1');
    expect(playbookFor('GAS_UNDERPRICED')?.id).toBe('P1');
    expect(playbookFor('NONCE_GAP')?.id).toBe('P2');
    expect(playbookFor('ADVERSE_INCLUSION')?.id).toBe('P3');
    expect(playbookFor('RETRY_STORM')?.id).toBe('P4');
    expect(playbookFor('SIM_PASS_EXEC_REVERT')?.id).toBe('P4');
    expect(playbookFor('SIGNER_GAS_STARVED')?.id).toBe('P5');
  });
});

const market = { baseFee: 1_000_000_000n, suggestedPriorityFee: 1_000_000_000n };
const planCtx = (over: Record<string, unknown> = {}) => ({
  incident: incident(),
  config: liveConfig(),
  ...market,
  ...over,
});

describe('P1 replacement', () => {
  it('reuses the stuck nonce', () => {
    const plan = P1.plan(planCtx());
    expect(plan.kind).toBe('submit');
    if (plan.kind === 'submit') expect(plan.nonce).toBe(5);
  });

  it('bids well above the 12.5% replacement floor', () => {
    const plan = P1.plan(planCtx());
    if (plan.kind !== 'submit') throw new Error('expected a submission');
    // A replacement that fails to displace is worse than none: it burns a slot
    // and the time taken to discover it did not work.
    expect(plan.maxFeePerGas).toBeGreaterThan((1_000_000_000n * 115n) / 100n);
  });

  it('sends zero value rather than replaying unknown calldata', () => {
    const plan = P1.plan(planCtx());
    if (plan.kind !== 'submit') throw new Error('expected a submission');
    // Replaying could double-execute an action that was merely slow.
    expect(plan.value).toBe(0n);
    expect(plan.to).toBe(SIGNER);
  });

  it('routes privately where the chain supports it', () => {
    const plan = P1.plan(planCtx());
    if (plan.kind !== 'submit') throw new Error('expected a submission');
    expect(plan.route).toBe('private');
    const onBase = P1.plan(
      planCtx({ incident: incident({ chainId: CHAIN_IDS.baseSepolia }) }),
    );
    if (onBase.kind !== 'submit') throw new Error('expected a submission');
    expect(onBase.route).toBe('public');
  });

  it('declines when no nonce was recorded', () => {
    const plan = P1.plan(
      planCtx({ incident: incident({ evidence: { eventIds: ['e0'], ruleId: 'R1', facts: {} } }) }),
    );
    expect(plan.kind).toBe('skip');
  });
});

describe('P2 nonce gap clear', () => {
  const gapIncident = incident({
    class: 'NONCE_GAP',
    evidence: { eventIds: ['e0'], ruleId: 'R2', facts: { missingNonces: [41, 42] } },
  });

  it('fills the lowest missing nonce', () => {
    const plan = P2.plan(planCtx({ incident: gapIncident }));
    if (plan.kind !== 'submit') throw new Error('expected a submission');
    expect(plan.nonce).toBe(41);
    expect(plan.value).toBe(0n);
  });

  it('prices aggressively, since everything behind it is wedged', () => {
    const plan = P2.plan(planCtx({ incident: gapIncident }));
    if (plan.kind !== 'submit') throw new Error('expected a submission');
    expect(plan.maxFeePerGas).toBeGreaterThan(market.baseFee * 2n);
  });

  it('declines when no missing nonce was recorded', () => {
    const plan = P2.plan(
      planCtx({
        incident: incident({
          class: 'NONCE_GAP',
          evidence: { eventIds: ['e0'], ruleId: 'R2', facts: {} },
        }),
      }),
    );
    expect(plan.kind).toBe('skip');
  });
});

describe('P3 private reroute', () => {
  it('declines on a chain with no private mempool, naming the chain', () => {
    const plan = P3.plan(
      planCtx({
        incident: incident({ class: 'ADVERSE_INCLUSION', chainId: CHAIN_IDS.baseSepolia }),
      }),
    );
    expect(plan.kind).toBe('skip');
    if (plan.kind === 'skip') expect(plan.reason).toMatch(/Base Sepolia has no private mempool/);
  });

  it('still declines without a replay-safety declaration', () => {
    const plan = P3.plan(planCtx({ incident: incident({ class: 'ADVERSE_INCLUSION' }) }));
    expect(plan.kind).toBe('skip');
    if (plan.kind === 'skip') expect(plan.reason).toMatch(/blind-replayed/);
  });
});

describe('P4 circuit breaker', () => {
  it('declines with a call to action when no breaker is registered', () => {
    const plan = P4.plan(planCtx({ incident: incident({ class: 'RETRY_STORM' }) }));
    expect(plan.kind).toBe('skip');
    if (plan.kind === 'skip') expect(plan.reason).toMatch(/register one and grant Blackbox/);
  });

  it('calls pause on a registered breaker', () => {
    const breaker = `0x${'b'.repeat(40)}` as `0x${string}`;
    const plan = P4.plan(
      planCtx({ incident: incident({ class: 'RETRY_STORM' }), breakerAddress: breaker }),
    );
    if (plan.kind !== 'submit') throw new Error('expected a submission');
    expect(plan.to).toBe(breaker);
    expect(plan.data).toBe('0x8456cb59'); // pause()
  });
});

describe('P5 top-up', () => {
  const starved = incident({
    class: 'SIGNER_GAS_STARVED',
    evidence: { eventIds: ['e0'], ruleId: 'R6', facts: { medianRecentCost: '1000000000000000' } },
  });

  it('declines without a funding wallet', () => {
    expect(P5.plan(planCtx({ incident: starved })).kind).toBe('skip');
  });

  it('sizes the transfer to the configured number of actions', () => {
    const plan = P5.plan(
      planCtx({ incident: starved, fundingWallet: `0x${'c'.repeat(40)}` }),
    );
    if (plan.kind !== 'submit') throw new Error('expected a submission');
    expect(plan.value).toBe(1_000_000_000_000_000n * 10n);
    expect(plan.to).toBe(SIGNER);
  });
});

const executor = (over: Partial<RemediationExecutor> = {}): RemediationExecutor => ({
  submit: async () => ({ txHash: TX }),
  verify: async () => ({ included: true, gasUsed: 21_000n, effectiveGasPrice: 2_000_000_000n }),
  ...over,
});

const remediator = (over: Record<string, unknown> = {}) => {
  let n = 0;
  return new Remediator({
    db,
    config: liveConfig(),
    executor: executor(),
    market: async () => market,
    makeId: () => `led-${n++}`,
    now: () => T0,
    ...over,
  });
};

describe('remediation outcomes', () => {
  it('records a real transaction hash on success', async () => {
    const { record } = await remediator().remediate(incident());
    expect(record.finalStatus).toBe('succeeded');
    expect(record.attempts[0]!.txHash).toBe(TX);
    expect(record.verifiedAt).toBeDefined();
  });

  it('reports skipped_by_guard with the failing guard named', async () => {
    const { record, guardsFailed } = await remediator({
      config: liveConfig({ dryRun: true }),
    }).remediate(incident());
    expect(record.finalStatus).toBe('skipped_by_guard');
    expect(record.attempts[0]!.guardsFailed).toContain('dry_run');
    expect(guardsFailed[0]!.reason).toMatch(/dry run/);
  });

  it('reports skipped_by_policy when the playbook cannot act', async () => {
    // Base Sepolia must be allowlisted, otherwise the chain guard fires first
    // and the outcome is skipped_by_guard — which is correct, but not what
    // this test is about.
    const { record } = await remediator({
      config: liveConfig({ chainAllowlist: [CHAIN_IDS.sepolia, CHAIN_IDS.baseSepolia] }),
    }).remediate(incident({ class: 'ADVERSE_INCLUSION', chainId: CHAIN_IDS.baseSepolia }));
    expect(record.finalStatus).toBe('skipped_by_policy');
    expect(record.attempts[0]!.failureReason).toMatch(/no private mempool/);
  });

  it('marks a submission that never confirms as failed, not succeeded', async () => {
    const { record } = await remediator({
      executor: executor({ verify: async () => ({ included: false }) }),
    }).remediate(incident());
    expect(record.finalStatus).toBe('failed');
    expect(record.attempts[0]!.failureReason).toMatch(/not confirmed/);
    expect(record.verifiedAt).toBeUndefined();
  });

  it('records a failed remediation loudly when submission throws', async () => {
    const { record } = await remediator({
      executor: executor({
        submit: async () => {
          throw new Error('insufficient funds');
        },
      }),
      logger: { info: () => {}, error: () => {} },
    }).remediate(incident());
    // Never silently dropped: a remediation that could not execute is itself an
    // auditable failure.
    expect(record.finalStatus).toBe('failed');
    expect(record.attempts[0]!.failureReason).toMatch(/insufficient funds/);
  });

  it('ledgers every attempt so the budget guard can see it', async () => {
    await remediator().remediate(incident());
    const rows = await db.select().from(remediationLedger);
    expect(rows).toHaveLength(1);
    // Cost, not gas units: 21,000 gas at 2 gwei. Recording the count here is
    // what made /api/stats report a real remediation as 21,000 wei.
    expect(rows[0]!.gasSpentWei).toBe('42000000000000');
    expect(rows[0]!.txHash).toBe(TX);
  });

  it('ledgers failures too, since they cost gas and capacity', async () => {
    await remediator({
      executor: executor({ verify: async () => ({ included: false }) }),
    }).remediate(incident());
    const rows = await db.select().from(remediationLedger);
    expect(rows[0]!.status).toBe('failed');
  });
});

describe('per-signer mutex', () => {
  it('holds the signer for the whole submit-and-verify window', async () => {
    let observedDuringVerify: string[] = [];
    const r: Remediator = remediator({
      executor: executor({
        verify: async () => {
          observedDuringVerify = r.busySigners;
          return { included: true, gasUsed: 21_000n, effectiveGasPrice: 2_000_000_000n };
        },
      }),
    });
    await r.remediate(incident());
    // Releasing after submit would let a second remediation pick the same
    // nonce while the first is still settling.
    expect(observedDuringVerify).toContain(mutexKey(SIGNER, CHAIN_IDS.sepolia));
  });

  it('releases the signer once the attempt finishes', async () => {
    const r = remediator();
    await r.remediate(incident());
    expect(r.busySigners).toEqual([]);
  });

  it('releases the signer even when submission throws', async () => {
    const r = remediator({
      executor: executor({
        submit: async () => {
          throw new Error('boom');
        },
      }),
      logger: { info: () => {}, error: () => {} },
    });
    await r.remediate(incident());
    expect(r.busySigners).toEqual([]);
  });

  it('refuses a concurrent remediation on the same signer', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let verifyStarted: () => void = () => {};
    const inVerify = new Promise<void>((res) => {
      verifyStarted = res;
    });

    const r = remediator({
      executor: executor({
        verify: async () => {
          verifyStarted();
          await gate;
          return { included: true, gasUsed: 21_000n };
        },
      }),
    });

    const first = r.remediate(incident());
    // Wait for the first attempt to genuinely reach verification. A bare
    // microtask tick is not enough — there are database round trips before it.
    await inVerify;

    const second = await r.remediate(incident({ id: 'inc-2' }));
    release();
    await first;

    expect(second.record.finalStatus).toBe('skipped_by_guard');
    expect(second.record.attempts[0]!.guardsFailed).toContain('no_remediation_in_flight');
  });
});

describe('who a playbook can serve', () => {
  /**
   * The honesty this exists for: refusing before spending, with a reason an
   * operator can act on rather than "no remediation available".
   */
  it('refuses a nonce-bearing playbook for a managed wallet, and says why', () => {
    const check = servability(P1, 'keeperhub', ['signer', 'keeperhub']);
    expect(check.servable).toBe(false);
    expect(check.reason).toContain('does not apply to a keeperhub agent');
  });

  it('serves the same playbook for an agent that holds its own key', () => {
    expect(servability(P1, 'signer', ['signer']).servable).toBe(true);
  });

  // Pausing carries no nonce and asks nothing of the sender beyond the role, so
  // it is the one playbook a managed wallet can be served by today.
  it('serves the circuit breaker for either kind of agent', () => {
    expect(servability(P4, 'keeperhub', ['keeperhub-workflow']).servable).toBe(true);
    expect(servability(P4, 'signer', ['signer']).servable).toBe(true);
  });

  it('refuses when this deployment has no executor the playbook can use', () => {
    const check = servability(P4, 'signer', []);
    expect(check.servable).toBe(false);
    expect(check.reason).toContain('this deployment has none');
  });

  // An agent nobody has classified is offered everything: declining on a guess
  // would refuse a fix somebody could have used.
  it('withholds nothing when the agent kind is unknown', () => {
    expect(servability(P1, undefined, ['signer']).servable).toBe(true);
    expect(servability(P2, undefined, ['user-signed']).servable).toBe(true);
  });
});
