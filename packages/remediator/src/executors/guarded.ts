/**
 * A guard evaluated where it can still be true.
 *
 * Blackbox's own guards run in this process, decide, and then submit — and
 * between those two moments the chain moves. For most remediations that gap is
 * harmless. For a circuit breaker it is exactly wrong: pausing a contract that
 * somebody already paused wastes gas and writes a confusing entry into the
 * ledger, and pausing one that has since recovered is worse than doing nothing.
 *
 * KeeperHub's check-and-execute reads a value, tests it, and acts in the same
 * call. The condition is therefore evaluated against the state the action will
 * run against, rather than against the state of a block ago.
 */

export type CheckAndExecuteClient = {
  checkAndExecute(params: {
    contractAddress: string;
    chainId: string;
    functionName: string;
    functionArgs: string;
    abi?: string;
    condition: { operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; value: string };
    action: {
      contractAddress: string;
      functionName: string;
      functionArgs: string;
      abi?: string;
    };
    idempotencyKey?: string;
  }): Promise<{ conditionMet: boolean; execution: { executionId?: string } | null; raw: unknown }>;
};

/**
 * The two functions a breaker must expose for this to work.
 *
 * KeeperHub auto-fetches an ABI from the explorer, which fails for an
 * unverified contract — our own breaker among them, which is how the audit
 * found this. Sending a minimal ABI removes the dependency on somebody else
 * having verified the source.
 */
export const BREAKER_ABI = JSON.stringify([
  { inputs: [], name: 'paused', outputs: [{ type: 'bool' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'pause', outputs: [], stateMutability: 'nonpayable', type: 'function' },
]);

export type GuardedPauseParams = {
  breakerAddress: string;
  chainId: number;
  /** Read to decide. Defaults to the usual OpenZeppelin pause flag. */
  readFunction?: string;
  readArgs?: string;
  /** The value that means "already paused", so the action is skipped. */
  pausedValue?: string;
  abi?: string;
  /** Identifies the work, not the attempt, so a retry replays rather than repeats. */
  idempotencyKey?: string;
};

export type GuardedPauseResult =
  | { acted: true; executionId: string | undefined }
  /** The breaker was already in the state we wanted. Not a failure. */
  | { acted: false; reason: 'already_paused' };

/**
 * Pause a circuit breaker, but only if it is not already paused.
 *
 * The condition is `paused() == false`. A breaker somebody else already tripped
 * leaves this a no-op that costs nothing and says so, which is a better ledger
 * entry than a successful transaction that changed nothing.
 */
export async function guardedPause(
  client: CheckAndExecuteClient,
  params: GuardedPauseParams,
): Promise<GuardedPauseResult> {
  // Always send an ABI. Theirs is only auto-fetchable for a verified contract,
  // and the failure mode is a 400 at the moment we most want to act.
  const abi = params.abi ?? BREAKER_ABI;
  const result = await client.checkAndExecute({
    contractAddress: params.breakerAddress,
    chainId: String(params.chainId),
    functionName: params.readFunction ?? 'paused',
    functionArgs: params.readArgs ?? '[]',
    abi,
    // Act only while it is still false.
    condition: { operator: 'eq', value: params.pausedValue ?? 'false' },
    action: {
      contractAddress: params.breakerAddress,
      functionName: 'pause',
      functionArgs: '[]',
      abi,
    },
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  });

  if (!result.conditionMet) return { acted: false, reason: 'already_paused' };
  return { acted: true, executionId: result.execution?.executionId };
}
