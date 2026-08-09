import type { ExecutionEvent, RuleId } from '@blackbox/core';
import { ALL_RULES } from './rules.js';
import type { IncidentDraft, Rule, RuleContext } from './types.js';

export * from './types.js';
export * from './rules.js';

export type EvaluatedDraft = IncidentDraft & {
  /** Rules that fired but were subsumed by this one. */
  suppressedRules?: RuleId[];
};

/**
 * Rules that are more specific than another rule for the same underlying
 * condition. When both fire, the specific one wins and the general one is
 * recorded as suppressed rather than discarded, so the timeline still shows
 * every signal that contributed.
 *
 * R3 says "stuck *because* the bid is below the market"; R1 only says "stuck".
 * Emitting both would double-count one problem and, worse, could trigger two
 * remediations against one signer.
 */
const SUPPRESSES: ReadonlyArray<{ specific: RuleId; general: RuleId }> = [
  { specific: 'R3', general: 'R1' },
];

export function evaluateRules(
  window: readonly ExecutionEvent[],
  ctx: RuleContext,
  rules: readonly Rule[] = ALL_RULES,
): EvaluatedDraft[] {
  const fired = new Map<RuleId, IncidentDraft>();
  for (const rule of rules) {
    const draft = rule.evaluate(window, ctx);
    if (draft) fired.set(rule.id, draft);
  }

  const suppressed = new Map<RuleId, RuleId>();
  for (const { specific, general } of SUPPRESSES) {
    if (fired.has(specific) && fired.has(general)) {
      suppressed.set(general, specific);
    }
  }

  const results: EvaluatedDraft[] = [];
  for (const [ruleId, draft] of fired) {
    if (suppressed.has(ruleId)) continue;
    const absorbed = [...suppressed.entries()]
      .filter(([, winner]) => winner === ruleId)
      .map(([loser]) => loser);
    results.push(absorbed.length > 0 ? { ...draft, suppressedRules: absorbed } : draft);
  }

  // Most severe first, then most confident: the console renders this order and
  // the remediator should consider the worst problem first.
  const severityRank = { critical: 0, warning: 1, info: 2 } as const;
  return results.sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity] || b.confidence - a.confidence,
  );
}
