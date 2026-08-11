import { resolveNetwork, type SupportedChainId } from '../chains.js';
import type { ExecutionEvent } from '../schemas.js';
import { extractRevertReason, type KeeperHubRun, type KeeperHubRunTx } from './types.js';

/**
 * Turn one run from `GET /api/analytics/runs` into `ExecutionEvent`s.
 *
 * This is the listing counterpart to `normaliseExecution`, which reads the
 * per-execution status record. The two describe overlapping worlds: a direct
 * run's `id` *is* the `executionId` the status route answers for — verified
 * against the live API — so both paths are deliberately given the same
 * `sourceId` scheme. Ingesting the same action through both then updates one
 * row instead of creating two, which is what makes listing safe to add to a
 * deployment that already polls its own submissions.
 *
 * What this path sees and the other does not: runs Blackbox never submitted.
 * That is the whole point of it, and it is why the PRD calls the audit trail
 * the input rather than the chain.
 */

export type NormaliseRunOptions = {
  agentId: string;
  /**
   * The address the organisation executes as. A run record does not carry one —
   * KeeperHub submits from a shared relayer into the org's smart account — so
   * it is supplied by whoever configured the org rather than inferred from a
   * payload that does not contain it.
   */
  signer: `0x${string}`;
  /**
   * Used only when a run names no network at all, which happens when it failed
   * before choosing one. Without it such a run is dropped rather than filed
   * against a chain we guessed.
   */
  fallbackChainId?: SupportedChainId;
  now: Date;
  makeId: () => string;
};

/**
 * A run that produced no on-chain write is still worth recording — a workflow
 * that reverted in pre-flight has no hash and no receipt, and that absence is
 * exactly what tells R4 and R10 apart from a chain-level failure.
 */
export function normaliseRun(run: KeeperHubRun, options: NormaliseRunOptions): ExecutionEvent[] {
  const txs = run.transactionHashes ?? [];
  const runChainId = resolveNetwork(run.network) ?? resolveNetwork(run.networks?.[0]);
  const submittedAt = new Date(run.startedAt);
  const completedAt = run.completedAt ? new Date(run.completedAt) : undefined;
  const revertReason = extractRevertReason(run.error);

  const base = {
    /**
     * Retries of one action, as KeeperHub expresses them.
     *
     * A workflow that fails and runs again produces a *new* run with a new id,
     * so keying on the run id would make every retry its own logical action and
     * R5 could never see a storm on a managed wallet. The workflow is the
     * action; the runs are the attempts. R5 only counts failures inside its
     * window, so a healthy schedule firing hourly never accumulates.
     *
     * A direct execution has no workflow, and each call is its own action.
     */
    logicalActionId: run.workflowId ?? run.id,
    agentId: options.agentId,
    signer: options.signer,
    // Everything listed here ran on a managed wallet, which is what makes a
    // nonce-bearing rule inapplicable to it.
    agentKind: 'keeperhub' as const,
    ...(run.workflowId ? { workflowId: run.workflowId } : {}),
    trigger: {
      // A workflow run was started by something KeeperHub scheduled or was
      // called for; a direct run is an API call by definition. The listing does
      // not name the trigger type, so `schedule` is never asserted here.
      kind: 'api' as const,
      detail: {
        source: 'keeperhub-runs',
        runSource: run.source,
        ...(run.workflowId ? { workflowId: run.workflowId } : {}),
        ...(run.workflowName ? { workflowName: run.workflowName } : {}),
        ...(run.directType ? { directType: run.directType } : {}),
        /**
         * How far the workflow got before it stopped, and what kind of failure
         * it was. A run that fails at the same step every time is a broken
         * definition rather than an unlucky chain — which is the whole
         * distinction WORKFLOW_MISCONFIGURED exists to draw, and there is no
         * node id on a run that produced no transaction to draw it from.
         */
        ...(run.completedSteps !== null && run.completedSteps !== undefined
          ? { completedSteps: run.completedSteps }
          : {}),
        ...(run.errorType ? { errorType: run.errorType } : {}),
        ...(run.errorCategory ? { errorCategory: run.errorCategory } : {}),
        ...(run.durationMs !== null && run.durationMs !== undefined
          ? { durationMs: run.durationMs }
          : {}),
      },
    },
    /**
     * KeeperHub pre-flights every write with `eth_estimateGas` and will not
     * submit a call it expects to revert. So a simulation always happened; a run
     * that failed without producing a hash is the case where we know it failed
     * and know the reason.
     */
    simulation: {
      performed: true,
      success: !isPreflightFailure(run),
      ...(isPreflightFailure(run) && revertReason ? { revertReason } : {}),
    },
    raw: run,
    ingestedAt: options.now,
  };

  if (txs.length === 0) {
    const chainId = runChainId ?? options.fallbackChainId;
    // No network and no transaction leaves nothing a rule could evaluate and no
    // honest chain to file it under.
    if (chainId === undefined) return [];
    return [
      {
        ...base,
        id: options.makeId(),
        sourceId: run.id,
        attemptIndex: 0,
        chainId,
        submission: { submittedAt, route: 'unknown' },
        outcome: {
          status: outcomeWithoutTx(run),
          ...(revertReason ? { revertReason } : {}),
          ...(completedAt ? { observedAt: completedAt } : {}),
        },
      } satisfies ExecutionEvent,
    ];
  }

  return txs.flatMap((tx, index) => {
    // A workflow run names the chain per transaction, which matters because one
    // run may write on more than one.
    const chainId =
      (tx.chainId !== null && tx.chainId !== undefined && isSupported(tx.chainId)
        ? tx.chainId
        : null) ??
      resolveNetwork(tx.network) ??
      runChainId ??
      options.fallbackChainId;
    if (chainId === undefined || chainId === null) return [];

    const isLast = index === txs.length - 1;
    return [
      {
        ...base,
        id: options.makeId(),
        // Same scheme as `normaliseExecution`, so the polled and listed views of
        // one direct execution collapse onto a single row.
        sourceId: `${run.id}:${index}`,
        attemptIndex: index,
        chainId,
        submission: { txHash: tx.hash as `0x${string}`, submittedAt, route: 'unknown' },
        outcome: {
          status: outcomeForTx(tx, isLast, run),
          ...(tx.blockNumber != null ? { blockNumber: tx.blockNumber } : {}),
          ...(toBigInt(tx.gasUsed) !== undefined ? { gasUsed: toBigInt(tx.gasUsed)! } : {}),
          ...(isLast && revertReason ? { revertReason } : {}),
          ...(tx.verifiedAt
            ? { observedAt: new Date(tx.verifiedAt) }
            : completedAt
              ? { observedAt: completedAt }
              : {}),
        },
      } satisfies ExecutionEvent,
    ];
  });
}

