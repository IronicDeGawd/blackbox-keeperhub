import { incidentSchema, type Incident } from '@blackbox/core';
import { listIncidents, saveIncident, type Database } from '@blackbox/store';
import type { Remediator, RemediationOutcome } from './remediator.js';

/**
 * Picks up open incidents and hands each to the remediator.
 *
 * Deliberately thin. All the judgement — whether to act, which playbook, what
 * to submit — already lives in the guards and playbooks; duplicating any of it
 * here would create a second place where the decision could differ.
 *
 * The outcome is written back onto the incident so the console can show what
 * Blackbox did, or why it declined, against the incident it was reacting to.
 */
export type RemediationLoopOptions = {
  db: Database;
  remediator: Remediator;
  /** Cap per pass, so one wedged signer cannot monopolise a tick. */
  limit?: number;
  logger?: { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
};

export type LoopTickResult = {
  considered: number;
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  errors: number;
  outcomes: { incidentId: string; outcome: RemediationOutcome }[];
};

export class RemediationLoop {
  constructor(private readonly options: RemediationLoopOptions) {}

  async tick(): Promise<LoopTickResult> {
    const rows = await listIncidents(this.options.db, {
      status: 'open',
      ...(this.options.limit !== undefined ? { limit: this.options.limit } : {}),
    });

    const result: LoopTickResult = {
      considered: rows.length,
      attempted: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      errors: 0,
      outcomes: [],
    };

    for (const row of rows) {
      const incident = toIncident(row);
      try {
        const outcome = await this.options.remediator.remediate(incident);
        result.attempted += 1;
        result.outcomes.push({ incidentId: incident.id, outcome });

        const status = outcome.record.finalStatus;
        if (status === 'succeeded') result.succeeded += 1;
        else if (status === 'failed') result.failed += 1;
        else result.skipped += 1;

        await saveIncident(this.options.db, {
          ...row,
          remediation: serialiseRemediation(outcome.record),
        });
      } catch (error) {
        // A remediator that throws is a bug, not an expected outcome — but one
        // incident must not stop the rest of the pass.
        result.errors += 1;
        this.options.logger?.error('remediation loop error', {
          incidentId: incident.id,
          error,
        });
      }
    }
    return result;
  }
}

type IncidentRowLike = {
  id: string;
  class: string;
  severity: string;
  status: string;
  agentId: string;
  signer: string;
  chainId: number;
  detectedAt: Date;
  firstEventAt: Date;
  resolvedAt: Date | null;
  confidence: number;
  evidence: unknown;
  rca?: unknown;
};

/**
 * Rows carry `evidence` as opaque JSON and several columns the domain type does
 * not have (`key`, `lastSeenAt`, `resolvedBy`, which belong to correlation and
 * storage rather than to the incident itself). Parsing rather than casting
 * means a row that has drifted out of shape fails here, loudly, instead of
 * reaching a playbook and being planned against.
 */
export function toIncident(row: IncidentRowLike): Incident {
  return incidentSchema.parse({
    id: row.id,
    class: row.class,
    severity: row.severity,
    status: row.status,
    agentId: row.agentId,
    signer: row.signer,
    chainId: row.chainId,
    detectedAt: row.detectedAt,
    firstEventAt: row.firstEventAt,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
    confidence: row.confidence,
    evidence: row.evidence,
    ...(row.rca ? { rca: row.rca } : {}),
  });
}

/** bigint gas figures cannot go into JSONB; they are stored as decimal strings. */
function serialiseRemediation(record: RemediationOutcome['record']): unknown {
  return JSON.parse(
    JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}
