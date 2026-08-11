import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blackboxConfigSchema, type KeeperHubExecution } from '@blackbox/core';
import { IncidentTracker } from '@blackbox/detector';
import {
  createDb,
  executionEvents,
  incidents,
  listIncidents,
  insertEvents,
  signerState,
  watchedExecutions,
  watchExecution,
  type Database,
} from '@blackbox/store';
import { Recorder } from './recorder.js';
import { RecorderLoop } from './loop.js';
import type { CorroborationProvider } from './corroboration.js';

const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const SIGNER = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5' as `0x${string}`;
const CHAIN = 11155111;
const T0 = new Date('2026-08-09T18:00:00.000Z');

const config = blackboxConfigSchema.parse({
  keeperHub: { orgKey: 'kh_test' },
  databaseUrl: URL,
});

let db: Database;
let close: () => Promise<void>;

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
  await db.delete(watchedExecutions);
});

const pendingExecution = (id: string): KeeperHubExecution => ({
  executionId: id,
  status: 'running',
  type: 'transfer',
  transactionHash: `0x${'c'.repeat(64)}`,
  receipts: [],
  error: null,
  retryCount: 0,
  network: 'sepolia',
  createdAt: T0.toISOString(),
  completedAt: null,
});

const completedExecution = (id: string): KeeperHubExecution => ({
  executionId: id,
  status: 'completed',
  type: 'transfer',
  transactionHash: `0x${'d'.repeat(64)}`,
  sponsored: true,
  receipts: [
    {
      hash: `0x${'d'.repeat(64)}`,
      chainId: CHAIN,
      gasUsed: '68021',
      verified: true,
      verifiedAt: T0.toISOString(),
      blockNumber: 11453642,
      receiptStatus: 'success',
    },
  ],
  error: null,
  gasUsedWei: '68021',
  gasPriceWei: '1015327660',
  retryCount: 0,
  network: 'sepolia',
  createdAt: T0.toISOString(),
  completedAt: T0.toISOString(),
});

const noCorroboration: CorroborationProvider = { gather: async () => ({}) };

const makeRecorder = (over: {
  fetch?: (id: string) => Promise<KeeperHubExecution>;
  corroboration?: CorroborationProvider;
  now?: () => Date;
  tracker?: IncidentTracker;
}) => {
  let n = 0;
  return new Recorder({
    db,
    keeperHub: {
      getExecutionStatus: over.fetch ?? (async (id) => completedExecution(id)),
    },
    corroboration: over.corroboration ?? noCorroboration,
    config,
    tracker: over.tracker ?? new IncidentTracker({ makeId: () => `inc-${n++}` }),
    makeId: () => `evt-${n++}`,
    now: over.now ?? (() => T0),
  });
};

describe('polling watched executions', () => {
  it('persists normalised events from a completed execution', async () => {
    await watchExecution(db, {
      executionId: 'x1',
      agentId: 'chaos',
      signer: SIGNER,
      chainId: CHAIN,
      at: T0,
    });

    const result = await makeRecorder({}).tick();
    expect(result.polled).toBe(1);
    expect(result.eventsInserted).toBe(1);
    expect(result.settled).toBe(1);

    const rows = await db.select().from(executionEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcomeStatus).toBe('included');
    expect(rows[0]!.blockNumber).toBe(11453642);
  });

  it('stops polling an execution once it settles', async () => {
    await watchExecution(db, {
      executionId: 'x1',
      agentId: 'chaos',
      signer: SIGNER,
      chainId: CHAIN,
      at: T0,
    });
    const recorder = makeRecorder({});
    await recorder.tick();
    // Second tick has nothing due, because the first settled it.
    expect((await recorder.tick()).polled).toBe(0);
  });

  it('keeps polling an execution that is still running', async () => {
    await watchExecution(db, {
      executionId: 'x1',
      agentId: 'chaos',
      signer: SIGNER,
      chainId: CHAIN,
      at: T0,
    });
    const recorder = makeRecorder({ fetch: async (id) => pendingExecution(id) });
    expect((await recorder.tick()).settled).toBe(0);
    expect((await recorder.tick()).polled).toBe(1);
  });

  it('does not duplicate events when the same execution is polled twice', async () => {
    await watchExecution(db, {
      executionId: 'x1',
      agentId: 'chaos',
      signer: SIGNER,
      chainId: CHAIN,
      at: T0,
    });
    const recorder = makeRecorder({ fetch: async (id) => pendingExecution(id) });
    await recorder.tick();
    const second = await recorder.tick();
    expect(second.eventsInserted).toBe(0);
    expect(await db.select().from(executionEvents)).toHaveLength(1);
  });

  it('applies wrapper-supplied fee data the audit record lacks', async () => {
    await watchExecution(db, {
      executionId: 'x1',
      agentId: 'chaos',
      signer: SIGNER,
      chainId: CHAIN,
      submitted: { maxFeePerGas: '500000000', nonce: 7, route: 'private' },
      at: T0,
    });
    await makeRecorder({}).tick();
    const [row] = await db.select().from(executionEvents);
    expect(row!.nonce).toBe(7);
    expect((row!.submission as { route: string }).route).toBe('private');
    expect((row!.submission as { maxFeePerGas: string }).maxFeePerGas).toBe('500000000');
  });
});

