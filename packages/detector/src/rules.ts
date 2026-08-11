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
  /**
   * A managed wallet can be slow, but not *stuck* in the sense this rule means.
   * Its evidence is a nonce that has not advanced past a pending submission,
   * and a KeeperHub run carries no nonce of the agent's own — the pending it
   * reports is "the workflow has not finished", which is a different claim.
   * That one belongs to EXECUTION_STALLED, planned as R9.
   */
  appliesTo: ['signer'],
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
  // KeeperHub owns nonce management, so a managed wallet has no queue of its
  // own to gap. The recorder does not even gather the reading — see
  // `corroboration.managedNonces`.
  appliesTo: ['signer'],
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
  /**
   * KeeperHub chooses the fee, so an underpriced bid there is the platform's
   * mistake rather than the operator's — but it is still the operator's
   * transaction sitting unmined, and worth saying so. Requires a submitted
   * `maxFeePerGas`, which only reaches us for a managed wallet once fees are
   * read back from the chain.
   */
  appliesTo: ['signer', 'keeperhub'],
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
  // The strongest rule for a managed wallet: KeeperHub pre-flights every write
  // and refuses what it expects to revert, so a revert that reached a block is
  // state drift by construction rather than by inference.
  appliesTo: ['signer', 'keeperhub'],
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
  // Repeated failure of one action is agnostic to who holds the key.
  appliesTo: ['signer', 'keeperhub'],
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
  /**
   * A managed wallet does not pay its own gas — KeeperHub sponsors execution,
   * which is why its runs come back `sponsored: true`. The balance this rule
   * reads is not what funds the agent, so running out of it is not what stops
   * the agent working. The equivalent signal there is the organisation's spend
   * cap, planned as R8.
   */
  appliesTo: ['signer'],
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
  // Positional evidence about a block, which says nothing about who signed.
  // Cannot fire for either kind today: nothing populates `ctx.inclusion`.
  appliesTo: ['signer', 'keeperhub'],
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


// ── R8 · SPEND_CAP_EXHAUSTED ────────────────────────────────────────────────

/**
 * The managed-wallet equivalent of running out of gas.
 *
 * A KeeperHub organisation has a daily execution budget it sponsors from. When
 * that budget is spent, every subsequent execution fails for a reason no chain
 * read explains — the transactions simply stop being submitted. An operator
 * watching the chain sees nothing at all, which is the worst kind of outage:
 * silent.
 *
 * It warns before the cliff rather than at it. At 100% the agent has already
 * stopped working, and an alert that arrives then is a post-mortem.
 */
export const R8: Rule = {
  id: 'R8',
  // A signer-kind agent pays its own gas; SIGNER_GAS_STARVED is its version of
  // this, and reads a balance rather than someone else's budget.
  appliesTo: ['keeperhub'],
  evaluate(_window, ctx) {
    const cap = ctx.corroboration?.spendCap;
    // No cap configured is not a cap of zero. It means the question does not
    // apply to this organisation, and answering it anyway would report an
    // outage that cannot happen.
    if (!cap || cap.dailyCapWei === null || cap.dailyCapWei === 0n) return null;

    const ratio = Number((cap.dailyUsedWei * 10_000n) / cap.dailyCapWei) / 10_000;
    if (ratio < ctx.detection.spendCapWarnRatio) return null;

    const exhausted = cap.dailyUsedWei >= cap.dailyCapWei;
    return {
      class: 'SPEND_CAP_EXHAUSTED',
      ruleId: 'R8',
      // Exhausted means the agent has stopped. Approaching means it will.
      severity: exhausted ? 'critical' : 'warning',
      confidence: 0.95,
      // Reported by the platform rather than derived from events, so there is
      // no event to cite. Saying so beats citing an unrelated one.
      eventIds: [],
      facts: {
        dailyCapWei: cap.dailyCapWei.toString(),
        dailyUsedWei: cap.dailyUsedWei.toString(),
        remainingWei: (cap.dailyCapWei - cap.dailyUsedWei).toString(),
        usedRatio: Math.round(ratio * 1000) / 1000,
        warnRatio: ctx.detection.spendCapWarnRatio,
        exhausted,
      },
    };
  },
};

// ── R9 · EXECUTION_STALLED ──────────────────────────────────────────────────

/**
 * A workflow that started and never finished.
 *
 * Chain scanning cannot see this, because a stalled run may have produced no
 * transaction at all — it can hang on a condition, a wait, or a step that never
 * returns. STUCK_TRANSACTION is the version of this for something that reached
 * a mempool; this one is for work that never got that far.
 *
 * The threshold is much longer than the stuck one on purpose: a multi-step
 * workflow legitimately takes minutes, and calling that stalled would make the
 * rule a nuisance rather than a signal.
 */
