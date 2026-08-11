import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { ExecutionEvent } from '@blackbox/core';
import {
  executionEvents,
  incidents,
  ingestCursors,
  signerState,
  watchedExecutions,
  watchedSigners,
  watchedTransactions,
  remediationLedger,
} from './schema.js';

export * from './schema.js';

export type Database = PostgresJsDatabase<Record<string, never>>;

export function createDb(connectionString: string): { db: Database; close: () => Promise<void> } {
  const sqlClient = postgres(connectionString, { max: 5 });
  return { db: drizzle(sqlClient), close: () => sqlClient.end() };
}

const toText = (v: bigint | undefined): string | undefined => v?.toString();

/** Serialise an event for storage. Bigints become decimal strings. */
function serialiseEvent(e: ExecutionEvent) {
  return {
    id: e.id,
    sourceId: e.sourceId,
    logicalActionId: e.logicalActionId,
    attemptIndex: e.attemptIndex,
    agentId: e.agentId,
    signer: e.signer.toLowerCase(),
    chainId: e.chainId,
    agentKind: e.agentKind ?? null,
    workflowId: e.workflowId ?? null,
    txHash: e.submission.txHash ?? null,
    nonce: e.submission.nonce ?? null,
    submittedAt: e.submission.submittedAt,
    outcomeStatus: e.outcome.status,
    blockNumber: e.outcome.blockNumber ?? null,
    simulationSuccess: e.simulation.success ?? null,
    trigger: e.trigger,
    simulation: {
      ...e.simulation,
      gasEstimate: toText(e.simulation.gasEstimate),
    },
    submission: {
      ...e.submission,
      maxFeePerGas: toText(e.submission.maxFeePerGas),
      maxPriorityFeePerGas: toText(e.submission.maxPriorityFeePerGas),
      submittedAt: e.submission.submittedAt.toISOString(),
    },
    outcome: {
      ...e.outcome,
      gasUsed: toText(e.outcome.gasUsed),
      effectiveGasPrice: toText(e.outcome.effectiveGasPrice),
      observedAt: e.outcome.observedAt?.toISOString(),
    },
    raw: e.raw ?? null,
    ingestedAt: e.ingestedAt,
  };
}

const bi = (v: unknown): bigint | undefined =>
  v === null || v === undefined || v === '' ? undefined : BigInt(String(v));

const dt = (v: unknown): Date | undefined =>
  v === null || v === undefined ? undefined : new Date(String(v));

/** Rehydrate a stored row, restoring bigints and dates that JSONB flattened. */
function deserialiseEvent(row: typeof executionEvents.$inferSelect): ExecutionEvent {
  const sim = row.simulation as Record<string, unknown>;
  const sub = row.submission as Record<string, unknown>;
  const out = row.outcome as Record<string, unknown>;
  return {
    id: row.id,
    sourceId: row.sourceId,
    logicalActionId: row.logicalActionId,
    attemptIndex: row.attemptIndex,
    agentId: row.agentId,
    signer: row.signer as `0x${string}`,
    chainId: row.chainId,
    ...(row.agentKind ? { agentKind: row.agentKind as ExecutionEvent['agentKind'] } : {}),
    ...(row.workflowId ? { workflowId: row.workflowId } : {}),
    trigger: row.trigger as ExecutionEvent['trigger'],
    simulation: {
      performed: Boolean(sim['performed']),
      ...(sim['success'] !== undefined && sim['success'] !== null
        ? { success: Boolean(sim['success']) }
        : {}),
      ...(sim['revertReason'] ? { revertReason: String(sim['revertReason']) } : {}),
      ...(bi(sim['gasEstimate']) !== undefined ? { gasEstimate: bi(sim['gasEstimate'])! } : {}),
      ...(sim['simulatedAtBlock'] !== undefined && sim['simulatedAtBlock'] !== null
        ? { simulatedAtBlock: Number(sim['simulatedAtBlock']) }
        : {}),
    },
    submission: {
      ...(sub['txHash'] ? { txHash: sub['txHash'] as `0x${string}` } : {}),
      ...(sub['nonce'] !== undefined && sub['nonce'] !== null ? { nonce: Number(sub['nonce']) } : {}),
      ...(bi(sub['maxFeePerGas']) !== undefined ? { maxFeePerGas: bi(sub['maxFeePerGas'])! } : {}),
      ...(bi(sub['maxPriorityFeePerGas']) !== undefined
        ? { maxPriorityFeePerGas: bi(sub['maxPriorityFeePerGas'])! }
        : {}),
      submittedAt: row.submittedAt,
      route: (sub['route'] ?? 'unknown') as ExecutionEvent['submission']['route'],
    },
    outcome: {
      status: row.outcomeStatus as ExecutionEvent['outcome']['status'],
      ...(row.blockNumber !== null ? { blockNumber: row.blockNumber } : {}),
      ...(bi(out['gasUsed']) !== undefined ? { gasUsed: bi(out['gasUsed'])! } : {}),
      ...(bi(out['effectiveGasPrice']) !== undefined
        ? { effectiveGasPrice: bi(out['effectiveGasPrice'])! }
        : {}),
      ...(out['revertReason'] ? { revertReason: String(out['revertReason']) } : {}),
      ...(dt(out['observedAt']) ? { observedAt: dt(out['observedAt'])! } : {}),
    },
    raw: row.raw,
    ingestedAt: row.ingestedAt,
  };
}

