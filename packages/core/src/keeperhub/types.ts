import { z } from 'zod';

/**
 * Shape of `GET /api/execute/{executionId}/status`, derived from live responses
 * captured on 2026-08-09 (fixtures alongside this file). The published
 * reference documents none of `sponsored`, `receipts`, `retryCount`,
 * `gasPriceWei`, or `estimatedCostUsd`, so treat this schema — not the docs —
 * as the contract, and keep it permissive: unknown fields are preserved by the
 * caller in `raw`, and every field the docs omitted is optional so a vendor
 * change degrades into missing data rather than a parse failure.
 */

export const keeperHubReceiptSchema = z.object({
  hash: z.string(),
  chainId: z.number().int().positive(),
  gasUsed: z.string().nullish(),
  verified: z.boolean().nullish(),
  verifiedAt: z.string().nullish(),
  blockNumber: z.number().int().nonnegative().nullish(),
  /** "success" | "reverted" observed; kept open in case others exist. */
  receiptStatus: z.string().nullish(),
});
export type KeeperHubReceipt = z.infer<typeof keeperHubReceiptSchema>;

export const keeperHubExecutionStatus = z.enum(['pending', 'running', 'completed', 'failed']);

export const keeperHubExecutionSchema = z.object({
  executionId: z.string(),
  status: keeperHubExecutionStatus,
  type: z.string().nullish(),
  transactionHash: z.string().nullish(),
  transactionLink: z.string().nullish(),
  sponsored: z.boolean().nullish(),
  receipts: z.array(keeperHubReceiptSchema).nullish(),
  /** Object on writes; the raw return value on reads. */
  result: z.unknown().nullish(),
  error: z.string().nullish(),
  gasUsedWei: z.string().nullish(),
  gasPriceWei: z.string().nullish(),
  estimatedCostUsd: z.union([z.string(), z.number()]).nullish(),
  retryCount: z.number().int().nonnegative().nullish(),
  network: z.string().nullish(),
  /**
   * Present on the status record, absent from the response to the submission
   * itself — that answers with only `executionId`, `status`, `transactionHash`
   * and `transactionLink`. Requiring it made the client throw on a submission
   * that had already landed on chain, so a successful remediation was recorded
   * as failed and its hash discarded. Observed against a live pause() call.
   */
  createdAt: z.string().nullish(),
  completedAt: z.string().nullish(),
});
export type KeeperHubExecution = z.infer<typeof keeperHubExecutionSchema>;

/**
 * Shape of `GET /api/analytics/runs`, the endpoint behind their `list_executions`
 * tool. Captured live on 2026-08-11 (fixture `analytics-runs-page.json`).
 *
 * This is a *different* record from the one above: it covers workflow runs as
 * well as direct executions, it is the only listing endpoint of the two — the
 * status route answers for one id you already know — and its field names do not
 * line up with the execution record's. Kept permissive for the same reason.
 */

export const keeperHubRunStatus = z.enum([
  'pending',
  'running',
  'success',
  'error',
  'system_error',
  'external_error',
  'cancelled',
]);
export type KeeperHubRunStatus = z.infer<typeof keeperHubRunStatus>;

/**
 * One on-chain write a run produced.
 *
 * A workflow run fills in `chainId`, `verified`, `blockNumber`, `gasUsed` and
 * `receiptStatus` because KeeperHub re-fetches the receipt itself. A direct run
 * carries only `hash`, `nodeId`, `nodeName` and `network` — same array, half the
 * information — so anything beyond the hash is optional here by observation,
 * not by caution.
 */
export const keeperHubRunTxSchema = z.object({
  hash: z.string(),
  nodeId: z.string().nullish(),
  nodeName: z.string().nullish(),
  chainId: z.number().int().positive().nullish(),
  network: z.string().nullish(),
  gasUsed: z.string().nullish(),
  verified: z.boolean().nullish(),
  verifiedAt: z.string().nullish(),
  blockNumber: z.number().int().nonnegative().nullish(),
  receiptStatus: z.string().nullish(),
});
export type KeeperHubRunTx = z.infer<typeof keeperHubRunTxSchema>;

export const keeperHubRunSchema = z.object({
  id: z.string(),
  source: z.enum(['workflow', 'direct']),
  status: keeperHubRunStatus,
  startedAt: z.string(),
  completedAt: z.string().nullish(),
  durationMs: z.number().nullish(),
  workflowId: z.string().nullish(),
  workflowName: z.string().nullish(),
  directType: z.string().nullish(),
  /** A chain id string on a workflow run, a network name on a direct one. */
  network: z.string().nullish(),
  networks: z.array(z.string()).nullish(),
  /**
   * Documented as the native cost in wei, and correct for a workflow run. A
   * direct run repeats `gasUsedWei` here — gas units, not wei — so this field
   * is only trustworthy for `source: 'workflow'`.
   */
  gasCostWei: z.string().nullish(),
  gasUsedWei: z.string().nullish(),
  transactionHashes: z.array(keeperHubRunTxSchema).nullish(),
  totalSteps: z.number().int().nullish(),
  completedSteps: z.number().int().nullish(),
  error: z.string().nullish(),
  errorCode: z.string().nullish(),
  errorType: z.string().nullish(),
  errorCategory: z.string().nullish(),
});
export type KeeperHubRun = z.infer<typeof keeperHubRunSchema>;

export const keeperHubRunPageSchema = z.object({
  runs: z.array(keeperHubRunSchema),
  /**
   * The `startedAt` of the last run on this page, not an opaque token. The
   * server pages *backwards* with a strict `<`, so this walks into the past and
   * can never be used to resume forward from a position — see the recorder's
   * high-water mark. A strict `<` also drops a run sharing that exact
   * millisecond, which is why ingestion dedupes on run id as well.
   */
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative().nullish(),
  page: z.number().int().nullish(),
  pageSize: z.number().int().nullish(),
});
export type KeeperHubRunPage = z.infer<typeof keeperHubRunPageSchema>;

/**
 * A `status: "failed"` record means two very different things depending on
 * whether a transaction was ever submitted. KeeperHub pre-flights with
 * `eth_estimateGas` and refuses to submit a call it expects to revert, which
 * costs no gas and produces no hash. There is no discriminator field, so we
 * derive one.
 */
export function failureStage(
  execution: KeeperHubExecution,
): 'preflight' | 'onchain' | null {
  if (execution.status !== 'failed') return null;
  const submitted = Boolean(execution.transactionHash) || (execution.receipts?.length ?? 0) > 0;
  return submitted ? 'onchain' : 'preflight';
}

/**
 * KeeperHub returns revert reasons wrapped in its own prose, e.g.
 * `Contract call failed: Error(ERC20: transfer amount exceeds balance)`.
 * Pull out the inner reason; fall back to the whole string when it does not
 * match, so a format change loses formatting rather than the message.
 */
export function extractRevertReason(error: string | null | undefined): string | undefined {
  if (!error) return undefined;
  const wrapped = /Error\((.+)\)\s*$/.exec(error.trim());
  if (wrapped?.[1]) return wrapped[1];
  const afterColon = /^Contract call failed:\s*(.+)$/.exec(error.trim());
  if (afterColon?.[1]) return afterColon[1];
  return error;
}
