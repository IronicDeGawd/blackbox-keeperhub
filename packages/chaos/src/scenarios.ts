import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assertChaosAllowed, getChain } from '@blackbox/core';
import { watchSigner, watchTransaction, type Database } from '@blackbox/store';

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

export type ScenarioId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5';

/**
 * Calldata for ChaosTarget, written out rather than encoded from an ABI.
 *
 * All four take no arguments, so the selector is the entire calldata and an ABI
 * would add a dependency for nothing. Kept next to the scenarios that use them
 * so a rename in the contract shows up here.
 */
export const SELECTORS = {
  armTrap: '0x27eab502',
  disarm: '0x83985082',
  work: '0x322e9f04',
  alwaysRevert: '0x9fb37853',
} as const satisfies Record<string, `0x${string}`>;

export type ChaosOptions = {
  db: Database;
  account: Account;
  chainId: number;
  rpcUrl: string;
  agentId?: string;
  now?: () => Date;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
  /** Deployed ChaosTarget. Required by C3 and C4. */
  chaosTarget?: `0x${string}`;
  /** Where C5 sweeps the signer's balance to. */
  sweepTo?: `0x${string}`;
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

  private get target(): `0x${string}` {
    const target = this.options.chaosTarget;
    if (!target) {
      throw new Error(
        'This scenario needs a deployed ChaosTarget. Set CHAOS_TARGET_ADDRESS and pass it as ' +
          '`chaosTarget`; there is no way to induce a contract-level failure without one.',
      );
    }
    return target;
  }

  /**
   * C3 — simulation passes, execution reverts.
   *
   * Two transactions, and the order is the whole scenario. The first arms a
   * trap on the target; the second calls `work()`. The node simulates `work()`
   * against the block the trap was armed in, where it still succeeds, and by
   * the time the transaction is mined a block has passed and the same call
   * reverts.
   *
   * This is the honest reproduction of R4: nothing about the call changed,
   * only the chain state underneath it. Faking it by calling a function that
   * always reverts would produce a failure the simulator would have caught,
   * which is a different — and far less interesting — bug.
   */
  async c3SimPassExecRevert(): Promise<ScenarioResult> {
    assertChaosAllowed(this.options.chainId);
    const target = this.target;

    const armHash = await this.wallet.sendTransaction({
      account: this.options.account,
      chain: null,
      to: target,
      value: 0n,
      data: SELECTORS.armTrap,
    });
    // The trap must be *mined* before work() is submitted. Arming and calling
    // in the same block leaves work() succeeding, since the trap deliberately
    // does not spring in the block it was armed in.
    const armReceipt = await this.pub.waitForTransactionReceipt({ hash: armHash });

    // Simulate exactly as a submitter would, at the block the trap was armed
    // in, where it still passes. This result is *measured*, not assumed — and
    // recording it is what lets R4 fire on a transaction that never went
    // through KeeperHub. Without it, "simulation passed, execution reverted"
    // is only detectable inside KeeperHub's own audit trail.
    const simulatedAtBlock = Number(armReceipt.blockNumber);
    let simulation: {
      performed: boolean;
      success: boolean;
      simulatedAtBlock: number;
      revertReason?: string;
    };
    try {
      await this.pub.call({
        account: this.options.account.address,
        to: target,
        data: SELECTORS.work,
      });
      simulation = { performed: true, success: true, simulatedAtBlock };
    } catch (error) {
      // The trap already sprang before the call — the scenario has missed its
      // window. Say so rather than submitting and reporting a false R4.
      simulation = {
        performed: true,
        success: false,
        simulatedAtBlock,
        revertReason: (error as Error).message.slice(0, 200),
      };
    }

    const workHash = await this.wallet.sendTransaction({
      account: this.options.account,
      chain: null,
      to: target,
      value: 0n,
      data: SELECTORS.work,
      // Gas must be supplied explicitly: estimation runs the same simulation
      // that passes, then the transaction reverts and consumes it.
      gas: 100_000n,
    });

    await this.register(armHash, 'C3-arm');
    await this.register(workHash, 'C3-work', simulation);
    return {
      scenario: 'C3',
      txHashes: [armHash, workHash],
      detail: {
        target,
        armedAtBlock: Number(armReceipt.blockNumber),
        simulationPassed: simulation.success,
        note: simulation.success
          ? 'work() simulated clean at the armed block and reverts once mined a block later'
          : 'the trap sprang before simulation — this run will not demonstrate R4',
      },
    };
  }

  /** Undo C3, so the target is usable by later scenarios. */
  async disarmTrap(): Promise<`0x${string}`> {
    assertChaosAllowed(this.options.chainId);
    const hash = await this.wallet.sendTransaction({
      account: this.options.account,
      chain: null,
      to: this.target,
      value: 0n,
      data: SELECTORS.disarm,
    });
    await this.register(hash, 'disarm');
    return hash;
  }

  /**
   * C4 — retry storm.
   *
   * Repeated attempts at an action that cannot succeed. Each attempt is a
   * separate transaction against `alwaysRevert()`, sharing one logical action
   * label so the detector can see them as retries of the same thing rather
   * than unrelated failures.
   *
   * Every attempt costs real gas, which is the point: a retry storm is
   * expensive, and R5 exists to stop it.
   */
  async c4RetryStorm(attempts = 4): Promise<ScenarioResult> {
    assertChaosAllowed(this.options.chainId);
    const target = this.target;
    const hashes: `0x${string}`[] = [];
    // One id across every attempt. Without it each transaction is its own
    // logical action and R5 counts four separate one-attempt failures rather
    // than one storm — which is exactly what the first live run did.
    const logicalActionId = `chaos:C4:${this.options.account.address}:${this.now().getTime()}`;

    for (let i = 0; i < attempts; i++) {
      const hash = await this.wallet.sendTransaction({
        account: this.options.account,
        chain: null,
        to: target,
        value: 0n,
        data: SELECTORS.alwaysRevert,
        gas: 60_000n,
      });
      hashes.push(hash);
      await this.register(hash, `C4-attempt-${i}`, undefined, logicalActionId);
      // Serialised deliberately: parallel submissions would race on nonce and
      // produce a nonce gap, which is a different incident entirely.
      await this.pub.waitForTransactionReceipt({ hash });
    }

    return {
      scenario: 'C4',
      txHashes: hashes,
      detail: {
        target,
        attempts,
        logicalActionId,
        note: 'every attempt reverts on chain and burns gas',
      },
    };
  }

  /**
   * C5 — gas starvation.
   *
   * Sweeps the signer down to just under one action's cost. Deliberately not
   * to zero: a signer at zero cannot even submit the transaction that would
   * demonstrate the problem, and R6 is about runway, not emptiness.
   */
  /**
   * C5 — gas starvation, against a wallet created for the purpose.
   *
   * The obvious implementation sweeps the chaos signer itself, and that is why
   * the first version of this was written and never run: it blocks every other
   * scenario until someone refunds it by hand.
   *
   * This funds a throwaway wallet, has it do a little work so R6 has a real
   * cost history to take a median from, then sweeps it down to dust. Not to
   * zero — a signer at zero cannot submit the transaction that would prove the
   * problem, and the rule is about runway rather than emptiness.
   *
   * The wallet is registered for observation before it is funded, because
   * discovery starts at the block it was registered at.
   */
  async c5GasStarve(params: { workCount?: number; fundingWei?: bigint } = {}): Promise<ScenarioResult> {
    assertChaosAllowed(this.options.chainId);

    const victimKey = generatePrivateKey();
    const victim = privateKeyToAccount(victimKey);
    const victimWallet = createWalletClient({
      account: victim,
      transport: http(this.options.rpcUrl),
    });

    await watchSigner(this.options.db, {
      signer: victim.address,
      chainId: this.options.chainId,
      agentId: `${this.agentId}-starved`,
      label: 'C5 victim',
      at: this.now(),
    });

    const fees = async (): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> => {
      const block = await this.pub.getBlock({ blockTag: 'latest' });
      const baseFee = block.baseFeePerGas ?? 1_000_000_000n;
      return { maxFeePerGas: baseFee * 2n + 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    };

    const hashes: `0x${string}`[] = [];
    const funding = params.fundingWei ?? 400_000_000_000_000n; // 0.0004 ETH
    const fundHash = await this.wallet.sendTransaction({
      account: this.options.account,
      chain: null,
      to: victim.address,
      value: funding,
      ...(await fees()),
    });
    await this.pub.waitForTransactionReceipt({ hash: fundHash });
    hashes.push(fundHash);

    // Work, so the median cost R6 compares against is measured rather than
    // assumed.
    for (let i = 0; i < (params.workCount ?? 3); i++) {
      const hash = await victimWallet.sendTransaction({
        account: victim,
        chain: null,
        to: victim.address,
        value: 0n,
        ...(await fees()),
      });
      await this.pub.waitForTransactionReceipt({ hash });
      hashes.push(hash);
    }

    const balance = await this.pub.getBalance({ address: victim.address });
    const f = await fees();
    const sweepCost = f.maxFeePerGas * 21_000n;
    const keep = sweepCost / 3n;
    const value = balance - sweepCost - keep;
    if (value > 0n) {
      const sweepHash = await victimWallet.sendTransaction({
        account: victim,
        chain: null,
        to: this.options.account.address,
        value,
        ...f,
      });
      await this.pub.waitForTransactionReceipt({ hash: sweepHash });
      hashes.push(sweepHash);
    }

    const left = await this.pub.getBalance({ address: victim.address });
    return {
      scenario: 'C5',
      txHashes: hashes,
      detail: {
        victim: victim.address,
        remainingWei: left.toString(),
        note: 'a wallet made for this run, so no shared signer is drained',
      },
    };
  }

  private async register(
    txHash: `0x${string}`,
    label: string,
    simulation?: { performed: boolean; success?: boolean; simulatedAtBlock?: number },
    logicalActionId?: string,
  ): Promise<void> {
    await watchTransaction(this.options.db, {
      txHash,
      agentId: this.agentId,
      signer: this.options.account.address,
      chainId: this.options.chainId,
      label,
      at: this.now(),
      ...(simulation ? { simulation } : {}),
      ...(logicalActionId ? { logicalActionId } : {}),
    });
  }

  /** Human-readable name of the chain this harness is pointed at. */
  get chainName(): string {
    return getChain(this.options.chainId).name;
  }
}
