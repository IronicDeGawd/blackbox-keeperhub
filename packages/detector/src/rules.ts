import type { ExecutionEvent } from '@blackbox/core';
import { isFailed, isTerminal, median, type IncidentDraft, type Rule, type RuleContext } from './types.js';

/**
 * Every rule is a pure function over a per-signer window plus corroboration.
 * No rule performs I/O, and no rule holds a threshold literal — thresholds come
 * from config so tests can vary them and the console can show them next to the
 * evidence. Detection never involves the LLM: remediation spends real gas, so
 * the trigger has to be auditable and unit-testable.
 */

const latestBySubmission = (window: readonly ExecutionEvent[]): ExecutionEvent[] =>
  [...window].sort((a, b) => a.submission.submittedAt.getTime() - b.submission.submittedAt.getTime());

/** A nonce is resolved if any event at that nonce reached a terminal state. */
function nonceResolved(window: readonly ExecutionEvent[], nonce: number | undefined): boolean {
  if (nonce === undefined) return false;
  return window.some((e) => e.submission.nonce === nonce && isTerminal(e));
}

// ── R1 · STUCK_TRANSACTION ──────────────────────────────────────────────────

export const R1: Rule = {
  id: 'R1',
  evaluate(window, ctx) {
    const candidates = latestBySubmission(window).filter(
      (e) =>
        e.outcome.status === 'pending' &&
        ctx.now.getTime() - e.submission.submittedAt.getTime() > ctx.detection.stuckThresholdMs &&
        !nonceResolved(window, e.submission.nonce),
    );
    const event = candidates[0];
    if (!event) return null;

    const pendingDurationMs = ctx.now.getTime() - event.submission.submittedAt.getTime();
    const corr = ctx.corroboration;
    // Corroborated means RPC agrees the nonce has not advanced past this one.
    const corroborated =
      corr?.latestNonce !== undefined &&
      event.submission.nonce !== undefined &&
      corr.latestNonce <= event.submission.nonce;

    return {
      class: 'STUCK_TRANSACTION',
      ruleId: 'R1',
      severity: 'warning',
      confidence: corroborated ? 0.95 : 0.6,
      eventIds: [event.id],
      facts: {
        nonce: event.submission.nonce ?? null,
        txHash: event.submission.txHash ?? null,
        submittedMaxFeePerGas: event.submission.maxFeePerGas?.toString() ?? null,
        currentBaseFee: corr?.baseFeeAtDetection?.toString() ?? null,
        pendingDurationMs,
        stuckThresholdMs: ctx.detection.stuckThresholdMs,
        corroborated,
      },
    };
  },
};

// ── R2 · NONCE_GAP ──────────────────────────────────────────────────────────

/**
 * Find nonces this signer has submitted at but which are missing beneath its
 * highest unconfirmed submission.
 *
 * **This cannot be derived from `pendingNonce - latestNonce`.** That was the
 * original design and it is wrong against real nodes: a transaction whose
 * nonce is not yet executable sits in the queued set rather than the pending
 * set, so `eth_getTransactionCount(pending)` does not count it. During a
 * genuine gap the two counts are *equal*, and the difference only becomes
 * positive once the hole is filled and the queue drains — the moment the
 * incident ends. Verified against Sepolia: with nonce 37 missing and 38
 * submitted, the node reported latest 37, pending 37.
 *
 * The gap is therefore derived from what Blackbox knows was submitted, using
 * the confirmed count only as the floor.
 */
export function findNonceGap(
  window: readonly ExecutionEvent[],
  latestNonce: number,
): { missingNonces: number[]; unresolved: ExecutionEvent[]; highestSubmitted: number | null } {
  const unresolved = window.filter(
    (e) =>
      e.submission.nonce !== undefined &&
      e.submission.nonce >= latestNonce &&
      !isTerminal(e),
  );
  if (unresolved.length === 0) {
    return { missingNonces: [], unresolved: [], highestSubmitted: null };
  }

  const submitted = new Set(
    window
      .map((e) => e.submission.nonce)
      .filter((n): n is number => n !== undefined && n >= latestNonce),
  );
  const highestSubmitted = Math.max(...submitted);

  const missingNonces: number[] = [];
  for (let n = latestNonce; n < highestSubmitted; n++) {
    if (!submitted.has(n)) missingNonces.push(n);
  }
  return { missingNonces, unresolved, highestSubmitted };
}

