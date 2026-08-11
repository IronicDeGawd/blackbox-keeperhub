import { getChain, type Incident, type IncidentClass } from '@blackbox/core';

/**
 * An alert is derived from an incident, never stored as one.
 *
 * The incident is the record; the alert is one thing said about it at one
 * moment. Keeping them separate is what makes deduplication possible at all: a
 * detector that re-evaluates every tick produces the same incident repeatedly,
 * and an alerter that treated each evaluation as news would page someone twenty
 * times for one problem.
 */

export type AlertKind =
  /** First time this incident was seen. */
  | 'opened'
  /** Its severity rose after it was already reported. */
  | 'escalated'
  /** It ended — the transaction landed, or a remediation worked. */
  | 'resolved'
  /** Blackbox tried to fix it and could not. */
  | 'remediation_failed';

export type Alert = {
  incidentId: string;
  kind: AlertKind;
  severity: Incident['severity'];
  class: IncidentClass;
  agentId: string;
  signer: `0x${string}`;
  chainId: number;
  /** One line, written for a phone notification. */
  summary: string;
  links: { label: string; url: string }[];
  firedAt: Date;
};

/**
 * What was last said about an incident, so the same thing is not said twice.
 * Small enough to keep in memory and cheap enough to persist; the alerter holds
 * it rather than the incident record, because it is about delivery rather than
 * about the failure.
 */
export type AlertMemory = {
  lastKind: AlertKind;
  lastSeverity: Incident['severity'];
  firedAt: Date;
};

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 } as const;

/**
 * Decide what — if anything — is worth saying about this incident now.
 *
 * The four moments that are genuinely news: it started, it got worse, it ended,
 * and an attempted fix failed. Everything else is the same problem still being
 * true, which is what a console is for.
 *
 * Returning null is the common case and the important one.
 */
export function alertFor(
  incident: Incident,
  memory: AlertMemory | undefined,
  now: Date,
): Alert | null {
  const kind = kindFor(incident, memory);
  if (!kind) return null;
  return {
    incidentId: incident.id,
    kind,
    severity: incident.severity,
    class: incident.class,
    agentId: incident.agentId,
    signer: incident.signer,
    chainId: incident.chainId,
    summary: summarise(incident, kind),
    links: linksFor(incident),
    firedAt: now,
  };
}

function kindFor(incident: Incident, memory: AlertMemory | undefined): AlertKind | null {
  const remediationFailed = incident.remediation?.finalStatus === 'failed';

  if (!memory) {
    // A first sighting that is already resolved is history, not news — it can
    // happen when a restart replays an incident that ended while we were down.
    if (incident.status === 'resolved') return null;
    return remediationFailed ? 'remediation_failed' : 'opened';
  }

  if (incident.status === 'resolved') {
    return memory.lastKind === 'resolved' ? null : 'resolved';
  }

  if (remediationFailed && memory.lastKind !== 'remediation_failed') {
    return 'remediation_failed';
  }

  if (SEVERITY_RANK[incident.severity] > SEVERITY_RANK[memory.lastSeverity]) {
    return 'escalated';
  }

  // Still open, still the same. The console shows it; nobody needs telling
  // again.
  return null;
}

/**
 * The sentence someone reads on a lock screen.
 *
 * It leads with what happened rather than with the incident class, because the
 * class is jargon and the consequence is not.
 */
function summarise(incident: Incident, kind: AlertKind): string {
  const agent = incident.agentId;
  const facts = incident.evidence.facts;

  if (kind === 'resolved') {
    const hash = remediationHash(incident);
    return hash
      ? `${agent}: ${describe(incident.class, facts)} — fixed, ${short(hash)}`
      : `${agent}: ${describe(incident.class, facts)} — resolved`;
  }
  if (kind === 'remediation_failed') {
    // The last attempt's reason, not the first: what finally stopped it.
    const detail = incident.remediation?.attempts.at(-1)?.failureReason;
    return `${agent}: could not fix ${describe(incident.class, facts)}${detail ? ` — ${detail}` : ''}`;
  }
  if (kind === 'escalated') {
    return `${agent}: ${describe(incident.class, facts)} — now ${incident.severity}`;
  }
  return `${agent}: ${describe(incident.class, facts)}`;
}

function describe(cls: IncidentClass, facts: Record<string, unknown>): string {
  switch (cls) {
    case 'NONCE_GAP': {
      const missing = Array.isArray(facts['missingNonces']) ? facts['missingNonces'] : [];
      const blocked = Number(facts['blockedActionCount'] ?? 0);
      return `nonce ${missing.join(', ')} unfilled, ${blocked} action${blocked === 1 ? '' : 's'} blocked`;
    }
    case 'STUCK_TRANSACTION': {
      const seconds = Math.round(Number(facts['pendingDurationMs'] ?? 0) / 1000);
      return `transaction pending ${seconds}s`;
    }
    case 'GAS_UNDERPRICED':
      return `bid ${Number(facts['feeDeficitPct'] ?? 0).toFixed(0)}% under the market`;
    case 'SIM_PASS_EXEC_REVERT':
      return `simulated clean, reverted onchain${facts['revertReason'] ? `: ${String(facts['revertReason'])}` : ''}`;
    case 'RETRY_STORM':
      return `${Number(facts['attemptCount'] ?? 0)} failed attempts at one action`;
    case 'SIGNER_GAS_STARVED':
      return 'signer is out of gas';
    case 'ADVERSE_INCLUSION':
      return 'received less than simulated';
  }
}

/**
 * The hash of the attempt that worked.
 *
 * A remediation may have been tried more than once, and only a succeeded
 * attempt's hash is the one that fixed anything — quoting a failed attempt's
 * hash in a "fixed itself" alert would point at the wrong transaction.
 */
function remediationHash(incident: Incident): string | undefined {
  return incident.remediation?.attempts.find((a) => a.status === 'succeeded' && a.txHash)?.txHash;
}

function linksFor(incident: Incident): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  const hash = remediationHash(incident);
  if (hash) {
    try {
      links.push({ label: 'remediation', url: getChain(incident.chainId).explorerTxUrl(hash) });
    } catch {
      // An unsupported chain has no explorer we can name. A missing link is
      // better than one that 404s.
    }
  }
  return links;
}

const short = (hash: string): string => `${hash.slice(0, 10)}…`;

export function remember(alert: Alert): AlertMemory {
  return { lastKind: alert.kind, lastSeverity: alert.severity, firedAt: alert.firedAt };
}
