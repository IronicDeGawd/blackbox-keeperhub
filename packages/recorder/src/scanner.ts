import {
  activeSigners,
  getCursor,
  setCursor,
  watchTransaction,
  type Database,
} from '@blackbox/store';

/**
 * Finds the transactions of watched addresses by walking blocks.
 *
 * Everything else in the recorder observes transactions it was *told* about,
 * which is fine for an agent that integrates Blackbox and useless for one that
 * has not. This closes that gap: register an address and its transactions are
 * discovered, with no SDK, no wrapper and no cooperation from the agent.
 *
 * Deliberately block scanning rather than an indexer API. It needs nothing but
 * a standard JSON-RPC endpoint — no Etherscan key, no provider-specific
 * `getAssetTransfers` — so it works against any chain and any node, including a
 * local fork. The cost is one `eth_getBlockByNumber` per block, which at
 * twelve-second blocks is nothing.
 *
 * Both `from` and `to` are matched: an agent's incidents are usually about what
 * it sent, but a watched *contract* is interesting for what arrives at it.
 */

export type BlockTransaction = {
  hash: `0x${string}`;
  from: `0x${string}`;
  to?: `0x${string}` | null;
};

export type BlockReader = {
  getBlockNumber(chainId: number): Promise<bigint>;
  getBlockWithTransactions(
    chainId: number,
    blockNumber: bigint,
  ): Promise<{ transactions: BlockTransaction[] } | null>;
};

export type ScannerOptions = {
  db: Database;
  reader: BlockReader;
  chainId: number;
  /**
   * How far behind head to stay. Reorgs happen, and a transaction observed in
   * a block that is later dropped would become an incident about nothing.
   */
  confirmations?: number;
  /** Cap per tick, so a cold start cannot try to read a year of blocks. */
  maxBlocksPerTick?: number;
  now?: () => Date;
  logger?: { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
};

export type ScanResult = {
  fromBlock: number | null;
  toBlock: number | null;
  blocksScanned: number;
  matched: number;
  watching: number;
  errors: number;
};

const CURSOR_PREFIX = 'blockscan';

export class BlockScanner {
  private readonly confirmations: number;
  private readonly maxBlocksPerTick: number;
  private readonly now: () => Date;

  constructor(private readonly options: ScannerOptions) {
    this.confirmations = options.confirmations ?? 2;
    this.maxBlocksPerTick = options.maxBlocksPerTick ?? 50;
    this.now = options.now ?? (() => new Date());
  }

  private get cursorKey(): string {
    return `${CURSOR_PREFIX}:${this.options.chainId}`;
  }

  /**
   * Scan the blocks that have appeared since the last tick.
   *
   * Nothing here throws. A scanner that dies on one unreadable block stops
   * discovering anything at all, which is a worse failure than missing a block
   * and saying so.
   */
  async tick(): Promise<ScanResult> {
    const { db, reader, chainId } = this.options;
    const empty: ScanResult = {
      fromBlock: null,
      toBlock: null,
      blocksScanned: 0,
      matched: 0,
      watching: 0,
      errors: 0,
    };

    const signers = await activeSigners(db, chainId);
    if (signers.length === 0) return empty;

    const watched = new Map(signers.map((s) => [s.signer.toLowerCase(), s]));
    empty.watching = watched.size;

    let head: bigint;
    try {
      head = await reader.getBlockNumber(chainId);
    } catch (error) {
      this.options.logger?.error('scanner could not read head', { chainId, error });
      return { ...empty, errors: 1 };
    }

    const safeHead = head - BigInt(this.confirmations);
    if (safeHead < 0n) return empty;

    const cursor = await getCursor(db, this.cursorKey);
    // A first run starts at the safe head rather than at genesis: Blackbox
    // watches from the moment it is asked to, and backfilling an unbounded
    // history is a different feature with different costs.
    const start = cursor === null ? safeHead : BigInt(cursor) + 1n;
    if (start > safeHead) return { ...empty, watching: watched.size };

    const end =
      safeHead - start >= BigInt(this.maxBlocksPerTick)
        ? start + BigInt(this.maxBlocksPerTick) - 1n
        : safeHead;

    let matched = 0;
    let errors = 0;
    let lastScanned: bigint | null = null;

    for (let n = start; n <= end; n++) {
      try {
        const block = await reader.getBlockWithTransactions(chainId, n);
        if (!block) {
          errors += 1;
          break;
        }
        for (const tx of block.transactions) {
          const owner =
            watched.get(tx.from?.toLowerCase() ?? '') ??
            (tx.to ? watched.get(tx.to.toLowerCase()) : undefined);
          if (!owner) continue;

          await watchTransaction(db, {
            txHash: tx.hash,
            agentId: owner.agentId,
            // Attributed to the watched address, which is whose nonce and
            // balance the rules reason about — not necessarily tx.from.
            signer: owner.signer,
            chainId,
            label: 'discovered',
            at: this.now(),
          });
          matched += 1;
        }
        lastScanned = n;
      } catch (error) {
        errors += 1;
        this.options.logger?.error('scanner could not read block', { chainId, block: n, error });
        // Stop at the first unreadable block rather than skipping it: the
        // cursor must never advance past something that was not examined.
        break;
      }
    }

    if (lastScanned !== null) await setCursor(db, this.cursorKey, lastScanned.toString());

    return {
      fromBlock: Number(start),
      toBlock: lastScanned === null ? null : Number(lastScanned),
      blocksScanned: lastScanned === null ? 0 : Number(lastScanned - start) + 1,
      matched,
      watching: watched.size,
      errors,
    };
  }
}
