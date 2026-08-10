import { describe, expect, it, vi } from 'vitest';
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

describe('zero-integration evidence', () => {
  const CONTRACT = '0x5d3437a8b5c182b91dc72087f4049ac00b1c528a' as `0x${string}`;
  const revertedTx = {
    hash: TX,
    from: SIGNER,
    to: CONTRACT,
    input: '0x9fb37853abcdef' as `0x${string}`,
    nonce: 5,
    maxFeePerGas: 100_000_000n,
    maxPriorityFeePerGas: 50_000_000n,
    blockNumber: 100n,
  };
  const revertedReceipt = {
    status: 'reverted' as const,
    blockNumber: 100n,
    gasUsed: 21_000n,
    effectiveGasPrice: 90_000_000n,
  };

  const withCall = (
    tx: Awaited<ReturnType<ChainReader['getTransaction']>>,
    receipt: Awaited<ReturnType<ChainReader['getReceipt']>>,
    call: ChainReader['call'],
  ): ChainReader => ({ getTransaction: async () => tx, getReceipt: async () => receipt, call });

  it('establishes state drift by replaying the call against the parent block', async () => {
    // The whole point: R4 becomes reachable for an agent that integrated
    // nothing, because Blackbox measures the simulation itself after the fact.
    const call = vi.fn(async () => ({ success: true }));
    const { event } = await buildEventFromChain(
      withCall(revertedTx, revertedReceipt, call),
      params,
    );

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 99n, to: CONTRACT, from: SIGNER }),
    );
    expect(event!.simulation).toMatchObject({
      performed: true,
      success: true,
      simulatedAtBlock: 99,
    });
  });

  it('records a replay that also reverted, so R4 cannot fire on a doomed call', async () => {
    const call = vi.fn(async () => ({ success: false, revertReason: 'AlwaysReverts()' }));
    const { event } = await buildEventFromChain(
      withCall(revertedTx, revertedReceipt, call),
      params,
    );
    expect(event!.simulation).toMatchObject({ performed: true, success: false });
  });

  it('does not replay a transaction that succeeded', async () => {
    const call = vi.fn(async () => ({ success: true }));
    await buildEventFromChain(
      withCall(revertedTx, { ...revertedReceipt, status: 'success' }, call),
      params,
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('does not replay when the submitter already recorded a simulation', async () => {
    const call = vi.fn(async () => ({ success: true }));
    await buildEventFromChain(withCall(revertedTx, revertedReceipt, call), {
      ...params,
      simulation: { performed: true, success: true, simulatedAtBlock: 42 },
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('reports no simulation when the node cannot answer for an old block', async () => {
    // An archive-less node is a normal deployment. Not knowing is a valid
    // outcome; inventing a result is not.
    const call = vi.fn(async () => {
      throw new Error('missing trie node');
    });
    const { event } = await buildEventFromChain(
      withCall(revertedTx, revertedReceipt, call),
      params,
    );
    expect(event!.simulation).toEqual({ performed: false });
  });

  it('groups attempts at the same function on the same contract', async () => {
    const first = await buildEventFromChain(reader(revertedTx, revertedReceipt), params);
    const second = await buildEventFromChain(
      reader({ ...revertedTx, hash: `0x${'e'.repeat(64)}`, nonce: 6 }, revertedReceipt),
      { ...params, txHash: `0x${'e'.repeat(64)}` },
    );
    expect(first.event!.logicalActionId).toBe(second.event!.logicalActionId);
    expect(first.event!.logicalActionId).toContain(CONTRACT);
    expect(first.event!.logicalActionId).toContain('0x9fb37853');
  });

  it('keeps different functions on one contract apart', async () => {
    const a = await buildEventFromChain(reader(revertedTx, revertedReceipt), params);
    const b = await buildEventFromChain(
      reader({ ...revertedTx, input: '0x27eab502' }, revertedReceipt),
      params,
    );
    expect(a.event!.logicalActionId).not.toBe(b.event!.logicalActionId);
  });

  it('lets an explicit logical action id win over the inferred one', async () => {
    const { event } = await buildEventFromChain(reader(revertedTx, revertedReceipt), {
      ...params,
      logicalActionId: 'agent:batch-7',
    });
    expect(event!.logicalActionId).toBe('agent:batch-7');
  });

  it('falls back to the hash alone for a contract creation, which groups with nothing', async () => {
    const { event } = await buildEventFromChain(
      reader({ ...revertedTx, to: null }, revertedReceipt),
      params,
    );
    expect(event!.logicalActionId).toBe(`chain:11155111:${TX}`);
  });
});
