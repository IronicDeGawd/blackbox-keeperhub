import { createWalletClient, http, type Account, type WalletClient } from 'viem';
import type { RemediationExecutor } from '../remediator.js';
import type { ReceiptVerifier } from './verify.js';

/**
 * Submits a plan as the incident's own signer, from a key Blackbox holds.
 *
 * This is the only way to perform a nonce-precise remediation. Replacing a
 * stuck transaction (P1) or filling a gap (P2) means occupying a specific nonce
 * of a specific account, which nothing but that account's key can do —
 * KeeperHub's sponsored relayer cannot, see `KeeperHubExecutor`.
 *
 * It refuses outright for a signer whose key it does not hold. There is no
 * degraded mode: submitting from some other account would produce a real
 * transaction that does not remediate anything.
 */
export class SignerExecutor implements RemediationExecutor {
  private readonly accounts = new Map<string, Account>();
  private readonly wallets = new Map<number, WalletClient>();

  constructor(
    accounts: readonly Account[],
    private readonly rpcUrls: Record<number, string>,
    private readonly verifier: ReceiptVerifier,
    private readonly walletFactory?: (chainId: number, account: Account) => WalletClient,
  ) {
    for (const account of accounts) this.accounts.set(account.address.toLowerCase(), account);
  }

  holdsKeyFor(signer: string): boolean {
    return this.accounts.has(signer.toLowerCase());
  }

  private wallet(chainId: number, account: Account): WalletClient {
    if (this.walletFactory) return this.walletFactory(chainId, account);
    const existing = this.wallets.get(chainId);
    if (existing) return existing;
    const url = this.rpcUrls[chainId];
    if (!url) throw new Error(`No RPC URL configured for chain ${chainId}`);
    const wallet = createWalletClient({ account, transport: http(url) });
    this.wallets.set(chainId, wallet);
    return wallet;
  }

  async submit(params: Parameters<RemediationExecutor['submit']>[0]): ReturnType<
    RemediationExecutor['submit']
  > {
    const { plan, incident } = params;
    const account = this.accounts.get(incident.signer.toLowerCase());
    if (!account) {
      throw new Error(
        `No key held for ${incident.signer}; a remediation at nonce ${plan.nonce ?? '(any)'} ` +
          `must be signed by that account and cannot be delegated`,
      );
    }

    const txHash = await this.wallet(incident.chainId, account).sendTransaction({
      account,
      chain: null,
      to: plan.to,
      value: plan.value,
      ...(plan.nonce !== undefined ? { nonce: plan.nonce } : {}),
      ...(plan.data ? { data: plan.data } : {}),
      maxFeePerGas: plan.maxFeePerGas,
      maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
    });
    return { txHash, executor: 'signer' };
  }

  async verify(params: Parameters<RemediationExecutor['verify']>[0]): ReturnType<
    RemediationExecutor['verify']
  > {
    return this.verifier.waitForReceipt({
      txHash: params.txHash,
      chainId: params.incident.chainId,
      timeoutMs: params.timeoutMs,
    });
  }
}
