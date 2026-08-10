import type { Incident, RootCauseAnalysis } from '@blackbox/core';

/**
 * Deterministic root cause analysis, written from the evidence alone.
 *
 * This is not a placeholder. It is the floor the product stands on: every rule
 * already knows exactly why it fired, so an incident always has a real
 * explanation available without asking a model anything. The LLM's job is to
 * write a *better* one, and when it cannot — no credentials, rate limited,
 * malformed output — the operator still gets the mechanism, the numbers, and
 * what to do about it.
 *
 * The PRD's requirement is that the UI is never empty. The stronger version
 * observed here is that the UI is never *thin*: a template that said "an
 * incident occurred" would satisfy the letter of that and be worthless at 3am.
 */

const fact = (incident: Incident, key: string): unknown => incident.evidence.facts[key];

const gwei = (wei: unknown): string => {
  if (wei === undefined || wei === null) return 'unknown';
  try {
    const value = BigInt(String(wei));
    const whole = value / 1_000_000_000n;
    const frac = (value % 1_000_000_000n).toString().padStart(9, '0').slice(0, 3);
    return `${whole}.${frac} gwei`;
  } catch {
    return String(wei);
  }
};

const eth = (wei: unknown): string => {
  if (wei === undefined || wei === null) return 'unknown';
  try {
    const value = BigInt(String(wei));
    const whole = value / 10n ** 18n;
    const frac = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
    return `${whole}.${frac} ETH`;
  } catch {
    return String(wei);
  }
};

const duration = (ms: unknown): string => {
  const value = Number(ms);
  if (!Number.isFinite(value)) return 'an unknown time';
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
};

type Written = { summary: string; contributingFactors: string[]; recommendation: string };

