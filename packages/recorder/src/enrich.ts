import { createPublicClient, http, type PublicClient } from 'viem';
import type { ExecutionEvent } from '@blackbox/core';

/**
 * Submitted fee parameters, read from the chain rather than from KeeperHub.
 *
 * PRD §3.1 assumed a submission wrapper was the only way to learn what fee a
 * transaction actually bid, because the audit record carries only the final
 * `gasPriceWei`. It is not: `eth_getTransactionByHash` returns `maxFeePerGas`,
 * `maxPriorityFeePerGas` and `nonce` as soon as a transaction is in the pool,
 * before it is mined. That is precisely the state R1 and R3 care about — a
 * transaction still pending — so the data is available exactly when needed.
 *
 * This matters beyond convenience: it means third-party agents get full
 * R1/R3 detection without integrating anything, which is what makes Blackbox
 * infrastructure rather than a library.
 */
export type TransactionFacts = {
  nonce?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /** Null block number means still pending, which R1 corroborates against. */
  pending?: boolean;
};

export type TransactionProvider = {
  lookup(params: { txHash: `0x${string}`; chainId: number }): Promise<TransactionFacts | null>;
};

export class RpcTransactionProvider implements TransactionProvider {
  private readonly clients = new Map<number, PublicClient>();

  constructor(
    private readonly options: {
      rpcUrls: Record<number, string>;
      clientFactory?: (url: string) => PublicClient;
    },
  ) {}

  private client(chainId: number): PublicClient | undefined {
    const cached = this.clients.get(chainId);
    if (cached) return cached;
    const url = this.options.rpcUrls[chainId];
    if (!url) return undefined;
    const created = this.options.clientFactory
      ? this.options.clientFactory(url)
      : (createPublicClient({ transport: http(url) }) as PublicClient);
    this.clients.set(chainId, created);
    return created;
  }

  async lookup(params: {
    txHash: `0x${string}`;
    chainId: number;
  }): Promise<TransactionFacts | null> {
    const client = this.client(params.chainId);
    if (!client) return null;
    try {
      const tx = await client.getTransaction({ hash: params.txHash });
      return {
        nonce: tx.nonce,
        ...(tx.maxFeePerGas != null ? { maxFeePerGas: tx.maxFeePerGas } : {}),
        ...(tx.maxPriorityFeePerGas != null
          ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas }
          : {}),
        pending: tx.blockNumber === null,
      };
    } catch {
      // A hash the node has never seen is normal right after submission, and
      // is not worth an error: the next poll will find it.
      return null;
    }
  }
}

/**
 * Fill in submission fields the audit record does not carry.
 *
 * Only fields that are missing are filled. Anything a wrapper supplied at
 * submission time is more authoritative than a later chain read and is left
 * alone.
 */
export async function enrichEvents(
  events: readonly ExecutionEvent[],
  provider: TransactionProvider,
): Promise<ExecutionEvent[]> {
  return Promise.all(
    events.map(async (event) => {
      const { txHash } = event.submission;
      const needsFees = event.submission.maxFeePerGas === undefined;
      const needsNonce = event.submission.nonce === undefined;
      if (!txHash || (!needsFees && !needsNonce)) return event;

      const facts = await provider.lookup({ txHash, chainId: event.chainId });
      if (!facts) return event;

      return {
        ...event,
        submission: {
          ...event.submission,
          ...(needsNonce && facts.nonce !== undefined ? { nonce: facts.nonce } : {}),
          ...(needsFees && facts.maxFeePerGas !== undefined
            ? { maxFeePerGas: facts.maxFeePerGas }
            : {}),
          ...(needsFees && facts.maxPriorityFeePerGas !== undefined
            ? { maxPriorityFeePerGas: facts.maxPriorityFeePerGas }
            : {}),
        },
      };
    }),
  );
}
