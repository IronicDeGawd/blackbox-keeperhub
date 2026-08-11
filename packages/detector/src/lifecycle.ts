import type { ExecutionEvent, Incident, IncidentClass } from '@blackbox/core';
import { findNonceGap } from './rules.js';
import { isTerminal, type Corroboration, type RuleContext } from './types.js';
import type { EvaluatedDraft } from './index.js';

/**
 * Incidents are not emitted per event. A rule firing on three consecutive polls
 * for the same wedged nonce is one incident with three pieces of evidence, not
 * three incidents — and it must remain one, because the remediator acts per
 * incident and spends real gas doing it.
 */

export type IncidentKey = string;

export const incidentKey = (
  agentId: string,
  signer: string,
  chainId: number,
  cls: IncidentClass,
): IncidentKey => `${agentId}|${signer.toLowerCase()}|${chainId}|${cls}`;

/** Who ended the incident. Recorded separately from whether it ended. */
export type Attribution = 'blackbox' | 'blackbox-proposed' | 'external' | 'unknown';

export type TrackedIncident = Incident & {
  key: IncidentKey;
  /** Last time a rule re-confirmed this incident; drives the causal window. */
  lastSeenAt: Date;
  resolvedBy?: Attribution;
};

export type TrackerOptions = {
  makeId: () => string;
  /**
   * How long an open incident keeps absorbing matching drafts. A draft arriving
   * after this becomes a new incident, because the old problem is presumed to
   * be a different occurrence rather than the same one still running.
   */
  causalWindowMs?: number;
};

export type IngestResult = {
  created: TrackedIncident[];
  updated: TrackedIncident[];
  resolved: TrackedIncident[];
};

const DEFAULT_CAUSAL_WINDOW_MS = 15 * 60_000;

export class IncidentTracker {
  private readonly open = new Map<IncidentKey, TrackedIncident>();
  private readonly makeId: () => string;
  private readonly causalWindowMs: number;

  constructor(options: TrackerOptions) {
    this.makeId = options.makeId;
    this.causalWindowMs = options.causalWindowMs ?? DEFAULT_CAUSAL_WINDOW_MS;
  }

  openIncidents(): TrackedIncident[] {
    return [...this.open.values()];
  }

  /**
   * Restore the open set from what was already persisted.
   *
   * Without this the tracker starts empty on every boot, and the first
   * evaluation after a restart cannot see that an incident for this key is
   * already open — so it files a second one for a condition that never went
   * away. A deployment that restarts three times ends up showing the same
   * problem three times, which is how this was found.
   *
   * Incidents already in the open set are left alone: a running tracker's own
   * state is more current than the row it wrote.
   */
  hydrate(incidents: readonly (Incident & { key?: string })[], now: Date): number {
    let restored = 0;
    for (const incident of incidents) {
      if (incident.status === 'resolved') continue;
      const key =
        incident.key ??
        incidentKey(incident.agentId, incident.signer, incident.chainId, incident.class);
      if (this.open.has(key)) continue;
      this.open.set(key, {
        ...incident,
        key,
        /**
         * Counted as re-confirmed at the moment of restore, not at whatever
         * the stored `lastSeenAt` says.
         *
         * The causal window exists to tell two *occurrences* apart: a rule
         * stopped firing, then started again. Downtime looks identical from
         * the outside, and treating it as a lapse means any restart more than
         * fifteen minutes after the last evaluation replaces every open
         * incident with a fresh copy — which is the duplication this whole
         * method exists to prevent. A condition that has genuinely gone away
         * resolves on the first evaluation instead, which is the honest test.
         */
        lastSeenAt: now,
      } as TrackedIncident);
      restored += 1;
    }
    return restored;
  }

  get(key: IncidentKey): TrackedIncident | undefined {
    return this.open.get(key);
  }

  /**
   * Record what the remediator did to an incident this tracker is holding.
   *
   * Without this the tracker never learns that Blackbox acted, and a gap that
   * Blackbox itself filled resolves as `external` — the product understating
   * its own work, which is the one direction the attribution must never err in.
   *
   * Returns false when the incident is no longer open, so a caller can tell the
   * difference between "recorded" and "silently dropped".
   */
  attachRemediation(incidentId: string, remediation: Incident['remediation']): boolean {
    for (const incident of this.open.values()) {
      if (incident.id === incidentId) {
        incident.remediation = remediation;
        return true;
      }
    }
    return false;
  }