function write(incident: Incident): Written {
  switch (incident.class) {
    case 'NONCE_GAP': {
      const missing = fact(incident, 'missingNonces');
      const list = Array.isArray(missing) ? missing.join(', ') : 'unknown';
      const blocked = fact(incident, 'blockedActionCount');
      return {
        summary:
          `Nonce ${list} was never used, while a later transaction was submitted at ` +
          `${String(fact(incident, 'highestSubmittedNonce') ?? 'a higher nonce')}. Ethereum executes ` +
          `an account's transactions strictly in order, so nothing above the hole can be mined ` +
          `until it is filled. ${blocked ?? 'Some'} action(s) are wedged behind it.`,
        contributingFactors: [
          'A transaction was prepared at the missing nonce and never broadcast, or was dropped from the pool',
          'Submissions are not reconciled against the chain, so the gap persisted unnoticed',
          `The gap survived ${String(fact(incident, 'consecutiveGapPolls') ?? 'several')} consecutive observations`,
        ],
        recommendation:
          'Read the pending nonce immediately before signing, and reconcile submitted nonces ' +
          'against the chain after every batch. Fill the lowest missing nonce to unblock the queue.',
      };
    }

    case 'STUCK_TRANSACTION':
      return {
        summary:
          `A transaction at nonce ${String(fact(incident, 'nonce') ?? 'unknown')} has been pending for ` +
          `${duration(fact(incident, 'pendingForMs'))}, well past the threshold for this chain. It was ` +
          `submitted at ${gwei(fact(incident, 'submittedMaxFee'))} and has not been included.`,
        contributingFactors: [
          'The bid is no longer competitive, or the transaction is queued behind an earlier one',
          'No replacement was submitted while it sat',
        ],
        recommendation:
          'Replace it at the same nonce with a fee at least 12.5% above the original, priced ' +
          'against the current base fee rather than the fee at submission.',
      };

    case 'GAS_UNDERPRICED':
      return {
        summary:
          `The transaction bid ${gwei(fact(incident, 'submittedMaxFee'))} and the base fee has since ` +
          `risen to ${gwei(incident.evidence.corroboration?.baseFeeAtDetection)}. The bid was ` +
          'plausible when it was made and the market moved above it.',
        contributingFactors: [
          'Fees were chosen at submission and never revisited',
          'No ceiling or re-pricing loop is watching pending transactions',
        ],
        recommendation:
          'Re-price against the base fee at the time of the decision, not the time of submission, ' +
          'and replace transactions whose bid falls below the market while pending.',
      };

    case 'SIM_PASS_EXEC_REVERT': {
      const drift = fact(incident, 'blockDrift');
      return {
        summary:
          `The call simulated successfully at block ${String(fact(incident, 'simulatedAtBlock') ?? 'unknown')} ` +
          `and reverted when it executed at block ${String(fact(incident, 'includedAtBlock') ?? 'unknown')}` +
          `${drift !== undefined && drift !== null ? `, ${drift} block(s) later` : ''}. ` +
          'Nothing about the call changed; the chain state underneath it did.' +
          (fact(incident, 'revertReason') ? ` Reason: ${String(fact(incident, 'revertReason'))}.` : ''),
        contributingFactors: [
          'State the call depends on was modified between simulation and inclusion',
          'The simulation result was treated as valid for longer than one block',
        ],
        recommendation:
          'Re-simulate immediately before submission, and make the call defend its own ' +
          'preconditions on chain — a deadline, an expected-state check, or a slippage bound — ' +
          'so a stale assumption fails cheaply rather than reverting after paying gas.',
      };
    }

    case 'RETRY_STORM':
      return {
        summary:
          `${String(fact(incident, 'attemptCount') ?? 'Several')} attempts at the same action failed ` +
          `within ${duration(fact(incident, 'windowMs'))}, burning ` +
          `${eth(fact(incident, 'totalGasBurned'))} in gas. Retrying has not changed the outcome, ` +
          'which means the failure is not transient.',
        contributingFactors: [
          'Retries are unconditional rather than conditional on the failure being retryable',
          'No circuit breaker halts the action after repeated identical failures',
        ],
        recommendation:
          'Stop retrying on a deterministic revert. Classify the failure first, back off ' +
          'exponentially for transient errors only, and halt the agent after a small number of ' +
          'identical failures.',
      };

    case 'SIGNER_GAS_STARVED':
      return {
        summary:
          `The signer holds ${eth(fact(incident, 'signerBalance'))}, against a recent median action ` +
          `cost of ${eth(fact(incident, 'medianRecentCost'))} — roughly ` +
          `${String(fact(incident, 'runwayActions') ?? 'no')} further actions of runway.`,
        contributingFactors: [
          'No balance floor triggers a top-up before the signer runs out',
          'Spend rate was not tracked against remaining balance',
        ],
        recommendation:
          'Set a runway floor in actions rather than in ETH, and top up automatically from a ' +
          'funding wallet when it is breached.',
      };

    case 'ADVERSE_INCLUSION':
      return {
        summary:
          `The transaction executed at a materially worse price than quoted ` +
          `(${String(fact(incident, 'slippageBps') ?? 'unknown')} bps against expectation). It landed, ` +
          'but not on the terms it was submitted on.',
        contributingFactors: [
          'The transaction was submitted publicly, where its intent is visible before inclusion',
          'No slippage bound made the bad execution fail instead of succeed',
        ],
        recommendation:
          'Submit through a private route where one exists on this chain, and bound acceptable ' +
          'execution in the call itself so an adverse price reverts rather than fills.',
      };

    default:
      return {
        summary: `${incident.class} detected by ${incident.evidence.ruleId}.`,
        contributingFactors: [],
        recommendation: 'Review the evidence panel for the facts that tripped the rule.',
      };
  }
}

/**
 * Build the fallback analysis. `generatedAt` is injected so the result is
 * deterministic and testable.
 */
export function templateRca(incident: Incident, now: Date, promptVersion: string): RootCauseAnalysis {
  const written = write(incident);
  return {
    summary: written.summary,
    contributingFactors: written.contributingFactors,
    timeline: [
      { at: incident.firstEventAt, what: 'First related execution observed' },
      {
        at: incident.detectedAt,
        what: `${incident.evidence.ruleId} fired, classifying this as ${incident.class} at confidence ${incident.confidence}`,
      },
      ...(incident.resolvedAt ? [{ at: incident.resolvedAt, what: 'Incident resolved' }] : []),
    ],
    recommendation: written.recommendation,
    // Named so nobody mistakes a template for model output in the UI or the API.
    model: 'template',
    generatedAt: now,
    promptVersion,
  };
}