export const R9: Rule = {
  id: 'R9',
  appliesTo: ['keeperhub'],
  evaluate(window, ctx) {
    const stalled = latestBySubmission(window).filter(
      (e) =>
        e.outcome.status === 'pending' &&
        ctx.now.getTime() - e.submission.submittedAt.getTime() > ctx.detection.executionStalledMs &&
        // A later attempt of the same action reaching a terminal state means the
        // work completed; only the record of this attempt is stale.
        !window.some((other) => other.logicalActionId === e.logicalActionId && isTerminal(other)),
    );
    const event = stalled[0];
    if (!event) return null;

    const detail = event.trigger.detail ?? {};
    const stalledMs = ctx.now.getTime() - event.submission.submittedAt.getTime();
    return {
      class: 'EXECUTION_STALLED',
      ruleId: 'R9',
      // Nothing is burning, but the agent has silently stopped doing its job.
      severity: 'warning',
      confidence: 0.9,
      eventIds: [event.id],
      facts: {
        workflowId: detail['workflowId'] ?? null,
        workflowName: detail['workflowName'] ?? null,
        stalledMs,
        executionStalledMs: ctx.detection.executionStalledMs,
        completedSteps: detail['completedSteps'] ?? null,
        // Present when a transaction was submitted and the run still did not
        // finish, which points at confirmation rather than at the workflow.
        txHash: event.submission.txHash ?? null,
      },
    };
  },
};

// ── R10 · WORKFLOW_MISCONFIGURED ────────────────────────────────────────────

/**
 * A workflow that is broken rather than unlucky.
 *
 * The distinction that matters to whoever has to fix it: repeated failures that
 * never reached the chain are a definition problem — a bad address, a wrong
 * ABI, an argument that cannot be satisfied — and no amount of retrying will
 * help. RETRY_STORM says "this keeps failing"; this says "and it will keep
 * failing until you change it", which is a different instruction.
 *
 * Requires every counted failure to be a pre-flight rejection, so a workflow
 * failing because the chain moved is not accused of being misconfigured. It
 * suppresses RETRY_STORM when both fire, being the more specific of the two.
 */
export const R10: Rule = {
  id: 'R10',
  appliesTo: ['keeperhub'],
  evaluate(window, ctx) {
    const cutoff = ctx.now.getTime() - ctx.detection.retryStormWindowMs;
    const byWorkflow = new Map<string, ExecutionEvent[]>();
    for (const e of window) {
      if (e.submission.submittedAt.getTime() < cutoff) continue;
      // Rejected means KeeperHub refused to submit it: no gas spent, no block
      // involved, nothing about the chain to blame.
      if (e.outcome.status !== 'rejected') continue;
      const workflowId = e.workflowId;
      if (!workflowId) continue;
      const list = byWorkflow.get(workflowId) ?? [];
      list.push(e);
      byWorkflow.set(workflowId, list);
    }

    for (const [workflowId, failures] of byWorkflow) {
      if (failures.length < ctx.detection.workflowNodeFailures) continue;

      const steps = new Set(
        failures.map((e) => e.trigger.detail?.['completedSteps']).filter((s) => s !== undefined),
      );
      const reasons = [
        ...new Set(
          failures
            .map((e) => e.simulation.revertReason ?? e.outcome.revertReason)
            .filter((r): r is string => Boolean(r)),
        ),
      ];

      return {
        class: 'WORKFLOW_MISCONFIGURED',
        ruleId: 'R10',
        severity: 'critical',
        // Failing at the same step every time is a definition problem; failing
        // at different steps is the same conclusion held less firmly.
        confidence: steps.size === 1 ? 0.9 : 0.75,
        eventIds: failures.map((e) => e.id),
        facts: {
          workflowId,
          workflowName: failures[0]?.trigger.detail?.['workflowName'] ?? null,
          failureCount: failures.length,
          workflowNodeFailures: ctx.detection.workflowNodeFailures,
          windowMs: ctx.detection.retryStormWindowMs,
          // The step it stopped at, when every failure agrees on one.
          failingAfterSteps: steps.size === 1 ? [...steps][0] : null,
          distinctFailingSteps: steps.size,
          distinctReasons: reasons,
          errorTypes: [
            ...new Set(
              failures.map((e) => e.trigger.detail?.['errorType']).filter((t) => t !== undefined),
            ),
          ],
        },
      };
    }
    return null;
  },
};

export const ALL_RULES: readonly Rule[] = [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10];

export type { IncidentDraft, RuleContext };
