import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { blackboxConfigSchema, CHAIN_IDS, type BlackboxConfig } from '@blackbox/core';
import {
  createDb,
  incidents,
  listIncidents,
  remediationLedger,
  saveIncident,
  type Database,
} from '@blackbox/store';
import { RemediationLoop, toIncident } from './loop.js';
import { Remediator, type RemediationExecutor } from './remediator.js';

const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const SIGNER = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5' as `0x${string}`;
const T0 = new Date('2026-08-10T12:00:00.000Z');
const TX = `0x${'b'.repeat(64)}` as `0x${string}`;

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
  await db.delete(incidents);
});

const config = (): BlackboxConfig =>
  blackboxConfigSchema.parse({
    keeperHub: { orgKey: 'kh_test' },
    databaseUrl: URL,
    remediation: {
      dryRun: false,
      signerAllowlist: [SIGNER],
      chainAllowlist: [CHAIN_IDS.sepolia],
    },
  });

const openIncident = async (over: Record<string, unknown> = {}) => {
  const row = {
    id: 'inc-1',
    key: `chaos|${SIGNER}|${CHAIN_IDS.sepolia}|NONCE_GAP`,
    class: 'NONCE_GAP',
    severity: 'critical',
    status: 'open',
    agentId: 'chaos',
    signer: SIGNER,
    chainId: CHAIN_IDS.sepolia,
    detectedAt: T0,
    firstEventAt: T0,
    lastSeenAt: T0,
    ruleId: 'R2',
    confidence: 0.9,
    evidence: { eventIds: ['e0'], ruleId: 'R2', facts: { missingNonces: [41] } },
    ...over,
  };
  await saveIncident(db, row as never);
  return row;
};

const executor = (over: Partial<RemediationExecutor> = {}): RemediationExecutor => ({
  submit: vi.fn(async () => ({ txHash: TX })),
  verify: vi.fn(async () => ({ included: true, gasUsed: 21_000n })),
  ...over,
});

const loopWith = (exec: RemediationExecutor, logger?: never) =>
  new RemediationLoop({
    db,
    remediator: new Remediator({
      db,
      config: config(),
      executor: exec,
      market: async () => ({ baseFee: 1_000_000_000n, suggestedPriorityFee: 1_000_000_000n }),
      makeId: () => `rem-${Math.random().toString(36).slice(2)}`,
      now: () => T0,
    }),
    ...(logger ? { logger } : {}),
  });

describe('RemediationLoop', () => {
  it('remediates an open incident and records the outcome on it', async () => {
    await openIncident();
    const result = await loopWith(executor()).tick();

    expect(result).toMatchObject({ considered: 1, attempted: 1, succeeded: 1, errors: 0 });
    const [stored] = await listIncidents(db);
    expect(stored?.remediation).toMatchObject({
      playbookId: 'P2',
      finalStatus: 'succeeded',
    });
  });

  it('stores gas figures as strings, since JSONB cannot hold a bigint', async () => {
    await openIncident();
    await loopWith(executor()).tick();
    const [stored] = await listIncidents(db);
    const attempt = (stored?.remediation as { attempts: { gasUsed: unknown }[] }).attempts[0];
    expect(attempt?.gasUsed).toBe('21000');
  });

  it('leaves incidents that are not open alone', async () => {
    await openIncident({ status: 'resolved' });
    const result = await loopWith(executor()).tick();
    expect(result).toMatchObject({ considered: 0, attempted: 0 });
  });

  it('counts a declined remediation as skipped, not failed', async () => {
    // No missing nonce recorded, so P2 declines with a reason.
    await openIncident({ evidence: { eventIds: ['e0'], ruleId: 'R2', facts: {} } });
    const result = await loopWith(executor()).tick();
    expect(result).toMatchObject({ attempted: 1, skipped: 1, succeeded: 0, failed: 0 });
  });

  it('records a failed remediation when the executor refuses to submit', async () => {
    await openIncident();
    const refusing = executor({
      submit: vi.fn(async () => {
        throw new Error('KeeperHub cannot submit at a chosen nonce');
      }),
    });
    const result = await loopWith(refusing).tick();
    expect(result).toMatchObject({ attempted: 1, failed: 1 });
    const [stored] = await listIncidents(db);
    expect(stored?.remediation).toMatchObject({ finalStatus: 'failed' });
  });

  it('keeps going after one incident throws', async () => {
    await openIncident();
    await openIncident({ id: 'inc-2', key: 'other' });
    const errors: unknown[] = [];
    const loop = new RemediationLoop({
      db,
      remediator: {
        remediate: vi
          .fn()
          .mockRejectedValueOnce(new Error('boom'))
          .mockResolvedValueOnce({ record: { playbookId: 'P2', attempts: [], finalStatus: 'succeeded' }, guardsFailed: [] }),
      } as never,
      logger: { info: () => {}, error: (_m, d) => errors.push(d) },
    });

    const result = await loop.tick();
    expect(result).toMatchObject({ considered: 2, errors: 1, succeeded: 1 });
    expect(errors).toHaveLength(1);
  });
});

describe('toIncident', () => {
  it('rejects a row whose evidence has drifted out of shape', () => {
    expect(() =>
      toIncident({
        id: 'inc-1',
        class: 'NONCE_GAP',
        severity: 'critical',
        status: 'open',
        agentId: 'chaos',
        signer: SIGNER,
        chainId: CHAIN_IDS.sepolia,
        detectedAt: T0,
        firstEventAt: T0,
        resolvedAt: null,
        confidence: 0.9,
        evidence: { ruleId: 'R2' },
      }),
    ).toThrow();
  });
});

describe('remediation attribution', () => {
  it('tells the caller what it did, so the tracker can attribute the resolution', async () => {
    await openIncident();
    const seen: { id: string; status: string }[] = [];
    const loop = new RemediationLoop({
      db,
      remediator: new Remediator({
        db,
        config: config(),
        executor: executor(),
        market: async () => ({ baseFee: 1_000_000_000n, suggestedPriorityFee: 1_000_000_000n }),
        makeId: () => 'rem-1',
        now: () => T0,
      }),
      onRemediated: (id, outcome) => seen.push({ id, status: outcome.record.finalStatus }),
    });

    await loop.tick();
    expect(seen).toEqual([{ id: 'inc-1', status: 'succeeded' }]);
  });
});
