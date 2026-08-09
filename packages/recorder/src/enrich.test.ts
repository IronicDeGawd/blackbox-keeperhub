import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blackboxConfigSchema, type ExecutionEvent, type KeeperHubExecution } from '@blackbox/core';
import { IncidentTracker } from '@blackbox/detector';
import {
  createDb,
  executionEvents,
  incidents,
  listIncidents,
  signerState,
  watchedExecutions,
  type Database,
} from '@blackbox/store';
import { enrichEvents, type TransactionProvider } from './enrich.js';
import { InstrumentedKeeperHub } from './instrumented.js';
import { Recorder } from './recorder.js';

const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const SIGNER = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5' as `0x${string}`;
const T0 = new Date('2026-08-09T18:00:00.000Z');
const TX = `0x${'e'.repeat(64)}` as `0x${string}`;

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

const event = (over: Partial<ExecutionEvent['submission']> = {}): ExecutionEvent => ({
  id: 'evt-1',
  sourceId: 'evt-1',
  logicalActionId: 'action-1',
  attemptIndex: 0,
  agentId: 'chaos',
  signer: SIGNER,
  chainId: 11155111,
  trigger: { kind: 'api' },
  simulation: { performed: true, success: true },
  submission: { txHash: TX, submittedAt: T0, route: 'public', ...over },
  outcome: { status: 'pending' },
  raw: null,
  ingestedAt: T0,
});

const provider = (facts: Awaited<ReturnType<TransactionProvider['lookup']>>): TransactionProvider => ({
  lookup: async () => facts,
});

describe('enrichEvents', () => {
  it('fills submitted fees from the chain, which KeeperHub never reports', async () => {
    const [enriched] = await enrichEvents(
      [event()],
      provider({ nonce: 7, maxFeePerGas: 500_000_000n, maxPriorityFeePerGas: 1_000_000n, pending: true }),
    );
    expect(enriched!.submission.maxFeePerGas).toBe(500_000_000n);
    expect(enriched!.submission.maxPriorityFeePerGas).toBe(1_000_000n);
    expect(enriched!.submission.nonce).toBe(7);
  });

  it('does not overwrite values a wrapper already supplied', async () => {
    const [enriched] = await enrichEvents(
      [event({ maxFeePerGas: 111n, nonce: 1 })],
      provider({ nonce: 999, maxFeePerGas: 999n }),
    );
    // Submission-time data is more authoritative than a later chain read.
    expect(enriched!.submission.maxFeePerGas).toBe(111n);
    expect(enriched!.submission.nonce).toBe(1);
  });

  it('leaves the event untouched when the node has not seen the hash', async () => {
    const [enriched] = await enrichEvents([event()], provider(null));
    expect(enriched!.submission.maxFeePerGas).toBeUndefined();
  });

  it('skips events with no transaction hash', async () => {
    let calls = 0;
    const counting: TransactionProvider = {
      lookup: async () => {
        calls += 1;
        return null;
      },
    };
    const noHash = { ...event() };
    delete (noHash.submission as { txHash?: string }).txHash;
    await enrichEvents([noHash], counting);
    expect(calls).toBe(0);
  });
});