export const R2: Rule = {
  id: 'R2',
  evaluate(window, ctx) {
    const corr = ctx.corroboration;
    if (corr?.latestNonce === undefined) return null;

    const { missingNonces, unresolved, highestSubmitted } = findNonceGap(window, corr.latestNonce);
    if (missingNonces.length === 0) return null;

    // A gap seen once is just a transaction in flight. It means something only
    // once it persists.
    if ((corr.consecutiveGapPolls ?? 0) < ctx.detection.nonceGapConfirmations) return null;

    return {
      class: 'NONCE_GAP',
      ruleId: 'R2',
      // A gap wedges every later transaction from this signer.
      severity: 'critical',
      confidence: 0.9,
      eventIds: unresolved.map((e) => e.id),
      facts: {
        latestNonce: corr.latestNonce,
        pendingNonce: corr.pendingNonce ?? null,
        highestSubmittedNonce: highestSubmitted,
        missingNonces,
        gap: missingNonces.length,
        blockedActionCount: unresolved.length,
        consecutiveGapPolls: corr.consecutiveGapPolls ?? 0,
        nonceGapConfirmations: ctx.detection.nonceGapConfirmations,
      },
    };
  },
};

// ── R3 · GAS_UNDERPRICED ────────────────────────────────────────────────────

export const R3: Rule = {
  id: 'R3',
  evaluate(window, ctx) {
    const baseFee = ctx.corroboration?.baseFeeAtDetection;
    if (baseFee === undefined) return null;

    // Base fee is sampled now, not at submission: the question is whether the
    // bid is below the market as it stands, not as it stood.
    const threshold = BigInt(Math.round(Number(baseFee) * ctx.detection.underpriceRatio));

    const event = latestBySubmission(window).find(
      (e) =>
        (e.outcome.status === 'pending' || e.outcome.status === 'dropped') &&
        e.submission.maxFeePerGas !== undefined &&
        e.submission.maxFeePerGas < threshold,
    );
    if (!event) return null;

    const maxFee = event.submission.maxFeePerGas!;
    const deficitPct = Number(((threshold - maxFee) * 10_000n) / threshold) / 100;

    return {
      class: 'GAS_UNDERPRICED',
      ruleId: 'R3',
      severity: 'warning',
      confidence: 0.9,
      eventIds: [event.id],
      facts: {
        nonce: event.submission.nonce ?? null,
        submittedMaxFee: maxFee.toString(),
        submittedPriorityFee: event.submission.maxPriorityFeePerGas?.toString() ?? null,
        baseFeeAtDetection: baseFee.toString(),
        underpriceRatio: ctx.detection.underpriceRatio,
        thresholdFee: threshold.toString(),
        feeDeficitPct: deficitPct,
      },
    };
  },
};

// ── R4 · SIM_PASS_EXEC_REVERT ───────────────────────────────────────────────

export const R4: Rule = {
  id: 'R4',
  evaluate(window) {
    // The highest-value class: the world changed between simulation and
    // inclusion. KeeperHub pre-flights and refuses to submit calls it expects
    // to revert, so a revert that got onchain is genuine state drift by
    // construction — which is exactly why simulation.success must be strictly
    // true here, never merely truthy or unknown.
    const event = [...window]
      .reverse()
      .find(
        (e) =>
          e.simulation.performed &&
          e.simulation.success === true &&
          e.outcome.status === 'reverted',
      );
    if (!event) return null;

    const simulatedAt = event.simulation.simulatedAtBlock;
    const includedAt = event.outcome.blockNumber;
    const blockDrift =
      simulatedAt !== undefined && includedAt !== undefined ? includedAt - simulatedAt : null;

    return {
      class: 'SIM_PASS_EXEC_REVERT',
      ruleId: 'R4',
      severity: 'critical',
      confidence: 0.95,
      eventIds: [event.id],
      facts: {
        txHash: event.submission.txHash ?? null,
        revertReason: event.outcome.revertReason ?? null,
        simulatedAtBlock: simulatedAt ?? null,
        includedAtBlock: includedAt ?? null,
        blockDrift,
        gasEstimate: event.simulation.gasEstimate?.toString() ?? null,
        gasUsed: event.outcome.gasUsed?.toString() ?? null,
        elapsedMs: event.outcome.observedAt
          ? event.outcome.observedAt.getTime() - event.submission.submittedAt.getTime()
          : null,
      },
    };
  },
};

// ── R5 · RETRY_STORM ────────────────────────────────────────────────────────