describe('resilience', () => {
  it('counts a failing poll as an error and keeps going', async () => {
    for (const id of ['bad', 'good']) {
      await watchExecution(db, {
        executionId: id,
        agentId: 'chaos',
        signer: SIGNER,
        chainId: CHAIN,
        at: T0,
      });
    }
    const recorder = makeRecorder({
      fetch: async (id) => {
        if (id === 'bad') throw new Error('KeeperHub 500');
        return completedExecution(id);
      },
    });

    const result = await recorder.tick();
    // The healthy execution must still be recorded.
    expect(result.errors).toBe(1);
    expect(result.eventsInserted).toBe(1);
  });

  it('continues evaluating when corroboration fails', async () => {
    await watchExecution(db, {
      executionId: 'x1',
      agentId: 'chaos',
      signer: SIGNER,
      chainId: CHAIN,
      at: T0,
    });
    const recorder = makeRecorder({
      corroboration: {
        gather: async () => {
          throw new Error('RPC down');
        },
      },
    });
    // Degraded, not dead: events still land, rules simply see no chain facts.
    const result = await recorder.tick();
    expect(result.eventsInserted).toBe(1);
    expect(result.signersEvaluated).toBe(1);
  });

  it('does nothing gracefully when there is no work', async () => {
    const result = await makeRecorder({}).tick();
    expect(result).toMatchObject({ polled: 0, eventsInserted: 0, errors: 0 });
  });
});

describe('detection through the full pipeline', () => {
  it('creates and persists an incident from a stuck transaction', async () => {
    await watchExecution(db, {
      executionId: 'stuck-1',
      agentId: 'chaos',
      signer: SIGNER,
      chainId: CHAIN,
      submitted: { nonce: 5 },
      at: T0,
    });

    const later = new Date(T0.getTime() + 200_000);
    const recorder = makeRecorder({
      fetch: async (id) => pendingExecution(id),
      corroboration: { gather: async () => ({ latestNonce: 5, pendingNonce: 6 }) },
      now: () => later,
    });

    const result = await recorder.tick();
    expect(result.incidentsCreated).toBe(1);

    const stored = await listIncidents(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.class).toBe('STUCK_TRANSACTION');
    expect(stored[0]!.status).toBe('open');
    // Corroborated, so R1 is confident rather than guessing.
    expect(stored[0]!.confidence).toBeCloseTo(0.95);
    expect((stored[0]!.evidence as { ruleId: string }).ruleId).toBe('R1');
  });

  it('resolves the incident once the transaction lands', async () => {
    await watchExecution(db, {
      executionId: 'stuck-1',
      agentId: 'chaos',
      signer: SIGNER,
      chainId: CHAIN,
      submitted: { nonce: 5 },
      at: T0,
    });

    let now = new Date(T0.getTime() + 200_000);
    let settled = false;
    const tracker = new IncidentTracker({ makeId: () => 'inc-1' });
    const recorder = makeRecorder({
      fetch: async (id) => (settled ? completedExecution(id) : pendingExecution(id)),
      corroboration: { gather: async () => ({ latestNonce: settled ? 6 : 5, pendingNonce: 6 }) },
      now: () => now,
      tracker,
    });

    await recorder.tick();
    expect((await listIncidents(db))[0]!.status).toBe('open');

    settled = true;
    now = new Date(T0.getTime() + 260_000);
    // Re-register, since the first tick settled the watch.
    await watchExecution(db, {
      executionId: 'stuck-2',
      agentId: 'chaos',
      signer: SIGNER,
      chainId: CHAIN,
      submitted: { nonce: 5 },
      at: now,
    });
    const second = await recorder.tick();

    expect(second.incidentsResolved).toBe(1);
    const stored = await listIncidents(db);
    const resolved = stored.find((i) => i.id === 'inc-1');
    expect(resolved!.status).toBe('resolved');
    expect(resolved!.resolvedBy).toBe('external');
    expect(resolved!.resolvedAt).not.toBeNull();
  });

  it('serialises bigint corroboration into the stored evidence', async () => {
    await watchExecution(db, {
      executionId: 'stuck-1',
      agentId: 'chaos',
      signer: SIGNER,
      chainId: CHAIN,
      submitted: { nonce: 5 },
      at: T0,
    });
    const recorder = makeRecorder({
      fetch: async (id) => pendingExecution(id),
      corroboration: {
        gather: async () => ({
          latestNonce: 5,
          pendingNonce: 6,
          signerBalance: 99_999_999_999_999_999_999n,
          baseFeeAtDetection: 1_000_000_000n,
        }),
      },
      now: () => new Date(T0.getTime() + 200_000),
    });

    // JSONB cannot hold a bigint; without conversion this insert throws.
    await recorder.tick();
    const [stored] = await listIncidents(db);
    const evidence = stored!.evidence as { corroboration: Record<string, string> };
    expect(evidence.corroboration.signerBalance).toBe('99999999999999999999');
  });

  it('advances the durable gap counter each tick, which is what R2 needs', async () => {
    await watchExecution(db, {
      executionId: 'gap-1',
      agentId: 'chaos',
      signer: SIGNER,
      chainId: CHAIN,
      submitted: { nonce: 7 },
      at: T0,
    });
    const recorder = makeRecorder({
      fetch: async (id) => pendingExecution(id),
      corroboration: { gather: async () => ({ latestNonce: 6, pendingNonce: 8 }) },
      now: () => new Date(T0.getTime() + 200_000),
    });

    await recorder.tick();
    const [state] = await db.select().from(signerState);
    expect(state!.consecutiveGapPolls).toBe(1);
  });

  /**
   * The same reading, for an agent that cannot have a nonce gap. KeeperHub owns
   * nonce management for a managed wallet and submits from a shared relayer, so
   * a nonce read for that account describes KeeperHub's traffic. Counting a gap
   * from it would be evidence for an incident the agent is structurally
   * incapable of having.
   */
  it('does not derive a nonce gap for a managed wallet', async () => {
    await insertEvents(db, [
      {
        id: 'kh-1',
        sourceId: 'run-1:0',
        logicalActionId: 'run-1',
        attemptIndex: 0,
        agentId: 'org',
        signer: SIGNER,
        chainId: CHAIN,
        agentKind: 'keeperhub',
        trigger: { kind: 'api' },
        simulation: { performed: true, success: true },
        submission: { nonce: 7, submittedAt: T0, route: 'unknown' },
        outcome: { status: 'pending' },
        raw: {},
        ingestedAt: T0,
      },
    ]);

    // Registered so the tick evaluates this signer at all.
    await watchExecution(db, {
      executionId: 'kh-exec',
      agentId: 'org',
      signer: SIGNER,
      chainId: CHAIN,
      submitted: { nonce: 7 },
      at: T0,
    });
    const recorder = makeRecorder({
      fetch: async (id) => pendingExecution(id),
      corroboration: { gather: async () => ({ latestNonce: 6, pendingNonce: 8 }) },
      now: () => new Date(T0.getTime() + 200_000),
    });
    await recorder.tick();

    // No gap observation recorded at all, rather than one recorded as absent.
    expect(await db.select().from(signerState)).toHaveLength(0);
  });
});

