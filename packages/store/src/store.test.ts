import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionEvent } from '@blackbox/core';
import {
  createDb,
  executionEvents,
  getCursor,
  incidents,
  insertEvents,
  listIncidents,
  loadSignerWindow,
  recordGapObservation,
  saveIncident,
  setCursor,
  signerState,
  type Database,
} from './index.js';

/**
 * Runs against the Docker Postgres from docker-compose. These assertions are
 * about what the database actually does with the data — bigint precision,
 * conflict handling, atomic counters — none of which a mock would tell us.
 */
const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';

let db: Database;
let close: () => Promise<void>;

const SIGNER = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5';
const T0 = new Date('2026-08-09T18:00:00.000Z');

const event = (over: Partial<{ id: string; nonce: number; status: string }> = {}): ExecutionEvent => ({
  id: over.id ?? 'evt-1',
  sourceId: over.id ?? 'evt-1',
  logicalActionId: 'action-1',
  attemptIndex: 0,
  agentId: 'chaos',
  signer: SIGNER as `0x${string}`,
  chainId: 11155111,
  trigger: { kind: 'api' },
  simulation: { performed: true, success: true, gasEstimate: 68021n, simulatedAtBlock: 11453640 },
  submission: {
    txHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    nonce: over.nonce ?? 5,
    // Deliberately larger than 2^63 to prove the text column preserves it.
    maxFeePerGas: 99_999_999_999_999_999_999_999n,
    maxPriorityFeePerGas: 2_000_000_000n,
    submittedAt: T0,
    route: 'public',
  },
  outcome: {
    status: (over.status ?? 'included') as ExecutionEvent['outcome']['status'],
    blockNumber: 11453642,
    gasUsed: 68021n,
    effectiveGasPrice: 1_015_327_660n,
    observedAt: new Date(T0.getTime() + 11_000),
  },
  raw: { executionId: '4b3qn7m2ydaoxv3iqd1df' },
  ingestedAt: T0,
});

beforeAll(() => {
  ({ db, close } = createDb(URL));
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await db.delete(executionEvents);
  await db.delete(incidents);
  await db.delete(signerState);
});

