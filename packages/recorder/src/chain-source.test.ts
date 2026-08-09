import { describe, expect, it } from 'vitest';
import { buildEventFromChain, type ChainReader } from './chain-source.js';

const TX = `0x${'f'.repeat(64)}` as `0x${string}`;
const SIGNER = '0xb9c58185d09d0acf3b237cd45c67345e32e628ba' as `0x${string}`;
const T0 = new Date('2026-08-10T10:00:00.000Z');

const params = {
  txHash: TX,
  agentId: 'chaos',
  signer: SIGNER,
  chainId: 11155111,
  label: 'C1',
  registeredAt: T0,
  now: new Date(T0.getTime() + 60_000),
  makeId: () => 'evt-1',
};

const reader = (
  tx: Awaited<ReturnType<ChainReader['getTransaction']>>,
  receipt: Awaited<ReturnType<ChainReader['getReceipt']>> = null,
): ChainReader => ({
  getTransaction: async () => tx,
  getReceipt: async () => receipt,
});

const pendingTx = {
  hash: TX,
  from: SIGNER,
  nonce: 5,
  maxFeePerGas: 100_000_000n,
  maxPriorityFeePerGas: 50_000_000n,
  blockNumber: null,
};

describe('building an event from a chain transaction', () => {
  it('records a pending transaction with its submitted fees', async () => {
    const { event, settled } = await buildEventFromChain(reader(pendingTx), params);
    expect(settled).toBe(false);
    expect(event!.outcome.status).toBe('pending');
    expect(event!.submission.maxFeePerGas).toBe(100_000_000n);
    expect(event!.submission.nonce).toBe(5);
    expect(event!.submission.route).toBe('public');
  });

  it('never claims a simulation happened', async () => {
    // Nothing pre-flighted this, so R4 must be unreachable for it: a revert
    // here is not evidence of state drift.
    const { event } = await buildEventFromChain(reader(pendingTx), params);
    expect(event!.simulation.performed).toBe(false);
    expect(event!.simulation.success).toBeUndefined();
  });

  it('uses a stable source id so re-observation dedupes', async () => {
    const a = await buildEventFromChain(reader(pendingTx), params);
    const b = await buildEventFromChain(reader(pendingTx), params);
    expect(a.event!.sourceId).toBe(b.event!.sourceId);
    expect(a.event!.sourceId).toContain(TX);
  });

  it('marks an included transaction settled, with gas and block', async () => {
    const { event, settled } = await buildEventFromChain(
      reader(
        { ...pendingTx, blockNumber: 11453700n },
        {
          status: 'success',
          blockNumber: 11453700n,
          gasUsed: 21_000n,
          effectiveGasPrice: 1_500_000_000n,
        },
      ),
      params,
    );
    expect(settled).toBe(true);
    expect(event!.outcome.status).toBe('included');
    expect(event!.outcome.blockNumber).toBe(11453700);
    expect(event!.outcome.gasUsed).toBe(21_000n);
    expect(event!.outcome.effectiveGasPrice).toBe(1_500_000_000n);
  });

  it('maps a reverted receipt to a reverted outcome', async () => {
    const { event } = await buildEventFromChain(
      reader(
        { ...pendingTx, blockNumber: 11453700n },
        {
          status: 'reverted',
          blockNumber: 11453700n,
          gasUsed: 21_000n,
          effectiveGasPrice: 1n,
        },
      ),
      params,
    );
    expect(event!.outcome.status).toBe('reverted');
  });

  it('treats a legacy gasPrice as the fee cap, so R3 can still compare', async () => {
    const legacy = {
      hash: TX,
      from: SIGNER,
      nonce: 5,
      gasPrice: 90_000_000n,
      blockNumber: null,
    };
    const { event } = await buildEventFromChain(reader(legacy), params);
    expect(event!.submission.maxFeePerGas).toBe(90_000_000n);
  });

  it('returns nothing when the node has not seen the hash yet', async () => {
    const { event, settled } = await buildEventFromChain(reader(null), params);
    expect(event).toBeNull();
    // Not settled: a hash the node has not caught up to is normal right after
    // submission, and the next poll decides.
    expect(settled).toBe(false);
  });

  it('keeps the raw chain data with bigints serialised for JSONB', async () => {
    const { event } = await buildEventFromChain(reader(pendingTx), params);
    const raw = event!.raw as { transaction: Record<string, unknown> };
    expect(raw.transaction['maxFeePerGas']).toBe('100000000');
    expect(() => JSON.stringify(event!.raw)).not.toThrow();
  });

  it('carries the scenario label through for the timeline', async () => {
    const { event } = await buildEventFromChain(reader(pendingTx), params);
    expect(event!.trigger.detail).toMatchObject({ source: 'chain', label: 'C1' });
  });
});