describe('RecorderLoop', () => {
  const okResult = {
    polled: 0,
    settled: 0,
    eventsInserted: 0,
    signersEvaluated: 0,
    incidentsCreated: 0,
    incidentsUpdated: 0,
    incidentsResolved: 0,
    errors: 0,
  };

  /**
   * The loop is deliberately unbounded, so every test here stops it from
   * inside after a fixed number of ticks. `sleep` must also yield to the
   * macrotask queue: a sleep that only resolves a microtask starves everything
   * else and the loop spins hot.
   */
  const runBounded = async (
    tick: () => Promise<typeof okResult>,
    maxTicks: number,
    onError?: (d: unknown) => void,
  ) => {
    let ticks = 0;
    let reached: () => void;
    const done = new Promise<void>((resolve) => {
      reached = resolve;
    });

    const recorder = {
      tick: async () => {
        ticks += 1;
        try {
          return await tick();
        } finally {
          if (ticks >= maxTicks) reached();
        }
      },
    } as unknown as Recorder;

    const loop = new RecorderLoop({
      recorder,
      intervalMs: 0,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...(onError ? { logger: { info: () => {}, error: (_m, d) => onError(d) } } : {}),
    });
    loop.start();
    // Let the loop run on its own until it has ticked enough; stopping it
    // straight after start would only ever allow a single tick.
    await done;
    await loop.stop();
    return { ticks, loop };
  };

  it('ticks repeatedly until stopped, without overlapping', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const { ticks, loop } = await runBounded(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return okResult;
    }, 3);

    expect(ticks).toBe(3);
    // Overlapping ticks would evaluate one signer against two windows.
    expect(maxConcurrent).toBe(1);
    expect(loop.isRunning).toBe(false);
  });

  it('survives a tick that throws', async () => {
    const errors: unknown[] = [];
    const { ticks } = await runBounded(
      async () => {
        throw new Error('boom');
      },
      3,
      (d) => errors.push(d),
    );

    // A watchdog that dies on a transient error is worse than one running degraded.
    expect(ticks).toBe(3);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports ticks that completed with errors', async () => {
    const errors: unknown[] = [];
    await runBounded(async () => ({ ...okResult, errors: 2 }), 2, (d) => errors.push(d));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('is idempotent on start and awaits the in-flight tick on stop', async () => {
    let finished = false;
    let loop: RecorderLoop;
    const recorder = {
      tick: async () => {
        await new Promise((r) => setTimeout(r, 5));
        finished = true;
        void loop.stop();
        return okResult;
      },
    } as unknown as Recorder;

    loop = new RecorderLoop({
      recorder,
      intervalMs: 0,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    loop.start();
    loop.start(); // second start must be a no-op, not a second loop
    await loop.stop();
    expect(finished).toBe(true);
    expect(loop.isRunning).toBe(false);
  });
});
