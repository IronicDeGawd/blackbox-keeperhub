import { z } from 'zod';

/** Wire-safe bigint: persisted and transported as a decimal string. */
export const bigintString = z
  .union([z.string(), z.bigint()])
  .transform((v) => (typeof v === 'bigint' ? v : BigInt(v)));

export const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'not a 20-byte hex address')
  .transform((s) => s.toLowerCase() as `0x${string}`);

export const hexHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'not a 32-byte hex hash')
  .transform((s) => s.toLowerCase() as `0x${string}`);

// ---------------------------------------------------------------- events

export const triggerKind = z.enum(['schedule', 'condition', 'manual', 'api', 'unknown']);

/**
 * `rejected` is an addition to the set in PRD §4.1. KeeperHub pre-flights every
 * call and refuses to submit one it expects to revert, so an action can fail
 * having never reached the mempool — no hash, no receipt, no gas spent. None of
 * the original states says that: `dropped` implies it was submitted and then
 * evicted, and `unknown` would throw away the most certain fact we have.
 * Detection depends on the distinction, because a call that never ran cannot be
 * a `SIM_PASS_EXEC_REVERT` and burns nothing for `RETRY_STORM` to count.
 */
export const outcomeStatus = z.enum([
  'pending',
  'included',
  'reverted',
  'dropped',
  'replaced',
  'rejected',
  'unknown',
]);

export const submissionRoute = z.enum(['public', 'private', 'unknown']);

export const executionEventSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  /**
   * Groups retries of one logical action. PRD §3.1 is still open on whether
   * KeeperHub supplies this; until then the recorder synthesises it and
   * `attemptIndex` stays 0.
   */
  logicalActionId: z.string(),
  attemptIndex: z.number().int().min(0),
  agentId: z.string(),
  signer: hexAddress,
  chainId: z.number().int().positive(),

  trigger: z.object({
    kind: triggerKind,
    detail: z.record(z.unknown()).optional(),
  }),

  simulation: z.object({
    performed: z.boolean(),
    success: z.boolean().optional(),
    revertReason: z.string().optional(),
    gasEstimate: bigintString.optional(),
    simulatedAtBlock: z.number().int().nonnegative().optional(),
  }),

  submission: z.object({
    txHash: hexHash.optional(),
    nonce: z.number().int().nonnegative().optional(),
    maxFeePerGas: bigintString.optional(),
    maxPriorityFeePerGas: bigintString.optional(),
    submittedAt: z.coerce.date(),
    route: submissionRoute,
  }),

  outcome: z.object({
    status: outcomeStatus,
    blockNumber: z.number().int().nonnegative().optional(),
    gasUsed: bigintString.optional(),
    effectiveGasPrice: bigintString.optional(),
    revertReason: z.string().optional(),
    observedAt: z.coerce.date().optional(),
  }),

  /** Never discarded. Rules read normalised fields only; RCA may read this. */
  raw: z.unknown(),
  ingestedAt: z.coerce.date(),
});

export type ExecutionEvent = z.infer<typeof executionEventSchema>;

// -------------------------------------------------------------- incidents

export const incidentClass = z.enum([
  'STUCK_TRANSACTION',
  'NONCE_GAP',
  'GAS_UNDERPRICED',
  'SIM_PASS_EXEC_REVERT',
  'RETRY_STORM',
  'SIGNER_GAS_STARVED',
  'ADVERSE_INCLUSION',
]);
export type IncidentClass = z.infer<typeof incidentClass>;

export const incidentSeverity = z.enum(['info', 'warning', 'critical']);

export const incidentStatus = z.enum([
  'open',
  'diagnosing',
  'remediating',
  'resolved',
  'failed',
  'acknowledged',
]);

export const ruleId = z.enum(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
export type RuleId = z.infer<typeof ruleId>;

export const rootCauseAnalysisSchema = z.object({
  summary: z.string().min(1),
  contributingFactors: z.array(z.string()),
  timeline: z.array(z.object({ at: z.coerce.date(), what: z.string() })),
  recommendation: z.string().min(1),
  model: z.string(),
  generatedAt: z.coerce.date(),
  promptVersion: z.string(),
});
export type RootCauseAnalysis = z.infer<typeof rootCauseAnalysisSchema>;

/**
 * The LLM returns only the prose fields; `model`, `generatedAt`, and
 * `promptVersion` are stamped by the diagnostician so they cannot be
 * hallucinated.
 */
export const rcaLlmOutputSchema = rootCauseAnalysisSchema.omit({
  model: true,
  generatedAt: true,
  promptVersion: true,
});

export const remediationAttemptSchema = z.object({
  attemptIndex: z.number().int().min(0),
  startedAt: z.coerce.date(),
  guardsPassed: z.array(z.string()),
  guardsFailed: z.array(z.string()),
  txHash: hexHash.optional(),
  keeperHubActionId: z.string().optional(),
  /**
   * Who put the transaction on chain. `user-signed` means Blackbox planned the
   * remediation and a human's wallet signed it — a materially different claim
   * from acting autonomously, and one the UI must not blur.
   */
  executor: z.enum(['signer', 'keeperhub', 'user-signed']).optional(),
  status: z.enum(['succeeded', 'failed', 'skipped']),
  failureReason: z.string().optional(),
  gasUsed: bigintString.optional(),
  completedAt: z.coerce.date().optional(),
});

export const remediationRecordSchema = z.object({
  playbookId: z.string(),
  attempts: z.array(remediationAttemptSchema),
  finalStatus: z.enum(['succeeded', 'failed', 'skipped_by_guard', 'skipped_by_policy']),
  verifiedAt: z.coerce.date().optional(),
});
export type RemediationRecord = z.infer<typeof remediationRecordSchema>;

export const incidentSchema = z.object({
  id: z.string(),
  class: incidentClass,
  severity: incidentSeverity,
  status: incidentStatus,
  agentId: z.string(),
  signer: hexAddress,
  chainId: z.number().int().positive(),

  detectedAt: z.coerce.date(),
  firstEventAt: z.coerce.date(),
  resolvedAt: z.coerce.date().optional(),

  evidence: z.object({
    eventIds: z.array(z.string()).min(1),
    ruleId,
    /** The exact values that tripped the rule. Rendered in the UI verbatim. */
    facts: z.record(z.unknown()),
    corroboration: z
      .object({
        pendingNonce: z.number().int().nonnegative().optional(),
        latestNonce: z.number().int().nonnegative().optional(),
        signerBalance: bigintString.optional(),
        baseFeeAtDetection: bigintString.optional(),
      })
      .optional(),
    /** R3 suppresses a correlated R1; recorded so the timeline shows both. */
    suppressedRules: z.array(ruleId).optional(),
  }),

  confidence: z.number().min(0).max(1),
  rca: rootCauseAnalysisSchema.optional(),
  remediation: remediationRecordSchema.optional(),
});
export type Incident = z.infer<typeof incidentSchema>;