/** A run that failed having produced no transaction never reached a mempool. */
function isPreflightFailure(run: KeeperHubRun): boolean {
  return isFailure(run.status) && (run.transactionHashes?.length ?? 0) === 0;
}

function isFailure(status: KeeperHubRun['status']): boolean {
  return status === 'error' || status === 'system_error' || status === 'external_error';
}

function outcomeWithoutTx(run: KeeperHubRun): ExecutionEvent['outcome']['status'] {
  if (run.status === 'pending' || run.status === 'running') return 'pending';
  if (isFailure(run.status)) return 'rejected';
  // `cancelled` stopped before submitting; `success` with no write was a read
  // or a workflow of non-chain steps. Neither is an on-chain outcome.
  return 'unknown';
}

/**
 * Only the last transaction carries the run's outcome. An earlier one that was
 * superseded is a replacement — what a fee bump looks like from outside — and
 * calling it a failure would have R5 counting retries that were not failures.
 */
function outcomeForTx(
  tx: KeeperHubRunTx,
  isLast: boolean,
  run: KeeperHubRun,
): ExecutionEvent['outcome']['status'] {
  if (!isLast) return 'replaced';
  if (tx.receiptStatus === 'success') return 'included';
  if (tx.receiptStatus === 'reverted') return 'reverted';
  // A direct run reports no receipt status at all, so the run's own verdict is
  // the best available statement — and `unknown` where it has not finished,
  // which is what leaves corroboration something to do.
  if (run.status === 'success') return 'included';
  if (isFailure(run.status)) return 'reverted';
  if (run.status === 'pending' || run.status === 'running') return 'pending';
  return 'unknown';
}

function isSupported(chainId: number): chainId is SupportedChainId {
  return resolveNetwork(String(chainId)) !== null;
}

const toBigInt = (v: string | null | undefined): bigint | undefined =>
  v === null || v === undefined || v === '' ? undefined : BigInt(v);
