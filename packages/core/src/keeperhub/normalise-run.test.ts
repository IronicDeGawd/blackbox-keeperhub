import { describe, expect, it } from 'vitest';
import { CHAIN_IDS } from '../chains.js';
import { executionEventSchema } from '../schemas.js';
import { normaliseRun } from './normalise-run.js';
import { keeperHubRunPageSchema, type KeeperHubRun } from './types.js';
import page from './fixtures/analytics-runs-page.json' with { type: 'json' };

const runs = keeperHubRunPageSchema.parse(page).runs;
const find = (source: string, status: string): KeeperHubRun => {
  const run = runs.find((r) => r.source === source && r.status === status);
  if (!run) throw new Error(`fixture has no ${source}/${status} run`);
  return run;
};

let counter = 0;
const options = {
  agentId: 'agent-1',
  signer: '0x01cC313321Eb09c51F5b649f2bBd578Ee32750A5' as const,
  now: new Date('2026-08-11T00:00:00.000Z'),
  makeId: () => `id-${++counter}`,
};

describe('normaliseRun', () => {
  it('records a workflow write with its verified receipt', () => {
    const [event, ...rest] = normaliseRun(find('workflow', 'success'), options);
    expect(rest).toHaveLength(0);
    expect(event?.chainId).toBe(CHAIN_IDS.sepolia);
    expect(event?.outcome).toMatchObject({ status: 'included', blockNumber: 11459949 });
    expect(event?.outcome.gasUsed).toBe(52728n);
    expect(event?.submission.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(event?.trigger.detail).toMatchObject({ runSource: 'workflow' });
  });

  // The failure that no chain scan can see: refused before it was ever sent.
  it('records a pre-flight failure as rejected, with a simulation that failed', () => {
    const run = find('workflow', 'error');
    expect(run.transactionHashes).toEqual([]);
    const [event] = normaliseRun(run, { ...options, fallbackChainId: CHAIN_IDS.sepolia });
    expect(event?.outcome.status).toBe('rejected');
    expect(event?.simulation).toMatchObject({ performed: true, success: false });
    expect(event?.simulation.revertReason).toContain('execution reverted');
    expect(event?.submission.txHash).toBeUndefined();
  });

  it('resolves a direct run addressed by network name', () => {
    const [event] = normaliseRun(find('direct', 'success'), options);
    // No receiptStatus on a direct run; the run's own verdict has to serve.
    expect(event?.chainId).toBe(CHAIN_IDS.sepolia);
    expect(event?.outcome.status).toBe('included');
  });

  it('gives a direct execution the same sourceId the status route would', () => {
    const run = find('direct', 'success');
    const [event] = normaliseRun(run, options);
    // `normaliseExecution` uses `${executionId}:${index}`, and a direct run's id
    // is its executionId — so ingesting both ways updates one row.
    expect(event?.sourceId).toBe(`${run.id}:0`);
    expect(event?.logicalActionId).toBe(run.id);
  });

  it('drops a run that names no network rather than guessing one', () => {
    const run = { ...find('workflow', 'error'), network: null, networks: [] };
    expect(normaliseRun(run, options)).toEqual([]);
    expect(normaliseRun(run, { ...options, fallbackChainId: CHAIN_IDS.sepolia })).toHaveLength(1);
  });

  // Not in the captured window, so built by hand from the documented shape.
  it('reads a reverted receipt, and treats an earlier attempt as replaced', () => {
    const run: KeeperHubRun = {
      ...find('workflow', 'success'),
      status: 'error',
      error: 'Contract call failed: Error(ERC20: transfer amount exceeds balance)',
      transactionHashes: [
        { hash: `0x${'a'.repeat(64)}`, chainId: CHAIN_IDS.sepolia, receiptStatus: 'success' },
        {
          hash: `0x${'b'.repeat(64)}`,
          chainId: CHAIN_IDS.sepolia,
          receiptStatus: 'reverted',
          blockNumber: 11459950,
        },
      ],
    };
    const events = normaliseRun(run, options);
    expect(events.map((e) => e.outcome.status)).toEqual(['replaced', 'reverted']);
    expect(events.map((e) => e.attemptIndex)).toEqual([0, 1]);
    // The reason belongs to the attempt that carried the outcome, not to both.
    expect(events[0]?.outcome.revertReason).toBeUndefined();
    expect(events[1]?.outcome.revertReason).toBe('ERC20: transfer amount exceeds balance');
    // A run with a transaction was submitted, so its pre-flight passed.
    expect(events[1]?.simulation).toMatchObject({ performed: true, success: true });
  });

  it('reports a run still in flight as pending', () => {
    const run: KeeperHubRun = {
      ...find('workflow', 'error'),
      status: 'running',
      completedAt: null,
      error: null,
      network: '11155111',
    };
    const [event] = normaliseRun(run, options);
    expect(event?.outcome.status).toBe('pending');
    expect(event?.outcome.observedAt).toBeUndefined();
  });

  it('files a multi-chain workflow run against each chain it wrote on', () => {
    const run: KeeperHubRun = {
      ...find('workflow', 'success'),
      network: '11155111',
      transactionHashes: [
        { hash: `0x${'c'.repeat(64)}`, chainId: CHAIN_IDS.sepolia, receiptStatus: 'success' },
        { hash: `0x${'d'.repeat(64)}`, chainId: CHAIN_IDS.baseSepolia, receiptStatus: 'success' },
      ],
    };
    expect(normaliseRun(run, options).map((e) => e.chainId)).toEqual([
      CHAIN_IDS.sepolia,
      CHAIN_IDS.baseSepolia,
    ]);
  });

  it('produces events the store will accept', () => {
    for (const run of runs) {
      for (const event of normaliseRun(run, { ...options, fallbackChainId: CHAIN_IDS.sepolia })) {
        expect(executionEventSchema.safeParse(event).success).toBe(true);
      }
    }
  });

  it('skips a write on a chain it cannot read receipts on', () => {
    const run: KeeperHubRun = {
      ...find('workflow', 'success'),
      network: null,
      networks: [],
      transactionHashes: [
        { hash: `0x${'e'.repeat(64)}`, network: 'solana', receiptStatus: 'success' },
      ],
    };
    expect(normaliseRun(run, options)).toEqual([]);
  });
});