  /**
   * Fold this evaluation's drafts into the open set, then test every open
   * incident for resolution.
   *
   * Resolution is checked for all open incidents, not only those whose rule
   * fired this round — an incident that stopped firing is exactly the one most
   * likely to have resolved.
   */
  ingest(
    drafts: readonly EvaluatedDraft[],
    window: readonly ExecutionEvent[],
    ctx: RuleContext,
  ): IngestResult {
    const created: TrackedIncident[] = [];
    const updated: TrackedIncident[] = [];
    /** Closed because a fresh occurrence replaced them; still need persisting. */
    const superseded: TrackedIncident[] = [];
    /** Keys a rule confirmed this evaluation. */
    const firedThisRound = new Set<IncidentKey>();

    for (const draft of drafts) {
      const key = incidentKey(ctx.agentId, ctx.signer, ctx.chainId, draft.class);
      firedThisRound.add(key);
      const existing = this.open.get(key);
      const withinWindow =
        existing !== undefined &&
        ctx.now.getTime() - existing.lastSeenAt.getTime() <= this.causalWindowMs;

      if (existing && withinWindow) {
        updated.push(this.append(existing, draft, ctx));
        continue;
      }
      if (existing && !withinWindow) {
        // Stale and no longer being re-confirmed: close it as unresolved
        // observation and start a fresh incident, so the two occurrences stay
        // distinguishable in the timeline.
        //
        // Reported as resolved rather than merely dropped from the open set:
        // the caller is what persists a status, so closing it only in memory
        // left the stored row `open` for ever with nothing left to close it.
        this.finish(existing, ctx.now, 'unknown', 'resolved');
        superseded.push(existing);
      }
      const incident = this.create(draft, ctx, key);
      this.open.set(key, incident);
      created.push(incident);
    }

    const resolved: TrackedIncident[] = [...superseded];
    for (const incident of [...this.open.values()]) {
      if (incident.status === 'remediating' || incident.status === 'diagnosing') continue;
      // A rule asserted this condition holds moments ago. Resolving it in the
      // same breath is self-contradictory, and if a resolution predicate ever
      // disagrees with its rule the result is a fresh duplicate incident every
      // poll rather than one visible bug.
      if (firedThisRound.has(incident.key)) continue;
      const attribution = resolutionOf(incident, window, ctx);
      if (!attribution) continue;
      this.finish(incident, ctx.now, attribution, 'resolved');
      resolved.push(incident);
    }

    return { created, updated, resolved };
  }

  /** Mark an incident as being worked on, so resolution checks leave it alone. */
  markStatus(key: IncidentKey, status: Incident['status']): TrackedIncident | undefined {
    const incident = this.open.get(key);
    if (!incident) return undefined;
    incident.status = status;
    return incident;
  }

  private create(draft: EvaluatedDraft, ctx: RuleContext, key: IncidentKey): TrackedIncident {
    return {
      id: this.makeId(),
      key,
      class: draft.class,
      severity: draft.severity,
      status: 'open',
      agentId: ctx.agentId,
      signer: ctx.signer,
      chainId: ctx.chainId,
      detectedAt: ctx.now,
      firstEventAt: ctx.now,
      lastSeenAt: ctx.now,
      evidence: {
        eventIds: [...draft.eventIds],
        ruleId: draft.ruleId,
        facts: draft.facts,
        ...(ctx.corroboration ? { corroboration: stripCorroboration(ctx.corroboration) } : {}),
        ...(draft.suppressedRules ? { suppressedRules: draft.suppressedRules } : {}),
      },
      confidence: draft.confidence,
    };
  }

  private append(
    incident: TrackedIncident,
    draft: EvaluatedDraft,
    ctx: RuleContext,
  ): TrackedIncident {
    const merged = new Set([...incident.evidence.eventIds, ...draft.eventIds]);
    incident.evidence.eventIds = [...merged];
    // Latest facts win: they describe the situation now, which is what a
    // remediation would act on. Earlier facts live on in the event timeline.
    incident.evidence.facts = draft.facts;
    if (ctx.corroboration) {
      incident.evidence.corroboration = stripCorroboration(ctx.corroboration);
    }
    if (draft.suppressedRules) incident.evidence.suppressedRules = draft.suppressedRules;
    // Severity and confidence ratchet upward only — a problem that looked
    // critical once should not be quietly downgraded by a later softer read.
    if (rank(draft.severity) < rank(incident.severity)) incident.severity = draft.severity;
    incident.confidence = Math.max(incident.confidence, draft.confidence);
    incident.lastSeenAt = ctx.now;
    return incident;
  }

  private finish(
    incident: TrackedIncident,
    at: Date,
    attribution: Attribution,
    status: Extract<Incident['status'], 'resolved' | 'failed'>,
  ): void {
    incident.status = status;
    incident.resolvedAt = at;
    incident.resolvedBy = attribution;
    this.open.delete(incident.key);
  }
}