describe('R3 becomes detectable through enrichment', () => {
  it('detects an underpriced pending transaction with no wrapper involved', async () => {
    // This is the point of enrichment: a third-party agent that integrated
    // nothing still gets R3, because the fee comes from the chain.
    await db.insert(watchedExecutions).values({
      executionId: 'x1',
      agentId: 'third-party',
      signer: SIGNER,
      chainId: 11155111,
      registeredAt: T0,
    });

    const execution: KeeperHubExecution = {
      executionId: 'x1',
      status: 'running',
      transactionHash: TX,
      receipts: [],
      error: null,
      createdAt: T0.toISOString(),
      completedAt: null,
    };

    let n = 0;
    const recorder = new Recorder({
      db,
      keeperHub: { getExecutionStatus: async () => execution },
      corroboration: {
        gather: async () => ({ baseFeeAtDetection: 1_000_000_000n, latestNonce: 7, pendingNonce: 8 }),
      },
      transactions: provider({ nonce: 7, maxFeePerGas: 100_000_000n, pending: true }),
      config: blackboxConfigSchema.parse({
        keeperHub: { orgKey: 'kh_test' },
        databaseUrl: URL,
      }),
      tracker: new IncidentTracker({ makeId: () => `inc-${n++}` }),
      makeId: () => `evt-${n++}`,
      now: () => new Date(T0.getTime() + 200_000),
    });

    const result = await recorder.tick();
    expect(result.incidentsCreated).toBeGreaterThan(0);

    const stored = await listIncidents(db);
    const underpriced = stored.find((i) => i.class === 'GAS_UNDERPRICED');
    expect(underpriced).toBeDefined();
    const facts = (underpriced!.evidence as { facts: Record<string, unknown> }).facts;
    expect(facts['submittedMaxFee']).toBe('100000000');
    expect(facts['feeDeficitPct']).toBe(90);
  });

  it('records the event even when enrichment throws', async () => {
    await db.insert(watchedExecutions).values({
      executionId: 'x2',
      agentId: 'third-party',
      signer: SIGNER,
      chainId: 11155111,
      registeredAt: T0,
    });

    let n = 0;
    const recorder = new Recorder({
      db,
      keeperHub: {
        getExecutionStatus: async () => ({
          executionId: 'x2',
          status: 'running' as const,
          transactionHash: TX,
          receipts: [],
          error: null,
          createdAt: T0.toISOString(),
          completedAt: null,
        }),
      },
      corroboration: { gather: async () => ({}) },
      transactions: {
        lookup: async () => {
          throw new Error('RPC exploded');
        },
      },
      config: blackboxConfigSchema.parse({
        keeperHub: { orgKey: 'kh_test' },
        databaseUrl: URL,
      }),
      tracker: new IncidentTracker({ makeId: () => `inc-${n++}` }),
      makeId: () => `evt-${n++}`,
      now: () => T0,
      logger: { info: () => {}, error: () => {} },
    });

    // Better a record without fees than no record at all.
    expect((await recorder.tick()).eventsInserted).toBe(1);
  });
});

describe('InstrumentedKeeperHub', () => {
  const execution: KeeperHubExecution = {
    executionId: 'exec-1',
    status: 'completed',
    transactionHash: TX,
    receipts: [],
    error: null,
    createdAt: T0.toISOString(),
  };

  it('registers a transfer on the watchlist', async () => {
    const kh = new InstrumentedKeeperHub({
      db,
      client: { transfer: async () => execution, writeContract: async () => execution },
      agentId: 'chaos',
      signer: SIGNER,
      now: () => T0,
    });

    await kh.transfer({
      network: 'sepolia',
      chainId: 11155111,
      recipientAddress: SIGNER,
      amount: '0',
    });

    const [row] = await db.select().from(watchedExecutions);
    expect(row!.executionId).toBe('exec-1');
    expect(row!.settledAt).toBeNull();
    expect(row!.agentId).toBe('chaos');
  });

  it('records the route from the chain, not from the caller', async () => {
    const kh = new InstrumentedKeeperHub({
      db,
      client: { transfer: async () => execution, writeContract: async () => execution },
      agentId: 'chaos',
      signer: SIGNER,
      now: () => T0,
    });

    // Sepolia routes privately; Base Sepolia cannot.
    await kh.writeContract({
      network: 'sepolia',
      chainId: 11155111,
      contractAddress: SIGNER,
      functionName: 'x',
      functionArgs: '[]',
    });
    expect((await db.select().from(watchedExecutions))[0]!.submitted).toMatchObject({
      route: 'private',
    });

    await db.delete(watchedExecutions);
    await kh.writeContract({
      network: 'base-sepolia',
      chainId: 84532,
      contractAddress: SIGNER,
      functionName: 'x',
      functionArgs: '[]',
    });
    expect((await db.select().from(watchedExecutions))[0]!.submitted).toMatchObject({
      route: 'public',
    });
  });

  it('registering twice does not duplicate the watch', async () => {
    const kh = new InstrumentedKeeperHub({
      db,
      client: { transfer: async () => execution, writeContract: async () => execution },
      agentId: 'chaos',
      signer: SIGNER,
      now: () => T0,
    });
    const call = { network: 'sepolia', chainId: 11155111, recipientAddress: SIGNER, amount: '0' };
    await kh.transfer(call);
    await kh.transfer(call);
    expect(await db.select().from(watchedExecutions)).toHaveLength(1);
  });

  it('refuses a chain it does not know rather than watching it wrongly', async () => {
    const kh = new InstrumentedKeeperHub({
      db,
      client: { transfer: async () => execution, writeContract: async () => execution },
      agentId: 'chaos',
      signer: SIGNER,
    });
    await expect(
      kh.transfer({ network: 'arbitrum', chainId: 42161, recipientAddress: SIGNER, amount: '0' }),
    ).rejects.toThrow(/Unsupported chain/);
  });
});
