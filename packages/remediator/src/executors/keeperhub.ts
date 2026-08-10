import { getChain } from '@blackbox/core';
import { formatEther } from 'viem';
import type { RemediationExecutor } from '../remediator.js';
import type { ReceiptVerifier } from './verify.js';

/**
 * Submits a playbook's plan through KeeperHub Direct Execution.
 *
 * What this executor can and cannot do was settled by probing the live API on
 * 2026-08-10, not by reading docs:
 *
 * A transfer submitted with `nonce`, `maxFeePerGas` and `maxPriorityFeePerGas`
 * in the body returned 202 and ignored all three. The resulting transaction was
 * sent by a sponsor EOA (`0xa17c…4e87`) calling a relayer contract
 * (`0x5af5…f07d`, selector `0x9aefaff8`, the managed wallet passed as the first
 * argument) at that sponsor's own nonce — 29367, against the 1 requested. The
 * managed wallet's own nonce never moved.
 *
 * The consequence is structural, not a missing parameter: KeeperHub never
 * signs a transaction *as* the agent's signer, so it cannot occupy a specific
 * nonce belonging to that signer. Any playbook that must replace a pending
 * transaction (P1) or fill a hole in a nonce sequence (P2) is unimplementable
 * through this path, and this executor refuses those plans loudly rather than
 * submitting something that cannot possibly have the intended effect.
 *
 * Plans that only need *a* transaction to land — pausing a breaker (P4),
 * topping up a signer (P5) — work fine, with the caveat that the planned fees
 * are advisory: the sponsor prices its own submission.
 */

export type KeeperHubSubmitter = {
  transfer(params: {
    network: string;
    recipientAddress: string;
    amount: string;
  }): Promise<{ executionId: string; transactionHash?: string }>;
  writeContract(params: {
    network: string;
    contractAddress: string;
    functionName: string;
    functionArgs: string;
    abi?: string;
    value?: string;
  }): Promise<{ executionId: string; transactionHash?: string }>;
};

export class KeeperHubExecutor implements RemediationExecutor {
  constructor(
    private readonly client: KeeperHubSubmitter,
    private readonly verifier: ReceiptVerifier,
  ) {}

  async submit(params: Parameters<RemediationExecutor['submit']>[0]): ReturnType<
    RemediationExecutor['submit']
  > {
    const { plan, incident } = params;
    if (plan.nonce !== undefined) {
      throw new Error(
        `KeeperHub cannot submit at a chosen nonce: it executes through a sponsored relayer ` +
          `at the sponsor's nonce, never as ${incident.signer}. Plan "${plan.description}" ` +
          `requires nonce ${plan.nonce} and must be routed to an executor holding that signer's key.`,
      );
    }

    const network = getChain(incident.chainId).keeperHubNetwork;
    const result = plan.call
      ? await this.client.writeContract({
          network,
          contractAddress: plan.to,
          functionName: plan.call.functionName,
          functionArgs: JSON.stringify(plan.call.args),
          ...(plan.call.abi ? { abi: plan.call.abi } : {}),
          ...(plan.value > 0n ? { value: formatEther(plan.value) } : {}),
        })
      : await this.client.transfer({
          network,
          recipientAddress: plan.to,
          amount: formatEther(plan.value),
        });

    const txHash = result.transactionHash;
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      // Without a hash there is no remediation, only a claim of one.
      throw new Error(
        `KeeperHub execution ${result.executionId} returned no transaction hash, so the ` +
          `remediation cannot be verified and must not be reported as performed`,
      );
    }
    return { txHash: txHash as `0x${string}`, keeperHubActionId: result.executionId };
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
