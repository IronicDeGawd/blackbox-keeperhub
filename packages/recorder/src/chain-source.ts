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
};

export type BuildParams = {
  txHash: `0x${string}`;
  agentId: string;
  signer: `0x${string}`;
  chainId: number;
  label?: string | null;
  /** What the submitter simulated before broadcasting, if anything. */
  simulation?: ExecutionEvent['simulation'] | null;
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

  const event: ExecutionEvent = {
    id: params.makeId(),
    // Stable across polls, so re-observing the same transaction dedupes.
    sourceId: `chain:${params.chainId}:${params.txHash}`,
    logicalActionId: `chain:${params.chainId}:${params.txHash}`,
    attemptIndex: 0,
    agentId: params.agentId,
    signer: params.signer,
    chainId: params.chainId,
    trigger: {
      kind: 'manual',
      detail: { source: 'chain', ...(params.label ? { label: params.label } : {}) },
    },
    // Only what the submitter actually recorded. Absent it, nothing simulated
    // this transaction, and claiming otherwise would make R4 reachable on
    // evidence that does not exist.
    simulation: params.simulation ?? { performed: false },
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
