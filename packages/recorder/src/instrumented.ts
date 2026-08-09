import { getChain, type KeeperHubExecution } from '@blackbox/core';
import { watchExecution, type Database } from '@blackbox/store';

/** The subset of the KeeperHub client this wrapper needs. */
export type SubmittingClient = {
  transfer(params: {
    network: string;
    recipientAddress: string;
    amount: string;
    tokenAddress?: string;
    gasLimitMultiplier?: string;
  }): Promise<KeeperHubExecution>;
  writeContract(params: {
    network: string;
    contractAddress: string;
    functionName: string;
    functionArgs: string;
    abi?: string;
    value?: string;
    gasLimitMultiplier?: string;
  }): Promise<KeeperHubExecution>;
};

export type InstrumentedOptions = {
  db: Database;
  client: SubmittingClient;
  agentId: string;
  /** The KeeperHub managed wallet that actually signs. */
  signer: `0x${string}`;
  now?: () => Date;
};

/**
 * Submission wrapper (PRD §3.1).
 *
 * KeeperHub cannot list executions, so anything Blackbox should watch has to be
 * registered as it is submitted. This wrapper does that registration on every
 * write, which is the only reason the recorder's watchlist is ever populated
 * outside tests.
 *
 * It deliberately does not try to capture fee parameters. Direct Execution
 * chooses the fee server-side and never reports it, and the chain reports it
 * anyway via `eth_getTransactionByHash` once the transaction is in the pool —
 * see `enrich.ts`. Recording a guess here would be worse than recording
 * nothing, because a wrong `maxFeePerGas` feeds straight into R3 and could
 * trigger a replacement that was never needed.
 */
export class InstrumentedKeeperHub {
  private readonly now: () => Date;

  constructor(private readonly options: InstrumentedOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async transfer(
    params: Parameters<SubmittingClient['transfer']>[0] & { chainId: number },
  ): Promise<KeeperHubExecution> {
    const { chainId, ...rest } = params;
    const execution = await this.options.client.transfer(rest);
    await this.register(execution, chainId);
    return execution;
  }

  async writeContract(
    params: Parameters<SubmittingClient['writeContract']>[0] & { chainId: number },
  ): Promise<KeeperHubExecution> {
    const { chainId, ...rest } = params;
    const execution = await this.options.client.writeContract(rest);
    await this.register(execution, chainId);
    return execution;
  }

  /**
   * Registration failure must not lose the execution silently: the caller's
   * transaction has already been submitted by this point, so the throw is
   * deliberate and tells them the submission is unwatched.
   */
  private async register(execution: KeeperHubExecution, chainId: number): Promise<void> {
    const chain = getChain(chainId);
    await watchExecution(this.options.db, {
      executionId: execution.executionId,
      agentId: this.options.agentId,
      signer: this.options.signer,
      chainId,
      // Route is a property of the chain, not a per-call choice: KeeperHub
      // routes privately only where usePrivateMempoolRpc is set.
      submitted: { route: chain.privateMempool ? 'private' : 'public' },
      at: this.now(),
    });
  }
}