/**
 * Insert events, ignoring any already stored.
 *
 * The recorder re-polls executions that are still in flight, so the same
 * attempt arrives repeatedly. Dedupe is on (sourceId, attemptIndex) and happens
 * in the database rather than in the loop, so two recorder processes cannot
 * race a duplicate through.
 */
export async function insertEvents(db: Database, events: readonly ExecutionEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const rows = events.map(serialiseEvent);
  const inserted = await db
    .insert(executionEvents)
    .values(rows)
    .onConflictDoUpdate({
      target: [executionEvents.sourceId, executionEvents.attemptIndex],
      // A transaction observed while pending settles later, and the settled
      // observation is the one the rules need — several of them only fire on a
      // terminal outcome. Ignoring the conflict froze the first snapshot
      // forever: a retry storm ingested mid-flight stayed four `pending` rows
      // and R5 could never see it. Only pending rows are updated, so a terminal
      // outcome is never walked back by a late or stale poll.
      set: {
        outcomeStatus: sql`excluded.outcome_status`,
        blockNumber: sql`excluded.block_number`,
        outcome: sql`excluded.outcome`,
        simulation: sql`excluded.simulation`,
        simulationSuccess: sql`excluded.simulation_success`,
      },
      setWhere: eq(executionEvents.outcomeStatus, 'pending'),
    })
    // `xmax = 0` is true only for a genuine insert, so the count keeps meaning
    // "events seen for the first time". A settling update is not news — the
    // rules re-evaluate the whole window every tick regardless.
    .returning({ id: executionEvents.id, isNew: sql<boolean>`xmax = 0` });
  return inserted.filter((r) => r.isNew).length;
}

/** The per-signer sliding window the rules evaluate, oldest first. */
export async function loadSignerWindow(
  db: Database,
  params: { signer: string; chainId: number; since: Date; limit?: number },
): Promise<ExecutionEvent[]> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.signer, params.signer.toLowerCase()),
        eq(executionEvents.chainId, params.chainId),
        gte(executionEvents.submittedAt, params.since),
      ),
    )
    .orderBy(asc(executionEvents.submittedAt))
    .limit(params.limit ?? 500);
  return rows.map(deserialiseEvent);
}

export type IncidentRow = typeof incidents.$inferInsert;

/**
 * Make a value safe for a JSONB column.
 *
 * Gas figures and fees are bigints, and the driver's JSON serialiser throws
 * `Do not know how to serialize a BigInt` on them. That throw happened deep in
 * the recorder's persistence path, where it was caught as a generic evaluation
 * error, so the visible symptom was an incident that simply never resolved.
 * Converting here means every writer of these columns is covered rather than
 * each one remembering.
 */
export function jsonSafe<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as T;
}

/** Upsert by id so a tracked incident's evidence and status stay current. */
export async function saveIncident(db: Database, incident: IncidentRow): Promise<void> {
  const row = {
    ...incident,
    evidence: jsonSafe(incident.evidence),
    rca: jsonSafe(incident.rca) ?? null,
    remediation: jsonSafe(incident.remediation) ?? null,
  };
  // `rca` and `remediation` are written by the diagnostician and the
  // remediator; the recorder re-saves every tracked incident on every tick and
  // knows about neither. Overwriting them with null on those saves silently
  // erased a root cause analysis and a completed remediation between one poll
  // and the next — observed as an incident that stayed open forever with its
  // ledger row intact. An update that carries no analysis leaves the stored one
  // alone.
  const set: Record<string, unknown> = {
    severity: row.severity,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    resolvedAt: row.resolvedAt ?? null,
    resolvedBy: row.resolvedBy ?? null,
    confidence: row.confidence,
    evidence: row.evidence,
  };
  if (row.rca !== null && row.rca !== undefined) set['rca'] = row.rca;
  if (row.remediation !== null && row.remediation !== undefined) {
    set['remediation'] = row.remediation;
  }

  await db.insert(incidents).values(row).onConflictDoUpdate({ target: incidents.id, set });
}

