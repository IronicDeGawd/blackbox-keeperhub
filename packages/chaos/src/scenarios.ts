import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { assertChaosAllowed, getChain } from '@blackbox/core';
import { watchTransaction, type Database } from '@blackbox/store';

/**
 * Chaos scenarios induce real failures against real chains.
 *
 * Every scenario is hard-restricted to testnets by `assertChaosAllowed`, which
 * reads a compiled-in list with no config key and no override flag (PRD §8).
 * The guard runs before any client is constructed, so a mainnet chain id cannot
 * reach a signing path even by mistake.
 *
 * These submit raw transactions rather than going through KeeperHub, because
 * the whole point is to do things KeeperHub correctly refuses to do: bid below
 * the base fee, and leave a hole in the nonce sequence. The resulting hashes are
 * registered for observation so the recorder picks them up.
 */

export type ScenarioId = 'C1' | 'C2';

export type ChaosOptions = {
  db: Database;
  account: Account;
  chainId: number;
  rpcUrl: string;
  agentId?: string;
  now?: () => Date;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
};

export type ScenarioResult = {
  scenario: ScenarioId;
  txHashes: `0x${string}`[];
  detail: Record<string, unknown>;
};

export class ChaosHarness {
  private readonly agentId: string;
  private readonly now: () => Date;

  constructor(private readonly options: ChaosOptions) {
    // Before anything else. A mainnet id must not get as far as a client.
    assertChaosAllowed(options.chainId);
    this.agentId = options.agentId ?? 'chaos';
    this.now = options.now ?? (() => new Date());
  }

  private get pub(): PublicClient {
    return (
      this.options.publicClient ??
      (createPublicClient({ transport: http(this.options.rpcUrl) }) as PublicClient)
    );
  }

  private get wallet(): WalletClient {
    return (
      this.options.walletClient ??
      createWalletClient({
        account: this.options.account,
        transport: http(this.options.rpcUrl),
      })
    );
  }

  /**
   * C1 — marginal bid that the market outruns.
   *
   * The original design bid a tenth of the base fee. That cannot work: nodes
   * reject a transaction whose `maxFeePerGas` is below the current base fee
   * outright, at estimate time, with `-32000 max fee per gas less than block
   * base fee`. It never enters the pool, so there is nothing to detect. Trying
   * to induce underpricing by bidding low is not possible from outside.
   *
   * What actually happens in production is subtler and is what this reproduces:
   * a transaction is priced correctly *at submission* and the market moves up
   * underneath it. Bidding exactly the current base fee with no priority fee
   * gives a transaction that is accepted — the bid is not below base — but has
   * no inclusion incentive and falls below the market as soon as the base fee
   * ticks up. R3 compares against the base fee at *detection* precisely
   * because of this, so it fires once the market has moved, and R1 follows once
   * the transaction has sat long enough, with R3 suppressing it as the more
   * specific explanation.
   *
   * This is less deterministic than a nonce gap, since Sepolia may include a
   * zero-tip transaction on a quiet block. C2 is the reliable way to produce a
   * durable pending transaction; C1 is the faithful way to produce a genuinely
   * underpriced one.
   */
  async c1UnderpricedStuck(): Promise<ScenarioResult> {
    assertChaosAllowed(this.options.chainId);
    const block = await this.pub.getBlock({ blockTag: 'latest' });
    const baseFee = block.baseFeePerGas ?? 1_000_000_000n;

    // Exactly the base fee: the lowest bid a node will accept. No tip, so
    // there is no reason to include it ahead of anything else.
    const maxFeePerGas = baseFee;
    const maxPriorityFeePerGas = 0n;

    const hash = await this.wallet.sendTransaction({
      account: this.options.account,
      chain: null,
      to: this.options.account.address,
      value: 0n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    await this.register(hash, 'C1');
    return {
      scenario: 'C1',
      txHashes: [hash],
      detail: {
        baseFee: baseFee.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        note: 'bid equals base fee at submission; R3 fires once the market moves above it',
      },
    };
  }

  /**
   * C2 — nonce gap.
   *
   * Submits at `latestNonce + 1`, leaving `latestNonce` unused, so the
   * transaction sits in the pool unable to execute and wedges everything
   * behind it. That is R2, and it needs the gap to persist across several
   * polls before firing.
   *
   * The gap transaction is priced normally: the point is the hole in the
   * sequence, not the fee. Pricing it low as well would make R3 fire and
   * confuse which rule the scenario is demonstrating.
   */
  async c2NonceGap(): Promise<ScenarioResult> {
    assertChaosAllowed(this.options.chainId);
    const address = this.options.account.address;
    const latest = await this.pub.getTransactionCount({ address, blockTag: 'latest' });
    const pending = await this.pub.getTransactionCount({ address, blockTag: 'pending' });
    if (pending !== latest) {
      throw new Error(
        `C2 needs a clean nonce sequence: latest=${latest} pending=${pending}. ` +
          'Let the signer settle before inducing a gap.',
      );
    }

    const block = await this.pub.getBlock({ blockTag: 'latest' });
    const baseFee = block.baseFeePerGas ?? 1_000_000_000n;

    const gapNonce = latest;
    const hash = await this.wallet.sendTransaction({
      account: this.options.account,
      chain: null,
      to: address,
      value: 0n,
      nonce: latest + 1,
      maxFeePerGas: baseFee * 2n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });

    await this.register(hash, 'C2');
    return {
      scenario: 'C2',
      txHashes: [hash],
      detail: { latestNonce: latest, submittedNonce: latest + 1, missingNonce: gapNonce },
    };
  }

  /** Fill the hole C2 made, so the signer is usable again. */
  async healNonceGap(): Promise<`0x${string}`> {
    assertChaosAllowed(this.options.chainId);
    const address = this.options.account.address;
    const latest = await this.pub.getTransactionCount({ address, blockTag: 'latest' });
    const block = await this.pub.getBlock({ blockTag: 'latest' });
    const baseFee = block.baseFeePerGas ?? 1_000_000_000n;

    const hash = await this.wallet.sendTransaction({
      account: this.options.account,
      chain: null,
      to: address,
      value: 0n,
      nonce: latest,
      // Priced to be included promptly; a slow heal leaves the signer wedged.
      maxFeePerGas: baseFee * 3n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
    await this.register(hash, 'heal');
    return hash;
  }

  private async register(txHash: `0x${string}`, label: string): Promise<void> {
    await watchTransaction(this.options.db, {
      txHash,
      agentId: this.agentId,
      signer: this.options.account.address,
      chainId: this.options.chainId,
      label,
      at: this.now(),
    });
  }

  /** Human-readable name of the chain this harness is pointed at. */
  get chainName(): string {
    return getChain(this.options.chainId).name;
  }
}
