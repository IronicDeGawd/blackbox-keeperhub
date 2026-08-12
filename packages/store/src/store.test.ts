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
  eventsByIds,
  getIncident,
  listAgents,
  recordGapObservation,
  recordRemediationAttempt,
  remediationLedger,
  saveIncident,
  stats,
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
  await db.delete(remediationLedger);
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

describe('API queries', () => {
  const mkIncident = (over: Record<string, unknown> = {}) => ({
    id: `inc-${Math.random().toString(36).slice(2)}`,
    key: 'k',
    class: 'NONCE_GAP',
    severity: 'critical',
    status: 'open',
    agentId: 'chaos',
    signer: '0x01cc313321eb09c51f5b649f2bbd578ee32750a5',
    chainId: 11155111,
    detectedAt: new Date('2026-08-10T12:01:00Z'),
    firstEventAt: new Date('2026-08-10T12:00:00Z'),
    lastSeenAt: new Date('2026-08-10T12:01:00Z'),
    ruleId: 'R2',
    confidence: 0.9,
    evidence: { eventIds: ['e0'], ruleId: 'R2', facts: {} },
    ...over,
  });

  it('composes filters with AND', async () => {
    await saveIncident(db, mkIncident({ id: 'a' }) as never);
    await saveIncident(db, mkIncident({ id: 'b', severity: 'warning' }) as never);
    await saveIncident(db, mkIncident({ id: 'c', chainId: 84532 }) as never);

    const found = await listIncidents(db, { severity: 'critical', chainId: 11155111 });
    expect(found.map((i) => i.id).sort()).toEqual(['a']);
  });

  it('matches a signer case-insensitively, since a UI sends it checksummed', async () => {
    await saveIncident(db, mkIncident({ id: 'a' }) as never);
    const found = await listIncidents(db, {
      signer: '0x01CC313321EB09C51F5B649F2BBD578EE32750A5',
    });
    expect(found).toHaveLength(1);
  });

  it('returns null for an incident that does not exist', async () => {
    expect(await getIncident(db, 'nope')).toBeNull();
  });

  it('reports means as null rather than zero when nothing qualifies', async () => {
    const s = await stats(db);
    // Zero would read as instant detection rather than as no data.
    expect(s.meanTimeToDetectionMs).toBeNull();
    expect(s.meanTimeToRemediationMs).toBeNull();
  });

  it('leaves an incident with no event behind it out of the detection mean', async () => {
    // R8 reads the organisation's spend cap from the platform: there is no
    // execution behind it, so there is no moment the failure started, and
    // counting it as zero would drag the figure down for no real reason.
    await saveIncident(db, mkIncident({ id: 'with-event' }) as never);
    await saveIncident(
      db,
      mkIncident({
        id: 'without',
        key: 'k2',
        class: 'SPEND_CAP_EXHAUSTED',
        ruleId: 'R8',
        firstEventAt: new Date('2026-08-10T12:01:00Z'),
        evidence: { eventIds: [], ruleId: 'R8', facts: {} },
      }) as never,
    );

    expect((await stats(db)).meanTimeToDetectionMs).toBe(60_000);
    expect((await stats(db)).incidentsDetected).toBe(2);
  });

  it('measures detection latency from the first evidence event, not the row write', async () => {
    await saveIncident(db, mkIncident({ id: 'a' }) as never);
    const s = await stats(db);
    expect(s.meanTimeToDetectionMs).toBe(60_000);
  });

  it('counts only Blackbox-attributed resolutions as remediation latency', async () => {
    await saveIncident(
      db,
      mkIncident({
        id: 'a',
        status: 'resolved',
        resolvedAt: new Date('2026-08-10T12:02:00Z'),
        resolvedBy: 'external',
      }) as never,
    );
    expect((await stats(db)).meanTimeToRemediationMs).toBeNull();

    await saveIncident(
      db,
      mkIncident({
        id: 'b',
        status: 'resolved',
        resolvedAt: new Date('2026-08-10T12:02:00Z'),
        resolvedBy: 'blackbox',
      }) as never,
    );
    expect((await stats(db)).meanTimeToRemediationMs).toBe(60_000);
  });

  it('excludes resolved and acknowledged incidents from the open counts', async () => {
    await saveIncident(db, mkIncident({ id: 'a' }) as never);
    await saveIncident(db, mkIncident({ id: 'b', status: 'acknowledged' }) as never);
    await saveIncident(db, mkIncident({ id: 'c', status: 'resolved' }) as never);
    expect((await stats(db)).openBySeverity.critical).toBe(1);
  });

  it('sums ledger gas as a bigint string, since the total can exceed 2^53', async () => {
    for (const [i, gas] of ['9000000000000000000', '9000000000000000000'].entries()) {
      await recordRemediationAttempt(db, {
        id: `rem-${i}`,
        incidentId: 'a',
        playbookId: 'P2',
        signer: '0x01cc313321eb09c51f5b649f2bbd578ee32750a5',
        chainId: 11155111,
        attemptedAt: new Date(),
        gasSpentWei: BigInt(gas),
        status: 'succeeded',
      });
    }
    expect((await stats(db)).remediations.gasWei).toBe('18000000000000000000');
  });

  it('groups agents with their signers, chains and open counts', async () => {
    await saveIncident(db, mkIncident({ id: 'a' }) as never);
    await saveIncident(db, mkIncident({ id: 'b', chainId: 84532, status: 'resolved' }) as never);
    const agents = await listAgents(db);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ agentId: 'chaos', openIncidents: 1 });
    expect(agents[0]?.chainIds.sort()).toEqual([11155111, 84532]);
  });

  it('returns an empty list for no event ids rather than querying', async () => {
    expect(await eventsByIds(db, [])).toEqual([]);
  });
});

