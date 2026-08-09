import type { DetectionConfig, ExecutionEvent, IncidentClass, RuleId } from '@blackbox/core';

/** RPC-sourced facts, gathered once per evaluation so rules stay pure. */
export type Corroboration = {
  pendingNonce?: number;
  latestNonce?: number;
  signerBalance?: bigint;
  baseFeeAtDetection?: bigint;
  /**
   * Consecutive evaluations in which a nonce gap has been observed for this
   * signer. Held by the detector across polls; R2 will not fire on a single
   * observation because a gap is normal for the moment between submissions.
   */
  consecutiveGapPolls?: number;
  /** Nonces submitted but never seen terminal, as understood by the caller. */
  missingNonces?: number[];
};

/**
 * Positional evidence for R7. Assembled by the caller from block data, because
 * a rule may not perform I/O. Absent means R7 cannot fire — which is correct:
 * without the evidence there is no basis for the claim.
 */
export type InclusionAnalysis = {
  expectedOut: bigint;
  actualOut: bigint;
  blockNumber: number;
  txIndexInBlock: number;
  /** Transactions from other senders in the same block touching the same target. */
  neighbouringTxHashes: string[];
};

export type RuleContext = {
  now: Date;
  detection: DetectionConfig;
  agentId: string;
  signer: `0x${string}`;
  chainId: number;
  corroboration?: Corroboration;
  inclusion?: InclusionAnalysis;
};

/**
 * What a rule returns. Deliberately not a full `Incident`: identity, timestamps
 * and lifecycle belong to the detector, so rules stay pure functions that are
 * trivial to test.
 */
export type IncidentDraft = {
  class: IncidentClass;
  ruleId: RuleId;
  severity: 'info' | 'warning' | 'critical';
  confidence: number;
  eventIds: string[];
  facts: Record<string, unknown>;
};

export type Rule = {
  id: RuleId;
  /** Window is this signer's recent events, oldest first. */
  evaluate: (window: readonly ExecutionEvent[], ctx: RuleContext) => IncidentDraft | null;
};

const TERMINAL: ReadonlySet<ExecutionEvent['outcome']['status']> = new Set([
  'included',
  'reverted',
  'dropped',
  'replaced',
  'rejected',
]);

export const isTerminal = (e: ExecutionEvent): boolean => TERMINAL.has(e.outcome.status);

/** Terminal *and* unsuccessful. `replaced` is not a failure — it is a bump. */
export const isFailed = (e: ExecutionEvent): boolean =>
  e.outcome.status === 'reverted' ||
  e.outcome.status === 'dropped' ||
  e.outcome.status === 'rejected';

export function median(values: readonly bigint[]): bigint | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2n;
}
