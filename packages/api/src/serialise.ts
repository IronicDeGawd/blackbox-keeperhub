import { getChain } from '@blackbox/core';

/**
 * Row-to-wire conversion for the console.
 *
 * One place, because the summary shape appears in three routes and in every SSE
 * event, and a field that differs between the list and the stream makes the
 * console flicker between two versions of the same incident.
 *
 * Wei stays a decimal string all the way to the browser. It exceeds
 * `Number.MAX_SAFE_INTEGER`, so any JSON number would be silently wrong.
 */

export type IncidentRow = {
  id: string;
  class: string;
  severity: string;
  status: string;
  agentId: string;
  signer: string;
  chainId: number;
  detectedAt: Date;
  firstEventAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  ruleId: string;
  confidence: number;
  evidence: unknown;
  rca: unknown;
  remediation: unknown;
};

export type EventRow = {
  id: string;
  logicalActionId: string;
  txHash: string | null;
  nonce: number | null;
  submittedAt: Date;
  outcomeStatus: string;
  blockNumber: number | null;
  simulationSuccess: boolean | null;
};

const explorerFor = (chainId: number, hash: string): string | null => {
  try {
    return getChain(chainId).explorerTxUrl(hash);
  } catch {
    // An unsupported chain is not a reason to fail a response; the console
    // simply renders the hash without a link.
    return null;
  }
};

type Evidence = { ruleId?: string; facts?: Record<string, unknown> };
type Remediation = {
  playbookId?: string;
  finalStatus?: string;
  attempts?: { txHash?: string; status?: string }[];
};

/** One line in the timeline. */
export function incidentSummary(row: IncidentRow): Record<string, unknown> {
  const remediation = row.remediation as Remediation | null;
  const txHash = remediation?.attempts?.find((a) => a.txHash)?.txHash ?? null;
  return {
    id: row.id,
    class: row.class,
    severity: row.severity,
    status: row.status,
    agentId: row.agentId,
    signer: row.signer,
    chainId: row.chainId,
    summary: summarise(row),
    detectedAt: row.detectedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    confidence: row.confidence,
    ruleId: row.ruleId,
    hasRca: Boolean(row.rca),
    remediationStatus: remediation?.finalStatus ?? null,
    remediationTxHash: txHash,
    explorerUrl: txHash ? explorerFor(row.chainId, txHash) : null,
  };
}

export function incidentDetail(
  row: IncidentRow,
  events: EventRow[],
  ledger: { txHash: string | null }[] = [],
): Record<string, unknown> {
  return {
    ...incidentSummary(row),
    firstEventAt: row.firstEventAt.toISOString(),
    evidence: row.evidence,
    rca: row.rca,
    remediation: row.remediation,
    events: events.map((e) => ({
      id: e.id,
      logicalActionId: e.logicalActionId,
      txHash: e.txHash,
      nonce: e.nonce,
      at: e.submittedAt.toISOString(),
      status: e.outcomeStatus,
      blockNumber: e.blockNumber,
      simulationSuccess: e.simulationSuccess,
      explorerUrl: e.txHash ? explorerFor(row.chainId, e.txHash) : null,
    })),
    explorerUrls: ledger
      .map((l) => l.txHash)
      .filter((h): h is string => Boolean(h))
      .map((h) => explorerFor(row.chainId, h))
      .filter((u): u is string => Boolean(u)),
  };
}

const eth = (wei: unknown): string => {
  try {
    const value = BigInt(String(wei));
    const whole = value / 10n ** 18n;
    const frac = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
    return `${whole}.${frac} ETH`;
  } catch {
    return String(wei);
  }
};

/**
 * The one-line summary the timeline row shows.
 *
 * Derived from the evidence rather than stored, so it can never disagree with
 * the facts beside it. Written to be readable at a glance and specific enough
 * to act on without opening the incident.
 */
export function summarise(row: IncidentRow): string {
  // Fact keys must match what the rules actually emit. They drifted once —
  // `runwayActions` for R6's `projectedActionsRemaining` — and the only symptom
  // was the word "unknown" in a timeline row, which reads like missing data
  // rather than a bug. `summarise.test.ts` pins them.
  const facts = ((row.evidence as Evidence)?.facts ?? {}) as Record<string, unknown>;
  const n = (key: string): string => String(facts[key] ?? 'unknown');

  switch (row.class) {
    case 'NONCE_GAP': {
      const missing = facts['missingNonces'];
      const list = Array.isArray(missing) ? missing.join(', ') : 'unknown';
      const blocked = facts['blockedActionCount'];
      return `Nonce ${list} unfilled; ${blocked ?? 'unknown'} action(s) blocked behind it`;
    }
    case 'STUCK_TRANSACTION': {
      const ms = Number(facts['pendingDurationMs']);
      const pending = Number.isFinite(ms) ? `${Math.round(ms / 1000)}s` : 'an unknown time';
      return `Transaction pending ${pending} at nonce ${n('nonce')}`;
    }
    case 'GAS_UNDERPRICED':
      return `Bid has fallen below the market since submission at nonce ${n('nonce')}`;
    case 'SIM_PASS_EXEC_REVERT':
      return `Simulated clean at block ${n('simulatedAtBlock')}, reverted at ${n('includedAtBlock')}`;
    case 'RETRY_STORM':
      return `${n('attemptCount')} failed attempts at one action, burning ${eth(facts['totalGasBurned'])}`;
    case 'SIGNER_GAS_STARVED':
      return `Balance ${eth(facts['signerBalance'])} covers ${n('projectedActionsRemaining')} further action(s)`;
    case 'ADVERSE_INCLUSION':
      return `Executed ${n('deltaBps')} bps worse than quoted`;
    case 'EXECUTION_STALLED':
      return `Workflow unfinished after ${Math.round(Number(facts['stalledMs'] ?? 0) / 1000)}s`;
    case 'WORKFLOW_MISCONFIGURED':
      return `${n('failureCount')} rejections before the chain, at the same workflow`;
    case 'SPEND_CAP_EXHAUSTED':
      return facts['exhausted'] === true
        ? `Daily spend cap of ${eth(facts['dailyCapWei'])} reached`
        : `Daily spend cap ${Math.round(Number(facts['usedRatio'] ?? 0) * 100)}% used`;
    default:
      return `${row.class} detected by ${row.ruleId}`;
  }
}