describe('execution events', () => {
  it('round-trips an event without losing bigint precision', async () => {
    await insertEvents(db, [event()]);
    const [loaded] = await loadSignerWindow(db, {
      signer: SIGNER,
      chainId: 11155111,
      since: new Date(0),
    });

    expect(loaded).toBeDefined();
    // A numeric column or a JS number would have mangled this value.
    expect(loaded!.submission.maxFeePerGas).toBe(99_999_999_999_999_999_999_999n);
    expect(loaded!.outcome.gasUsed).toBe(68021n);
    expect(loaded!.outcome.effectiveGasPrice).toBe(1_015_327_660n);
    expect(loaded!.simulation.gasEstimate).toBe(68021n);
    expect(loaded!.outcome.status).toBe('included');
    expect(loaded!.submission.route).toBe('public');
    expect(loaded!.raw).toMatchObject({ executionId: '4b3qn7m2ydaoxv3iqd1df' });
  });

  it('preserves dates across the round trip', async () => {
    await insertEvents(db, [event()]);
    const [loaded] = await loadSignerWindow(db, {
      signer: SIGNER,
      chainId: 11155111,
      since: new Date(0),
    });
    expect(loaded!.submission.submittedAt.toISOString()).toBe(T0.toISOString());
    expect(loaded!.outcome.observedAt?.toISOString()).toBe(
      new Date(T0.getTime() + 11_000).toISOString(),
    );
  });

  it('ignores a re-polled attempt instead of duplicating it', async () => {
    expect(await insertEvents(db, [event()])).toBe(1);
    // The recorder re-polls in-flight executions, so this happens constantly.
    expect(await insertEvents(db, [event()])).toBe(0);
    const all = await loadSignerWindow(db, { signer: SIGNER, chainId: 11155111, since: new Date(0) });
    expect(all).toHaveLength(1);
  });

  it('matches the signer case-insensitively', async () => {
    await insertEvents(db, [event()]);
    const upper = await loadSignerWindow(db, {
      signer: SIGNER.toUpperCase(),
      chainId: 11155111,
      since: new Date(0),
    });
    expect(upper).toHaveLength(1);
  });

  it('excludes events older than the window', async () => {
    await insertEvents(db, [event()]);
    const recent = await loadSignerWindow(db, {
      signer: SIGNER,
      chainId: 11155111,
      since: new Date(T0.getTime() + 1),
    });
    expect(recent).toHaveLength(0);
  });

  it('returns the window oldest first, as the rules expect', async () => {
    const older = { ...event({ id: 'a' }) };
    const newer = {
      ...event({ id: 'b' }),
      submission: { ...event({ id: 'b' }).submission, submittedAt: new Date(T0.getTime() + 5_000) },
    };
    await insertEvents(db, [newer, older]);
    const window = await loadSignerWindow(db, {
      signer: SIGNER,
      chainId: 11155111,
      since: new Date(0),
    });
    expect(window.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('incidents', () => {
  const incident = (over: Partial<typeof incidents.$inferInsert> = {}) => ({
    id: 'inc-1',
    key: `chaos|${SIGNER}|11155111|STUCK_TRANSACTION`,
    class: 'STUCK_TRANSACTION',
    severity: 'warning',
    status: 'open',
    agentId: 'chaos',
    signer: SIGNER,
    chainId: 11155111,
    detectedAt: T0,
    firstEventAt: T0,
    lastSeenAt: T0,
    ruleId: 'R1',
    confidence: 0.6,
    evidence: { eventIds: ['evt-1'], ruleId: 'R1', facts: { nonce: 5 } },
    ...over,
  });

  it('saves and lists an incident', async () => {
    await saveIncident(db, incident());
    const rows = await listIncidents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.class).toBe('STUCK_TRANSACTION');
  });

  it('upserts by id so status transitions do not create duplicates', async () => {
    await saveIncident(db, incident());
    await saveIncident(
      db,
      incident({ status: 'resolved', resolvedAt: T0, resolvedBy: 'blackbox', confidence: 0.95 }),
    );
    const rows = await listIncidents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('resolved');
    expect(rows[0]!.resolvedBy).toBe('blackbox');
    expect(rows[0]!.confidence).toBeCloseTo(0.95);
  });

  it('filters by status', async () => {
    await saveIncident(db, incident());
    await saveIncident(db, incident({ id: 'inc-2', status: 'resolved' }));
    expect(await listIncidents(db, { status: 'open' })).toHaveLength(1);
  });

  it('stores a remediation record with its transaction hash', async () => {
    await saveIncident(
      db,
      incident({
        remediation: {
          playbookId: 'P1',
          attempts: [{ attemptIndex: 0, txHash: `0x${'b'.repeat(64)}`, status: 'succeeded' }],
          finalStatus: 'succeeded',
        },
      }),
    );
    const [row] = await listIncidents(db);
    expect((row!.remediation as { finalStatus: string }).finalStatus).toBe('succeeded');
  });
});

describe('cursors', () => {
  it('returns null before anything is recorded', async () => {
    expect(await getCursor(db, 'keeperhub:none')).toBeNull();
  });

  it('persists and overwrites a cursor', async () => {
    await setCursor(db, 'keeperhub:test', 'abc');
    expect(await getCursor(db, 'keeperhub:test')).toBe('abc');
    await setCursor(db, 'keeperhub:test', 'def');
    expect(await getCursor(db, 'keeperhub:test')).toBe('def');
  });
});

describe('gap observation counter', () => {
  it('increments while the gap persists', async () => {
    const args = { signer: SIGNER, chainId: 11155111, gapPresent: true, at: T0 };
    expect(await recordGapObservation(db, args)).toBe(1);
    expect(await recordGapObservation(db, args)).toBe(2);
    expect(await recordGapObservation(db, args)).toBe(3);
  });

  it('resets to zero once the gap closes', async () => {
    await recordGapObservation(db, { signer: SIGNER, chainId: 11155111, gapPresent: true, at: T0 });
    await recordGapObservation(db, { signer: SIGNER, chainId: 11155111, gapPresent: true, at: T0 });
    expect(
      await recordGapObservation(db, { signer: SIGNER, chainId: 11155111, gapPresent: false, at: T0 }),
    ).toBe(0);
  });

  it('counts each chain separately', async () => {
    await recordGapObservation(db, { signer: SIGNER, chainId: 11155111, gapPresent: true, at: T0 });
    await recordGapObservation(db, { signer: SIGNER, chainId: 11155111, gapPresent: true, at: T0 });
    expect(
      await recordGapObservation(db, { signer: SIGNER, chainId: 84532, gapPresent: true, at: T0 }),
    ).toBe(1);
  });

  it('survives a restart, because the count lives in the database', async () => {
    await recordGapObservation(db, { signer: SIGNER, chainId: 11155111, gapPresent: true, at: T0 });
    await recordGapObservation(db, { signer: SIGNER, chainId: 11155111, gapPresent: true, at: T0 });
    const { db: db2, close: close2 } = createDb(URL);
    // A fresh connection, as a restarted recorder would have.
    expect(
      await recordGapObservation(db2, { signer: SIGNER, chainId: 11155111, gapPresent: true, at: T0 }),
    ).toBe(3);
    await close2();
  });
});

describe('saveIncident with bigint payloads', () => {
  it('stores a remediation record containing bigint gas figures', async () => {
    // Attaching a remediation record put a bigint on the incident, and the
    // driver threw `Do not know how to serialize a BigInt` inside the
    // recorder's persist path — where it surfaced only as an incident that
    // never resolved. Live Sepolia found this; no unit test did.
    await saveIncident(db, {
      id: 'inc-bigint',
      key: 'k',
      class: 'NONCE_GAP',
      severity: 'critical',
      status: 'open',
      agentId: 'chaos',
      signer: '0x01cc313321eb09c51f5b649f2bbd578ee32750a5',
      chainId: 11155111,
      detectedAt: new Date(),
      firstEventAt: new Date(),
      lastSeenAt: new Date(),
      ruleId: 'R2',
      confidence: 0.9,
      evidence: { eventIds: ['e0'], ruleId: 'R2', facts: {} },
      remediation: {
        playbookId: 'P2',
        finalStatus: 'succeeded',
        attempts: [{ attemptIndex: 0, gasUsed: 21_000n, status: 'succeeded' }],
      },
    } as never);

    const [stored] = await listIncidents(db, { limit: 1 });
    expect((stored?.remediation as { attempts: { gasUsed: unknown }[] }).attempts[0]?.gasUsed).toBe(
      '21000',
    );
  });
});