export type IncidentFilters = {
  limit?: number;
  status?: string;
  class?: string;
  severity?: string;
  agentId?: string;
  signer?: string;
  chainId?: number;
  /** Only incidents detected at or after this instant. */
  since?: Date;
};

/**
 * Incidents matching every supplied filter, newest first.
 *
 * Filters compose with AND, which is what a console's filter bar means when it
 * offers several at once. `signer` is matched case-insensitively because
 * addresses arrive checksummed from a UI and are stored lowercased.
 */
export async function listIncidents(
  db: Database,
  params: IncidentFilters = {},
): Promise<(typeof incidents.$inferSelect)[]> {
  const clauses = [
    params.status ? eq(incidents.status, params.status) : undefined,
    params.class ? eq(incidents.class, params.class) : undefined,
    params.severity ? eq(incidents.severity, params.severity) : undefined,
    params.agentId ? eq(incidents.agentId, params.agentId) : undefined,
    params.signer ? eq(incidents.signer, params.signer.toLowerCase()) : undefined,
    params.chainId !== undefined ? eq(incidents.chainId, params.chainId) : undefined,
    params.since ? gte(incidents.detectedAt, params.since) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  return db
    .select()
    .from(incidents)
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(incidents.detectedAt))
    .limit(params.limit ?? 100);
}

export async function getIncident(
  db: Database,
  id: string,
): Promise<(typeof incidents.$inferSelect) | null> {
  const [row] = await db.select().from(incidents).where(eq(incidents.id, id)).limit(1);
  return row ?? null;
}

/**
 * The events an incident cites as evidence, oldest first.
 *
 * Returned as stored rows rather than domain events: the console renders the
 * timeline from block numbers and outcome status, and rehydrating bigints only
 * to format them again would lose precision for nothing.
 */
export async function eventsByIds(
  db: Database,
  ids: readonly string[],
): Promise<(typeof executionEvents.$inferSelect)[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(executionEvents)
    .where(inArray(executionEvents.id, [...ids]))
    .orderBy(asc(executionEvents.submittedAt));
}

export type LedgerRow = typeof remediationLedger.$inferSelect;

/** Every remediation attempt against one incident, oldest first. */
export async function ledgerForIncident(db: Database, incidentId: string): Promise<LedgerRow[]> {
  return db
    .select()
    .from(remediationLedger)
    .where(eq(remediationLedger.incidentId, incidentId))
    .orderBy(asc(remediationLedger.attemptedAt));
}

export type Stats = {
  openBySeverity: { critical: number; warning: number; info: number };
  remediations: {
    total: number;
    succeeded: number;
    skipped: number;
    failed: number;
    gasWei: string;
  };
  meanTimeToDetectionMs: number | null;
  meanTimeToRemediationMs: number | null;
  updatedAt: Date;
};

/**
 * The header strip.
 *
 * Both means are null rather than zero when nothing qualifies — "0ms to
 * detection" would read as instant detection rather than as no data, and this
 * number is one a viewer will quote.
 */
export async function stats(db: Database, now: Date = new Date()): Promise<Stats> {
  const [incidentRows, ledgerRows] = await Promise.all([
    db.select().from(incidents).orderBy(desc(incidents.detectedAt)).limit(500),
    db.select().from(remediationLedger).orderBy(desc(remediationLedger.attemptedAt)).limit(500),
  ]);

  const open = incidentRows.filter((i) => i.status !== 'resolved' && i.status !== 'acknowledged');
  const countSeverity = (severity: string): number =>
    open.filter((i) => i.severity === severity).length;

  // Detection latency is measured from the first event that became evidence,
  // not from when the incident row was written — the gap between them is
  // exactly what this number is meant to expose.
  const detectionLatencies = incidentRows
    .map((i) => i.detectedAt.getTime() - i.firstEventAt.getTime())
    .filter((ms) => ms >= 0);

  const remediated = incidentRows.filter((i) => i.resolvedAt && i.resolvedBy === 'blackbox');
  const remediationLatencies = remediated
    .map((i) => i.resolvedAt!.getTime() - i.detectedAt.getTime())
    .filter((ms) => ms >= 0);

  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  return {
    openBySeverity: {
      critical: countSeverity('critical'),
      warning: countSeverity('warning'),
      info: countSeverity('info'),
    },
    remediations: {
      total: ledgerRows.length,
      succeeded: ledgerRows.filter((r) => r.status === 'succeeded').length,
      skipped: ledgerRows.filter((r) => r.status === 'skipped').length,
      failed: ledgerRows.filter((r) => r.status === 'failed').length,
      gasWei: ledgerRows.reduce((sum, r) => sum + BigInt(r.gasSpentWei), 0n).toString(),
    },
    meanTimeToDetectionMs: mean(detectionLatencies),
    meanTimeToRemediationMs: mean(remediationLatencies),
    updatedAt: now,
  };
}