describe('saving an incident without analysis', () => {
  const base = {
    id: 'inc-preserve',
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
  };

  it('keeps an analysis the update did not carry', async () => {
    // The recorder re-saves every tracked incident each tick and knows nothing
    // about rca or remediation. Overwriting them with null silently erased a
    // completed remediation between one poll and the next.
    await saveIncident(db, base as never);
    await saveIncident(db, {
      ...base,
      rca: { summary: 'because of the nonce', contributingFactors: [] },
      remediation: { playbookId: 'P2', finalStatus: 'succeeded', attempts: [] },
    } as never);

    await saveIncident(db, { ...base, status: 'open' } as never);

    const stored = await getIncident(db, 'inc-preserve');
    expect(stored?.remediation).toMatchObject({ finalStatus: 'succeeded' });
    expect(stored?.rca).toMatchObject({ summary: 'because of the nonce' });
  });

  it('still lets an update replace an existing analysis', async () => {
    await saveIncident(db, { ...base, rca: { summary: 'first' } } as never);
    await saveIncident(db, { ...base, rca: { summary: 'second' } } as never);
    expect((await getIncident(db, 'inc-preserve'))?.rca).toMatchObject({ summary: 'second' });
  });
});

describe('re-observing a transaction', () => {
  const pendingEvent = (over: Record<string, unknown> = {}) =>
    ({
      id: 'e-settle',
      sourceId: 'chain:11155111:0xabc',
      logicalActionId: 'action-1',
      attemptIndex: 0,
      agentId: 'chaos',
      signer: '0x01cc313321eb09c51f5b649f2bbd578ee32750a5',
      chainId: 11155111,
      trigger: { kind: 'manual' },
      simulation: { performed: false },
      submission: { txHash: '0xabc', nonce: 1, submittedAt: new Date(), route: 'public' },
      outcome: { status: 'pending' },
      raw: null,
      ingestedAt: new Date(),
      ...over,
    }) as never;

  it('replaces a pending observation once the transaction settles', async () => {
    // A retry storm ingested mid-flight stayed four pending rows forever, and
    // R5 only fires on failed events, so nothing was ever detected.
    await insertEvents(db, [pendingEvent()]);
    await insertEvents(db, [
      pendingEvent({
        id: 'e-settle-2',
        outcome: { status: 'reverted', blockNumber: 10, gasUsed: 21_000n },
      }),
    ]);

    const rows = await db.select().from(executionEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcomeStatus).toBe('reverted');
    expect(rows[0]?.blockNumber).toBe(10);
  });

  it('never walks a terminal outcome back to pending', async () => {
    await insertEvents(db, [
      pendingEvent({ outcome: { status: 'included', blockNumber: 10, gasUsed: 21_000n } }),
    ]);
    await insertEvents(db, [pendingEvent({ id: 'e-late' })]);

    const rows = await db.select().from(executionEvents);
    expect(rows[0]?.outcomeStatus).toBe('included');
  });

  it('keeps a simulation recorded on the settled observation', async () => {
    await insertEvents(db, [pendingEvent()]);
    await insertEvents(db, [
      pendingEvent({
        outcome: { status: 'reverted', blockNumber: 11 },
        simulation: { performed: true, success: true, simulatedAtBlock: 10 },
      }),
    ]);
    const rows = await db.select().from(executionEvents);
    expect(rows[0]?.simulationSuccess).toBe(true);
  });
});
