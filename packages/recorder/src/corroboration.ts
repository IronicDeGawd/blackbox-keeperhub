import { createPublicClient, http, type PublicClient } from 'viem';
import type { Corroboration } from '@blackbox/detector';

/**
 * RPC facts the rules cannot fetch for themselves. Rules are pure functions, so
 * every chain read happens here, once per evaluation, and is handed in.
 */
export type CorroborationProvider = {
  gather(params: { signer: `0x${string}`; chainId: number }): Promise<Corroboration>;
};

export type RpcCorroboratorOptions = {
  /** chainId → RPC url. A chain without a url simply yields no corroboration. */
  rpcUrls: Record<number, string>;
  clientFactory?: (url: string) => PublicClient;
};

/**
 * Missing corroboration is not an error. Several rules degrade to lower
 * confidence without it (R1) or decline to fire at all (R2, R3, R6), which is
 * the correct behaviour: a rule that cannot see the chain should not guess, and
 * an RPC outage must not take the recorder down or manufacture incidents.
 */
export class RpcCorroborator implements CorroborationProvider {
  private readonly clients = new Map<number, PublicClient>();

  constructor(private readonly options: RpcCorroboratorOptions) {}

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

  async gather(params: { signer: `0x${string}`; chainId: number }): Promise<Corroboration> {
    const client = this.client(params.chainId);
    if (!client) return {};

    const [latest, pending, balance, block] = await Promise.allSettled([
      client.getTransactionCount({ address: params.signer, blockTag: 'latest' }),
      client.getTransactionCount({ address: params.signer, blockTag: 'pending' }),
      client.getBalance({ address: params.signer }),
      client.getBlock({ blockTag: 'latest' }),
    ]);

    const out: Corroboration = {};
    if (latest.status === 'fulfilled') out.latestNonce = latest.value;
    if (pending.status === 'fulfilled') out.pendingNonce = pending.value;
    if (balance.status === 'fulfilled') out.signerBalance = balance.value;
    if (block.status === 'fulfilled' && block.value.baseFeePerGas != null) {
      out.baseFeeAtDetection = block.value.baseFeePerGas;
    }
    if (out.latestNonce !== undefined && out.pendingNonce !== undefined) {
      out.missingNonces = range(out.latestNonce, out.pendingNonce);
    }
    return out;
  }
}

/** Nonces submitted but not yet confirmed: [latest, pending). */
function range(latest: number, pending: number): number[] {
  const out: number[] = [];
  for (let n = latest; n < pending; n++) out.push(n);
  return out;
}