/** Distinct agents seen, with their signers, chains and open incident counts. */
export async function listAgents(db: Database): Promise<
  { agentId: string; signers: string[]; chainIds: number[]; openIncidents: number }[]
> {
  const rows = await db.select().from(incidents).limit(1000);
  const byAgent = new Map<string, { signers: Set<string>; chainIds: Set<number>; open: number }>();
  for (const row of rows) {
    const entry = byAgent.get(row.agentId) ?? { signers: new Set(), chainIds: new Set(), open: 0 };
    entry.signers.add(row.signer);
    entry.chainIds.add(row.chainId);
    if (row.status !== 'resolved' && row.status !== 'acknowledged') entry.open += 1;
    byAgent.set(row.agentId, entry);
  }
  return [...byAgent.entries()].map(([agentId, e]) => ({
    agentId,
    signers: [...e.signers],
    chainIds: [...e.chainIds],
    openIncidents: e.open,
  }));
}

export async function getCursor(db: Database, source: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(ingestCursors)
    .where(eq(ingestCursors.source, source))
    .limit(1);
  return row?.cursor ?? null;
}

export async function setCursor(db: Database, source: string, cursor: string): Promise<void> {
  await db
    .insert(ingestCursors)
    .values({ source, cursor, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: ingestCursors.source,
      set: { cursor, updatedAt: new Date() },
    });
}

export type WatchedExecution = typeof watchedExecutions.$inferSelect;

