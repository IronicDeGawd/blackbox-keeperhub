import type { ExecutionEvent } from '@blackbox/core';

/**
 * Builds an `ExecutionEvent` from a transaction observed directly on chain.
 *
 * Some real transactions have no KeeperHub execution record — the chaos harness
 * submits deliberately underpriced and nonce-gapped transactions, which
 * KeeperHub will not do because it chooses fees and manages nonces itself. They
 * are still genuine transactions with genuine hashes, and the rules should see
 * them.
 *
 * `simulation.performed` is false unless the submitter recorded a simulation
 * when it registered the transaction, and that default is meaningful rather
 * than a gap: R4 requires a simulation that passed, and a transaction nobody
 * pre-flighted cannot be evidence of state drift. A submitter that did simulate
 * — the chaos harness does — passes the real result through, so R4 stays
 * reachable for agents that never touch KeeperHub.
 */

export type ChainTransaction = {
  hash: `0x${string}`;
  from: `0x${string}`;
  /** Null for a contract creation. */
  to?: `0x${string}` | null;
  /** Calldata; its first four bytes identify the function being called. */
  input?: `0x${string}`;
  nonce: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  blockNumber: bigint | null;
};

export type ChainReceipt = {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
};

export type ChainReader = {
  getTransaction(params: {
    hash: `0x${string}`;
    chainId: number;
  }): Promise<ChainTransaction | null>;
  getReceipt(params: { hash: `0x${string}`; chainId: number }): Promise<ChainReceipt | null>;
  /**
   * Replay a call against a historical block.
   *
   * Optional, and only used to establish state drift after the fact: a
   * transaction that reverted on chain is re-run against the block *before* it
   * was mined. If it would have succeeded there, the state changed underneath
   * it — which is R4, measured by Blackbox rather than asserted by whoever
   * submitted it. That is what lets R4 fire for an agent that has integrated
   * nothing at all.
   */
  call?(params: {
    chainId: number;
    from: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
    blockNumber: bigint;
  }): Promise<{ success: boolean; revertReason?: string }>;
};

/**
 * Group retries of one action when nobody told us how.
 *
 * A submitter that knows two transactions were attempts at the same thing
 * should say so. Absent that, the honest approximation from chain data alone is
 * the same signer calling the same function on the same contract: identical
 * target and identical four-byte selector. It can over-group — two legitimately
 * different calls to `transfer` look alike — which is why R5 also requires the
 * attempts to have *failed* and to fall inside a short window.
 */
export function inferLogicalActionId(
  chainId: number,
  signer: string,
  tx: Pick<ChainTransaction, 'to' | 'input' | 'hash'>,
): string {
  if (!tx.to) return `chain:${chainId}:${tx.hash}`;
  const selector = tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10) : '0x';
  return `chain:${chainId}:${signer.toLowerCase()}:${tx.to.toLowerCase()}:${selector}`;
}

export type BuildParams = {
  txHash: `0x${string}`;
  agentId: string;
  signer: `0x${string}`;
  chainId: number;
  label?: string | null;
  /** What the submitter simulated before broadcasting, if anything. */
  simulation?: ExecutionEvent['simulation'] | null;
  /** Shared across retries of one action; defaults to this transaction alone. */
  logicalActionId?: string | null;
  registeredAt: Date;
  now: Date;
  makeId: () => string;
};

export type BuiltTransaction = {
  event: ExecutionEvent | null;
  /** True once the transaction has a receipt; stops further polling. */
  settled: boolean;
};

export async function buildEventFromChain(
  reader: ChainReader,
  params: BuildParams,
): Promise<BuiltTransaction> {
  const tx = await reader.getTransaction({ hash: params.txHash, chainId: params.chainId });
  if (!tx) {
    // Submitted but not yet visible to this node, or dropped. Either way there
    // is nothing to record and the next poll will decide.
    return { event: null, settled: false };
  }

  const receipt =
    tx.blockNumber === null
      ? null
      : await reader.getReceipt({ hash: params.txHash, chainId: params.chainId });

  // Only worth doing for a transaction that actually reverted, and only when
  // the submitter recorded nothing — a replay is an extra RPC round trip.
  const replayed =
    params.simulation || !receipt || receipt.status !== 'reverted'
      ? null
      : await replayAtParentBlock(reader, tx, receipt, params);

  const event: ExecutionEvent = {
    id: params.makeId(),
    // Stable across polls, so re-observing the same transaction dedupes.
    sourceId: `chain:${params.chainId}:${params.txHash}`,
    logicalActionId:
      params.logicalActionId ?? inferLogicalActionId(params.chainId, params.signer, tx),
    attemptIndex: 0,
    agentId: params.agentId,
    signer: params.signer,
    chainId: params.chainId,
    trigger: {
      kind: 'manual',
      detail: { source: 'chain', ...(params.label ? { label: params.label } : {}) },
    },
    // Either what the submitter recorded, or what we established ourselves by
    // replaying the call against the parent block. Never an assumption.
    simulation: params.simulation ?? replayed ?? { performed: false },
    submission: {
      txHash: tx.hash,
      nonce: tx.nonce,
      ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: tx.maxFeePerGas } : {}),
      ...(tx.maxPriorityFeePerGas !== undefined
        ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas }
        : {}),
      // A legacy transaction has one gasPrice and no cap; treat it as the cap
      // so R3 can still compare a bid against the base fee.
      ...(tx.maxFeePerGas === undefined && tx.gasPrice !== undefined
        ? { maxFeePerGas: tx.gasPrice }
        : {}),
      submittedAt: params.registeredAt,
      route: 'public',
    },
    outcome: receipt
      ? {
          status: receipt.status === 'success' ? 'included' : 'reverted',
          blockNumber: Number(receipt.blockNumber),
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          observedAt: params.now,
        }
      : { status: 'pending' },
    raw: { source: 'chain', transaction: serialise(tx), receipt: receipt ? serialise(receipt) : null },
    ingestedAt: params.now,
  };

  return { event, settled: receipt !== null };
}

/** Bigints do not survive JSON, and `raw` is stored as JSONB. */
function serialise(value: object): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as unknown;
}

/**
 * Re-run a reverted call against the block before it was mined.
 *
 * A success here means the transaction was valid when it was built and the
 * chain moved underneath it: genuine state drift. A revert here means the call
 * was already doomed when it was sent, which is a different and less
 * interesting failure — so `success: false` is recorded just as deliberately,
 * because it is what stops R4 firing on a call that never could have worked.
 */
async function replayAtParentBlock(
  reader: ChainReader,
  tx: ChainTransaction,
  receipt: ChainReceipt,
  params: BuildParams,
): Promise<ExecutionEvent['simulation'] | null> {
  if (!reader.call || !tx.to || !tx.input || receipt.blockNumber === 0n) return null;

  const parentBlock = receipt.blockNumber - 1n;
  try {
    const result = await reader.call({
      chainId: params.chainId,
      from: tx.from,
      to: tx.to,
      data: tx.input,
      blockNumber: parentBlock,
    });
    return {
      performed: true,
      success: result.success,
      simulatedAtBlock: Number(parentBlock),
      ...(result.revertReason ? { revertReason: result.revertReason } : {}),
    };
  } catch {
    // An archive-less node cannot answer for an old block. Not knowing is a
    // valid outcome; inventing a simulation result is not.
    return null;
  }
}
