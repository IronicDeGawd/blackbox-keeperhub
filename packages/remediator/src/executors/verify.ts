import { createPublicClient, http, type PublicClient } from 'viem';

/**
 * Confirmation by receipt, from a node — never from the thing that submitted.
 *
 * KeeperHub answers a transfer with `status: "completed"` and a hash before the
 * transaction is in a block, so trusting its word would let an unincluded
 * transaction be reported as a successful remediation. The only acceptable
 * proof is a receipt fetched from a chain RPC.
 */
export class ReceiptVerifier {
  private readonly clients = new Map<number, PublicClient>();

  constructor(
    private readonly rpcUrls: Record<number, string>,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    private readonly pollIntervalMs = 3_000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  client(chainId: number): PublicClient {
    const existing = this.clients.get(chainId);
    if (existing) return existing;
    const url = this.rpcUrls[chainId];
    if (!url) throw new Error(`No RPC URL configured for chain ${chainId}, so nothing can be verified`);
    const client = createPublicClient({ transport: http(url) }) as PublicClient;
    this.clients.set(chainId, client);
    return client;
  }

  async waitForReceipt(params: {
    txHash: `0x${string}`;
    chainId: number;
    timeoutMs: number;
  }): Promise<{ included: boolean; gasUsed?: bigint }> {
    const deadline = this.clock() + params.timeoutMs;
    const client = this.client(params.chainId);
    for (;;) {
      try {
        const receipt = await client.getTransactionReceipt({ hash: params.txHash });
        if (receipt) {
          // A reverted receipt is still an unsuccessful remediation. Included
          // is not the same as worked, and the caller is told which.
          return { included: receipt.status === 'success', gasUsed: receipt.gasUsed };
        }
      } catch {
        // Not mined yet; viem throws rather than returning null.
      }
      if (this.clock() >= deadline) return { included: false };
      await this.sleep(this.pollIntervalMs);
    }
  }
}