/** Register an execution to be polled until it settles. Idempotent. */
export async function watchExecution(
  db: Database,
  params: {
    executionId: string;
    agentId: string;
    signer: string;
    chainId: number;
    submitted?: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  await db
    .insert(watchedExecutions)
    .values({
      executionId: params.executionId,
      agentId: params.agentId,
      signer: params.signer.toLowerCase(),
      chainId: params.chainId,
      submitted: params.submitted ?? null,
      registeredAt: params.at,
    })
    .onConflictDoNothing({ target: watchedExecutions.executionId });
}

/** Unsettled executions, least recently polled first, so none is starved. */
export async function dueExecutions(
  db: Database,
  limit = 50,
): Promise<WatchedExecution[]> {
  return db
    .select()
    .from(watchedExecutions)
    .where(isNull(watchedExecutions.settledAt))
    .orderBy(sql`${watchedExecutions.lastPolledAt} asc nulls first`)
    .limit(limit);
}

export async function markPolled(
  db: Database,
  executionId: string,
  params: { at: Date; settled: boolean },
): Promise<void> {
  await db
    .update(watchedExecutions)
    .set({
      lastPolledAt: params.at,
      pollCount: sql`${watchedExecutions.pollCount} + 1`,
      ...(params.settled ? { settledAt: params.at } : {}),
    })
    .where(eq(watchedExecutions.executionId, executionId));
}

/**
 * Advance or clear the consecutive-gap counter for a signer, returning the new
 * value. R2 reads it, and it must survive a restart or a genuine wedged nonce
 * would be forgotten every time the process bounces.
 */
export async function recordGapObservation(
  db: Database,
  params: { signer: string; chainId: number; gapPresent: boolean; at: Date },
): Promise<number> {
  const signer = params.signer.toLowerCase();
  const [row] = await db
    .insert(signerState)
    .values({
      signer,
      chainId: params.chainId,
      consecutiveGapPolls: params.gapPresent ? 1 : 0,
      lastPolledAt: params.at,
    })
    .onConflictDoUpdate({
      target: [signerState.signer, signerState.chainId],
      set: {
        consecutiveGapPolls: params.gapPresent
          ? sql`${signerState.consecutiveGapPolls} + 1`
          : sql`0`,
        lastPolledAt: params.at,
      },
    })
    .returning({ count: signerState.consecutiveGapPolls });
  return row?.count ?? 0;
}

export type WatchedTransaction = typeof watchedTransactions.$inferSelect;

/** Register a raw transaction hash to observe on chain. Idempotent. */
export async function watchTransaction(
  db: Database,
  params: {
    txHash: string;
    agentId: string;
    signer: string;
    chainId: number;
    label?: string;
    at: Date;
    /** Shared across retries of one action, so R5 can count them together. */
    logicalActionId?: string;
    /**
     * What the submitter simulated, if it did. Recorded verbatim so R4 can
     * distinguish "simulated clean then reverted" from "nobody looked".
     */
    simulation?: {
      performed: boolean;
      success?: boolean;
      simulatedAtBlock?: number;
      gasEstimate?: bigint;
      revertReason?: string;
    };
  },
): Promise<void> {
  await db
    .insert(watchedTransactions)
    .values({
      txHash: params.txHash.toLowerCase(),
      agentId: params.agentId,
      signer: params.signer.toLowerCase(),
      chainId: params.chainId,
      label: params.label ?? null,
      logicalActionId: params.logicalActionId ?? null,
      simulation: params.simulation ? jsonSafe(params.simulation) : null,
      registeredAt: params.at,
    })
    .onConflictDoNothing({ target: watchedTransactions.txHash });
}

export async function dueTransactions(db: Database, limit = 50): Promise<WatchedTransaction[]> {
  return db
    .select()
    .from(watchedTransactions)
    .where(isNull(watchedTransactions.settledAt))
    .orderBy(sql`${watchedTransactions.lastPolledAt} asc nulls first`)
    .limit(limit);
}

export async function markTransactionPolled(
  db: Database,
  txHash: string,
  params: { at: Date; settled: boolean },
): Promise<void> {
  await db
    .update(watchedTransactions)
    .set({
      lastPolledAt: params.at,
      pollCount: sql`${watchedTransactions.pollCount} + 1`,
      ...(params.settled ? { settledAt: params.at } : {}),
    })
    .where(eq(watchedTransactions.txHash, txHash.toLowerCase()));
}

export type RemediationSpend = { count: number; gasWei: bigint };

/** What this signer has spent on remediation since `since`. */
export async function remediationSpendSince(
  db: Database,
  params: { signer: string; chainId: number; since: Date },
): Promise<RemediationSpend> {
  const rows = await db
    .select()
    .from(remediationLedger)
    .where(
      and(
        eq(remediationLedger.signer, params.signer.toLowerCase()),
        eq(remediationLedger.chainId, params.chainId),
        gte(remediationLedger.attemptedAt, params.since),
      ),
    );
  return {
    count: rows.length,
    gasWei: rows.reduce((sum, r) => sum + BigInt(r.gasSpentWei), 0n),
  };
}

/** How many attempts this incident has already had. */
export async function attemptsForIncident(db: Database, incidentId: string): Promise<number> {
  const rows = await db
    .select()
    .from(remediationLedger)
    .where(eq(remediationLedger.incidentId, incidentId));
  return rows.length;
}

export async function recordRemediationAttempt(
  db: Database,
  entry: {
    id: string;
    incidentId: string;
    playbookId: string;
    signer: string;
    chainId: number;
    attemptedAt: Date;
    gasSpentWei?: bigint;
    status: string;
    txHash?: string;
    executor?: string;
  },
): Promise<void> {
  await db.insert(remediationLedger).values({
    ...entry,
    signer: entry.signer.toLowerCase(),
    gasSpentWei: (entry.gasSpentWei ?? 0n).toString(),
    txHash: entry.txHash ?? null,
    executor: entry.executor ?? null,
  });
}

export type WatchedSigner = typeof watchedSigners.$inferSelect;

/**
 * Register an address for observation. Idempotent: registering twice
 * reactivates rather than failing, because a console button will be pressed
 * twice.
 */
export async function watchSigner(
  db: Database,
  params: {
    signer: string;
    chainId: number;
    agentId: string;
    label?: string;
    at: Date;
  },
): Promise<void> {
  await db
    .insert(watchedSigners)
    .values({
      signer: params.signer.toLowerCase(),
      chainId: params.chainId,
      agentId: params.agentId,
      label: params.label ?? null,
      registeredAt: params.at,
      active: true,
    })
    .onConflictDoUpdate({
      target: [watchedSigners.signer, watchedSigners.chainId],
      set: { agentId: params.agentId, label: params.label ?? null, active: true },
    });
}

export async function unwatchSigner(db: Database, signer: string, chainId: number): Promise<void> {
  await db
    .update(watchedSigners)
    .set({ active: false })
    .where(and(eq(watchedSigners.signer, signer.toLowerCase()), eq(watchedSigners.chainId, chainId)));
}

export async function activeSigners(db: Database, chainId?: number): Promise<WatchedSigner[]> {
  const clauses = [
    eq(watchedSigners.active, true),
    chainId !== undefined ? eq(watchedSigners.chainId, chainId) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  return db.select().from(watchedSigners).where(and(...clauses));
}
