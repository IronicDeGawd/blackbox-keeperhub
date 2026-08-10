import { formatDuration, formatFactValue, formatWei } from './format';
import type { IncidentClass } from './types';

/**
 * Rendering `evidence.facts`.
 *
 * The keys below are the ones the rules emit, copied from the console spec's
 * per-class table. They are pinned by a test on purpose: they have drifted
 * before — a summary read `runwayActions` where R6 emits
 * `projectedActionsRemaining` — and the only symptom was the word "unknown" in
 * a row, which is indistinguishable from a fact that was genuinely absent.
 *
 * Nothing here renames a fact for display. The key an operator sees is the key
 * the rule wrote, so it can be searched for in the detector.
 */

export const FACT_KEYS: Record<IncidentClass, readonly string[]> = {
  STUCK_TRANSACTION: [
    'nonce',
    'txHash',
    'submittedMaxFeePerGas',
    'currentBaseFee',
    'pendingDurationMs',
    'stuckThresholdMs',
    'corroborated',
  ],
  NONCE_GAP: [
    'latestNonce',
    'pendingNonce',
    'highestSubmittedNonce',
    'missingNonces',
    'gap',
    'blockedActionCount',
    'consecutiveGapPolls',
    'nonceGapConfirmations',
  ],
  GAS_UNDERPRICED: [
    'nonce',
    'submittedMaxFee',
    'submittedPriorityFee',
    'baseFeeAtDetection',
    'underpriceRatio',
    'thresholdFee',
    'feeDeficitPct',
  ],
  SIM_PASS_EXEC_REVERT: [
    'txHash',
    'revertReason',
    'simulatedAtBlock',
    'includedAtBlock',
    'blockDrift',
    'gasEstimate',
    'gasUsed',
    'elapsedMs',
  ],
  RETRY_STORM: [
    'logicalActionId',
    'attemptCount',
    'retryStormCount',
    'windowMs',
    'totalGasBurned',
    'distinctRevertReasons',
    'allRejectedPreflight',
  ],
  SIGNER_GAS_STARVED: [
    'signerBalance',
    'medianRecentCost',
    'gasStarvedMultiple',
    'thresholdBalance',
    'projectedActionsRemaining',
    'observedFundingFailure',
  ],
  ADVERSE_INCLUSION: [
    'expectedOut',
    'actualOut',
    'deltaBps',
    'slippageToleranceBps',
    'blockNumber',
    'txIndexInBlock',
    'neighbouringTxHashes',
    'route',
  ],
};

/**
 * Which fact bounds which. A measured value beside the threshold it was
 * compared against is the difference between a number and an argument.
 */
export const THRESHOLD_OF: Record<string, string> = {
  pendingDurationMs: 'stuckThresholdMs',
  consecutiveGapPolls: 'nonceGapConfirmations',
  submittedMaxFee: 'thresholdFee',
  signerBalance: 'thresholdBalance',
  deltaBps: 'slippageToleranceBps',
  attemptCount: 'retryStormCount',
};

/** The set of keys that appear only as somebody else's threshold. */
export const THRESHOLD_KEYS: ReadonlySet<string> = new Set(Object.values(THRESHOLD_OF));

const WEI_KEY = /(wei|balance|fee|cost|gasburned)$/i;
const MS_KEY = /ms$/i;

/**
 * Wei-valued facts whose names do not end in a word the pattern above catches.
 *
 * Both are decimal wei strings at the source — `submittedMaxFeePerGas` and
 * `baseFeeAtDetection` in packages/detector/src/rules.ts — and both used to
 * render as bare integers with no unit, which is the one thing the spec says
 * never to do with wei. Matching "fee" anywhere in the name instead would drag
 * in `feeDeficitPct`, which is a percentage.
 */
const WEI_KEYS = new Set(['submittedMaxFeePerGas', 'baseFeeAtDetection']);

/**
 * Amounts of a token R7 does not identify.
 *
 * They are base units of whatever was swapped, so rendering them as ETH would
 * assert a token nobody established. Leaving them as a bare integer is not an
 * option either — an unlabelled 18-digit number is the exact thing that gets
 * misread. They are labelled for what they are.
 */
const BASE_UNIT_KEYS = new Set(['expectedOut', 'actualOut']);

/**
 * Wei-valued facts arrive as decimal strings beyond Number.MAX_SAFE_INTEGER and
 * are rendered with a unit; durations are rendered as durations. Everything
 * else is shown as it came.
 */
export function formatFact(key: string, value: unknown): string {
  if (value === null || value === undefined) return formatFactValue(value);

  const isWei = WEI_KEY.test(key) || WEI_KEYS.has(key);
  if (isWei && (typeof value === 'string' || typeof value === 'number')) {
    // Exact: this value is evidence, and it sits beside the threshold it was
    // compared against. A rounded figure makes that comparison uncheckable.
    return formatWei(value, true);
  }

  if (MS_KEY.test(key) && typeof value === 'number') {
    return formatDuration(value);
  }

  if (BASE_UNIT_KEYS.has(key)) {
    return `${formatFactValue(value)} base units`;
  }

  return formatFactValue(value);
}
