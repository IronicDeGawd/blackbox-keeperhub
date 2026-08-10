import type { ExecutionEvent } from '../schemas.js';
import {
  extractRevertReason,
  failureStage,
  type KeeperHubExecution,
  type KeeperHubReceipt,
} from './types.js';

export type NormaliseOptions = {
  agentId: string;
  signer: `0x${string}`;
  chainId: number;
  /** Injected so normalisation stays pure and testable. */
  now: Date;
  /** Injected for the same reason; must be unique per event. */
  makeId: () => string;
  /**
   * Fee parameters the audit record does not carry. Supplied by the submission
   * wrapper (PRD §3.1) when Blackbox or an onboarded agent made the call;
   * absent for third-party submissions.
   */
  submitted?: {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    nonce?: number;
    route?: 'public' | 'private';
  };
};

const toBigInt = (v: string | null | undefined): bigint | undefined =>
  v === null || v === undefined || v === '' ? undefined : BigInt(v);

/**
 * Turn one KeeperHub execution record into one `ExecutionEvent` per attempt.
 *
 * KeeperHub keeps a single record per logical action and exposes attempts
 * through `receipts[]`, so the fan-out happens here: N receipts become N
 * events sharing a `logicalActionId`, each with its own `attemptIndex`. A
 * record with no receipts still yields exactly one event — the attempt that
 * was rejected pre-flight, or the one still in flight — because an action that
 * produced no receipt is precisely what several rules need to see.
 */
export function normaliseExecution(
  execution: KeeperHubExecution,
  options: NormaliseOptions,
): ExecutionEvent[] {
  const receipts = execution.receipts ?? [];
  // A submission response carries no `createdAt` — only the status record does.
  // Falling back to the observation time keeps a just-submitted execution
  // normalisable; it is the closest true statement available, and the record
  // will carry the real timestamp on the next poll.
  const submittedAt = execution.createdAt ? new Date(execution.createdAt) : options.now;
  const observedAt = execution.completedAt ? new Date(execution.completedAt) : undefined;
  const stage = failureStage(execution);
  const revertReason = extractRevertReason(execution.error);

  const base = {
    logicalActionId: execution.executionId,
    agentId: options.agentId,
    signer: options.signer,
    chainId: options.chainId,
    trigger: { kind: 'api' as const, detail: { type: execution.type ?? 'unknown' } },
    raw: execution,
    ingestedAt: options.now,
  };

  /**
   * KeeperHub pre-flights with `eth_estimateGas`, so a simulation always
   * happened. A pre-flight rejection is the one case where we know it failed
   * and know why; otherwise it passed, since nothing was submitted without it.
   */
  const simulation = {
    performed: true,
    success: stage !== 'preflight',
    ...(stage === 'preflight' && revertReason ? { revertReason } : {}),
  };

  if (receipts.length === 0) {
    const status = stage === 'preflight' ? 'rejected' : statusWithoutReceipt(execution);
    return [
      {
        ...base,
        id: options.makeId(),
        sourceId: execution.executionId,
        attemptIndex: 0,
        simulation,
        submission: {
          ...(execution.transactionHash
            ? { txHash: execution.transactionHash as `0x${string}` }
            : {}),
          ...(options.submitted?.nonce !== undefined ? { nonce: options.submitted.nonce } : {}),
          ...(options.submitted?.maxFeePerGas !== undefined
            ? { maxFeePerGas: options.submitted.maxFeePerGas }
            : {}),
          ...(options.submitted?.maxPriorityFeePerGas !== undefined
            ? { maxPriorityFeePerGas: options.submitted.maxPriorityFeePerGas }
            : {}),
          submittedAt,
          route: options.submitted?.route ?? 'unknown',
        },
        outcome: {
          status,
          ...(revertReason && status !== 'rejected' ? { revertReason } : {}),
          ...(observedAt ? { observedAt } : {}),
        },
      } satisfies ExecutionEvent,
    ];
  }

  return receipts.map((receipt, index) => {
    const isLast = index === receipts.length - 1;
    return {
      ...base,
      id: options.makeId(),
      // Distinct per attempt, so dedupe on (sourceId, attemptIndex) works.
      sourceId: `${execution.executionId}:${index}`,
      attemptIndex: index,
      simulation,
      submission: {
        txHash: receipt.hash as `0x${string}`,
        ...(options.submitted?.nonce !== undefined ? { nonce: options.submitted.nonce } : {}),
        ...(options.submitted?.maxFeePerGas !== undefined
          ? { maxFeePerGas: options.submitted.maxFeePerGas }
          : {}),
        ...(options.submitted?.maxPriorityFeePerGas !== undefined
          ? { maxPriorityFeePerGas: options.submitted.maxPriorityFeePerGas }
          : {}),
        submittedAt,
        route: options.submitted?.route ?? 'unknown',
      },
      outcome: {
        status: receiptOutcome(receipt, isLast, execution),
        ...(receipt.blockNumber != null ? { blockNumber: receipt.blockNumber } : {}),
        ...(toBigInt(receipt.gasUsed) !== undefined ? { gasUsed: toBigInt(receipt.gasUsed)! } : {}),
        ...(isLast && toBigInt(execution.gasPriceWei) !== undefined
          ? { effectiveGasPrice: toBigInt(execution.gasPriceWei)! }
          : {}),
        ...(isLast && revertReason && execution.status === 'failed' ? { revertReason } : {}),
        ...(receipt.verifiedAt ? { observedAt: new Date(receipt.verifiedAt) } : {}),
      },
    } satisfies ExecutionEvent;
  });
}

function statusWithoutReceipt(execution: KeeperHubExecution): ExecutionEvent['outcome']['status'] {
  switch (execution.status) {
    case 'pending':
    case 'running':
      return 'pending';
    case 'completed':
      // Completed with neither hash nor receipt is a read call, not a write.
      return execution.transactionHash ? 'included' : 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * An earlier receipt that was superseded is a replacement, not a failure — that
 * is what a fee bump looks like from the outside. Only the final receipt
 * carries the action's real outcome.
 */
function receiptOutcome(
  receipt: KeeperHubReceipt,
  isLast: boolean,
  execution: KeeperHubExecution,
): ExecutionEvent['outcome']['status'] {
  if (!isLast) return 'replaced';
  if (receipt.receiptStatus === 'success') return 'included';
  if (receipt.receiptStatus === 'reverted') return 'reverted';
  return execution.status === 'completed' ? 'included' : 'unknown';
}