const rank = (s: Incident['severity']): number =>
  ({ critical: 0, warning: 1, info: 2 })[s];

/** Corroboration carries detector bookkeeping the incident record should not. */
function stripCorroboration(c: Corroboration): NonNullable<Incident['evidence']['corroboration']> {
  return {
    ...(c.pendingNonce !== undefined ? { pendingNonce: c.pendingNonce } : {}),
    ...(c.latestNonce !== undefined ? { latestNonce: c.latestNonce } : {}),
    ...(c.signerBalance !== undefined ? { signerBalance: c.signerBalance } : {}),
    ...(c.baseFeeAtDetection !== undefined ? { baseFeeAtDetection: c.baseFeeAtDetection } : {}),
  };
}

/**
 * Class-specific resolution predicates.
 *
 * Returns the attribution when the incident is over, or null while it stands.
 * Resolution is deliberately independent of whether Blackbox acted: a stuck
 * transaction that the operator cleared by hand is just as resolved as one
 * Blackbox replaced, and pretending otherwise would leave the timeline full of
 * incidents that ended long ago.
 */
export function resolutionOf(
  incident: TrackedIncident,
  window: readonly ExecutionEvent[],
  ctx: RuleContext,
): Attribution | null {
  const corr = ctx.corroboration;
  const attribution: Attribution = attributionOf(incident);

  switch (incident.class) {
    case 'STUCK_TRANSACTION':
    case 'GAS_UNDERPRICED': {
      const nonce = incident.evidence.facts['nonce'];
      if (typeof nonce !== 'number') return null;
      const settled = window.some((e) => e.submission.nonce === nonce && isTerminal(e));
      // The nonce moving past it also settles it — a replacement landed.
      const advanced = corr?.latestNonce !== undefined && corr.latestNonce > nonce;
      return settled || advanced ? attribution : null;
    }

    case 'NONCE_GAP': {
      if (corr?.latestNonce === undefined) return null;
      // Must use the same derivation as R2. Testing `pendingNonce -
      // latestNonce <= 0` here resolved the incident on the very tick it was
      // created, because those counts are equal for as long as the gap exists
      // — so every poll produced a fresh duplicate incident that closed
      // immediately. Observed on Sepolia before this was corrected.
      const { missingNonces } = findNonceGap(window, corr.latestNonce);
      return missingNonces.length === 0 ? attribution : null;
    }

    case 'SIGNER_GAS_STARVED': {
      const threshold = incident.evidence.facts['thresholdBalance'];
      if (corr?.signerBalance === undefined || typeof threshold !== 'string') return null;
      return corr.signerBalance >= BigInt(threshold) ? attribution : null;
    }

    case 'RETRY_STORM': {
      const logicalActionId = incident.evidence.facts['logicalActionId'];
      if (typeof logicalActionId !== 'string') return null;
      // Resolved once the storm stops: no attempt for that action inside the
      // current retry window. Either something halted it or it ran its course.
      const cutoff = ctx.now.getTime() - ctx.detection.retryStormWindowMs;
      const stillStorming = window.some(
        (e) =>
          e.logicalActionId === logicalActionId && e.submission.submittedAt.getTime() >= cutoff,
      );
      return stillStorming ? null : attribution;
    }

    case 'SIM_PASS_EXEC_REVERT': {
      // Resolved when a later attempt at the same action finally lands.
      const eventId = incident.evidence.eventIds[0];
      const failed = window.find((e) => e.id === eventId);
      if (!failed) return null;
      const laterSuccess = window.some(
        (e) =>
          e.logicalActionId === failed.logicalActionId &&
          e.outcome.status === 'included' &&
          e.submission.submittedAt.getTime() > failed.submission.submittedAt.getTime(),
      );
      return laterSuccess ? attribution : null;
    }

    case 'ADVERSE_INCLUSION':
      // A point-in-time observation about a transaction that already landed.
      // Nothing on chain will retract it, so it stays open until a human
      // acknowledges it or a reroute records a remediation. Auto-resolving
      // would erase the only record that it happened.
      return incident.remediation?.finalStatus === 'succeeded' ? attributionOf(incident) : null;

    default:
      return null;
  }
}

/**
 * Who actually fixed it.
 *
 * A remediation Blackbox planned and a human's wallet signed is not the same
 * claim as one Blackbox performed unattended, and the difference is the whole
 * value of this field. Overstating it here would make every "resolved by
 * blackbox" in the UI less believable.
 */
function attributionOf(incident: TrackedIncident): Attribution {
  if (incident.remediation?.finalStatus !== 'succeeded') return 'external';
  const executor = incident.remediation.attempts[0]?.executor;
  return executor === 'user-signed' ? 'blackbox-proposed' : 'blackbox';
}