export const R5: Rule = {
  id: 'R5',
  evaluate(window, ctx) {
    const cutoff = ctx.now.getTime() - ctx.detection.retryStormWindowMs;
    const byAction = new Map<string, ExecutionEvent[]>();
    for (const e of window) {
      if (e.submission.submittedAt.getTime() < cutoff) continue;
      if (!isFailed(e)) continue;
      const list = byAction.get(e.logicalActionId) ?? [];
      list.push(e);
      byAction.set(e.logicalActionId, list);
    }

    for (const [logicalActionId, attempts] of byAction) {
      if (attempts.length < ctx.detection.retryStormCount) continue;

      const totalGasBurned = attempts.reduce(
        (sum, e) => sum + (e.outcome.gasUsed ?? 0n) * (e.outcome.effectiveGasPrice ?? 0n),
        0n,
      );
      const reasons = [
        ...new Set(
          attempts
            .map((e) => e.outcome.revertReason ?? e.simulation.revertReason)
            .filter((r): r is string => Boolean(r)),
        ),
      ];

      return {
        class: 'RETRY_STORM',
        ruleId: 'R5',
        severity: 'critical',
        confidence: 0.9,
        eventIds: attempts.map((e) => e.id),
        facts: {
          logicalActionId,
          attemptCount: attempts.length,
          retryStormCount: ctx.detection.retryStormCount,
          windowMs: ctx.detection.retryStormWindowMs,
          totalGasBurned: totalGasBurned.toString(),
          distinctRevertReasons: reasons,
          // Pre-flight rejections cost nothing, so a storm made only of these
          // wastes API calls rather than money. The remediation is the same —
          // stop — but the framing in the RCA should differ.
          allRejectedPreflight: attempts.every((e) => e.outcome.status === 'rejected'),
        },
      };
    }
    return null;
  },
};

// ── R6 · SIGNER_GAS_STARVED ─────────────────────────────────────────────────

export const R6: Rule = {
  id: 'R6',
  evaluate(window, ctx) {
    const balance = ctx.corroboration?.signerBalance;
    if (balance === undefined) return null;

    const costs = window
      .filter((e) => e.outcome.gasUsed !== undefined && e.outcome.effectiveGasPrice !== undefined)
      .map((e) => e.outcome.gasUsed! * e.outcome.effectiveGasPrice!);
    const medianRecentCost = median(costs);
    if (medianRecentCost === undefined || medianRecentCost === 0n) return null;

    const threshold =
      medianRecentCost * BigInt(Math.max(1, Math.round(ctx.detection.gasStarvedMultiple)));
    if (balance >= threshold) return null;

    // Warning while predicted; critical once an action has actually failed for
    // want of funds.
    const hasFundingFailure = window.some((e) =>
      /insufficient funds/i.test(
        `${e.outcome.revertReason ?? ''} ${e.simulation.revertReason ?? ''}`,
      ),
    );

    return {
      class: 'SIGNER_GAS_STARVED',
      ruleId: 'R6',
      severity: hasFundingFailure ? 'critical' : 'warning',
      confidence: hasFundingFailure ? 0.95 : 0.8,
      eventIds: window.slice(-1).map((e) => e.id),
      facts: {
        signerBalance: balance.toString(),
        medianRecentCost: medianRecentCost.toString(),
        gasStarvedMultiple: ctx.detection.gasStarvedMultiple,
        thresholdBalance: threshold.toString(),
        projectedActionsRemaining: Number(balance / medianRecentCost),
        observedFundingFailure: hasFundingFailure,
      },
    };
  },
};

// ── R7 · ADVERSE_INCLUSION ──────────────────────────────────────────────────

export const R7: Rule = {
  id: 'R7',
  evaluate(window, ctx) {
    const analysis = ctx.inclusion;
    if (!analysis) return null;
    if (analysis.expectedOut === 0n) return null;

    const event = [...window]
      .reverse()
      .find(
        (e) =>
          e.submission.route === 'public' && e.outcome.blockNumber === analysis.blockNumber,
      );
    if (!event) return null;

    const deltaBps = Number(
      ((analysis.expectedOut - analysis.actualOut) * 10_000n) / analysis.expectedOut,
    );
    // Only adverse movement counts. Coming out ahead is not an incident.
    if (deltaBps <= ctx.detection.slippageToleranceBps) return null;
    if (analysis.neighbouringTxHashes.length === 0) return null;

    return {
      class: 'ADVERSE_INCLUSION',
      ruleId: 'R7',
      severity: 'warning',
      // Deliberately capped below R4/R2. Positional evidence is suggestive, not
      // proof: claiming "sandwiched" with certainty is how a detector loses
      // credibility. The RCA must present this as adverse inclusion with the
      // evidence shown, and let the reader draw the conclusion.
      confidence: 0.65,
      eventIds: [event.id],
      facts: {
        expectedOut: analysis.expectedOut.toString(),
        actualOut: analysis.actualOut.toString(),
        deltaBps,
        slippageToleranceBps: ctx.detection.slippageToleranceBps,
        blockNumber: analysis.blockNumber,
        txIndexInBlock: analysis.txIndexInBlock,
        neighbouringTxHashes: analysis.neighbouringTxHashes,
        route: event.submission.route,
      },
    };
  },
};

export const ALL_RULES: readonly Rule[] = [R1, R2, R3, R4, R5, R6, R7];

export type { IncidentDraft, RuleContext };
