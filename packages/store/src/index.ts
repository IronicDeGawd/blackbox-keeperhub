import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { ExecutionEvent } from '@blackbox/core';
import {
  agentBreakers,
  executionEvents,
  incidents,
  agentOwners,
  ingestCursors,
  oauthAuthRequests,
  oauthClients,
  orgSessions,
  signerState,
  keeperhubConnections,
  watchedWorkflows,
  webhookSecrets,
  watchedExecutions,
  watchedSigners,
  watchedTransactions,
  remediationLedger,
} from './schema.js';

import { hashEntry, verifyChain, type LedgerVerification } from './ledger-chain.js';

export * from './schema.js';
export * from './ledger-chain.js';

export type Database = PostgresJsDatabase<Record<string, never>>;

/**
 * The advisory-lock key that serialises ledger appends. Arbitrary but fixed —
 * every writer has to pick the same number or the lock does nothing.
 */
const LEDGER_LOCK_KEY = 4_213_907;

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
  /**
   * Every incident ever recorded here, not just the open ones. The severity
   * buckets below answer "what needs attention now"; this answers "has this
   * ever found anything", which is a different question and the one a reader
   * who has not signed in is actually asking.
   */
  incidentsDetected: number;
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
export async function stats(
  db: Database,
  now: Date = new Date(),
  /**
   * Restrict to these agents. Undefined means every agent, which is right for a
   * deployment that hosts only its own; a caller-scoped console must pass its
   * own list, or the numbers describe other people's failures.
   */
  agentIds?: readonly string[],
): Promise<Stats> {
  const [allIncidents, allLedger] = await Promise.all([
    db.select().from(incidents).orderBy(desc(incidents.detectedAt)).limit(500),
    db.select().from(remediationLedger).orderBy(desc(remediationLedger.attemptedAt)).limit(500),
  ]);
  const incidentRows = agentIds
    ? allIncidents.filter((row) => agentIds.includes(row.agentId))
    : allIncidents;
  // The ledger has no agent column, so it is narrowed through the incidents
  // that survived the filter.
  const visibleIncidentIds = new Set(incidentRows.map((row) => row.id));
  const ledgerRows = agentIds
    ? allLedger.filter((row) => visibleIncidentIds.has(row.incidentId))
    : allLedger;

  const open = incidentRows.filter((i) => i.status !== 'resolved' && i.status !== 'acknowledged');
  const countSeverity = (severity: string): number =>
    open.filter((i) => i.severity === severity).length;

  /**
   * Detection latency is measured from the first event that became evidence,
   * not from when the incident row was written — the gap between them is
   * exactly what this number is meant to expose.
   *
   * Incidents that cite no event are excluded rather than counted as zero. R8
   * reads the organisation's spend cap from the platform: there is no
   * execution behind it and so no moment the failure started, and averaging in
   * a zero would pull the figure down for a reason that has nothing to do with
   * how quickly anything was noticed.
   */
  const citesAnEvent = (row: (typeof incidentRows)[number]): boolean => {
    const evidence = row.evidence as { eventIds?: unknown } | null;
    return Array.isArray(evidence?.eventIds) && evidence.eventIds.length > 0;
  };
  const detectionLatencies = incidentRows
    .filter(citesAnEvent)
    .map((i) => i.detectedAt.getTime() - i.firstEventAt.getTime())
    .filter((ms) => ms >= 0);

  /**
   * Both count as Blackbox remediating: one it signed itself, one it planned
   * and an owner's wallet signed through its route. Counting only the first
   * left the statistic null for a run that plainly was a remediation.
   */
  const remediated = incidentRows.filter(
    (i) => i.resolvedAt && (i.resolvedBy === 'blackbox' || i.resolvedBy === 'blackbox-proposed'),
  );
  const remediationLatencies = remediated
    .map((i) => i.resolvedAt!.getTime() - i.detectedAt.getTime())
    .filter((ms) => ms >= 0);

  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  return {
    incidentsDetected: incidentRows.length,
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
export async function listAgents(
  db: Database,
  agentIds?: readonly string[],
): Promise<{ agentId: string; signers: string[]; chainIds: number[]; openIncidents: number }[]> {
  const all = await db.select().from(incidents).limit(1000);
  const rows = agentIds ? all.filter((row) => agentIds.includes(row.agentId)) : all;
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

/**
 * What one agent has spent since a moment.
 *
 * Separate from the per-signer figure because they answer different questions:
 * per signer bounds what one wallet can spend in an hour, per agent stops a
 * single workflow retrying all day on an organisation's shared wallet.
 */
export async function remediationSpendForAgent(
  db: Database,
  params: { agentId: string; since: Date },
): Promise<RemediationSpend> {
  const rows = await db
    .select()
    .from(remediationLedger)
    .where(
      and(
        eq(remediationLedger.agentId, params.agentId),
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
    agentId?: string;
  },
): Promise<void> {
  const row = {
    id: entry.id,
    incidentId: entry.incidentId,
    playbookId: entry.playbookId,
    signer: entry.signer.toLowerCase(),
    chainId: entry.chainId,
    attemptedAt: entry.attemptedAt,
    gasSpentWei: (entry.gasSpentWei ?? 0n).toString(),
    status: entry.status,
    txHash: entry.txHash ?? null,
    executor: entry.executor ?? null,
    agentId: entry.agentId ?? null,
  };

  /**
   * Appending has to be serialised, or two concurrent remediations both read
   * the same tip and both claim to follow it — which reads as a broken chain
   * ever after. Locking the tip row is not enough: the second transaction
   * would still not see a row the first had not committed yet. An advisory
   * lock has no such gap, and it is held only for the length of the insert.
   */
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LEDGER_LOCK_KEY})`);
    const [tip] = await tx
      .select({ entryHash: remediationLedger.entryHash })
      .from(remediationLedger)
      .where(isNotNull(remediationLedger.entryHash))
      .orderBy(desc(remediationLedger.seq))
      .limit(1);
    const prevHash = tip?.entryHash ?? null;
    await tx.insert(remediationLedger).values({
      ...row,
      prevHash,
      entryHash: hashEntry(row, prevHash),
    });
  });
}

/**
 * Walk the whole ledger and report whether it is intact.
 *
 * Read in append order, not by timestamp — the chain is the order it was
 * written in. Cheap enough to be a public endpoint at this size; if a
 * deployment ever outgrows reading it whole, the fix is to verify from a
 * checkpoint rather than to stop verifying.
 */
export async function verifyLedger(db: Database): Promise<LedgerVerification> {
  const rows = await db.select().from(remediationLedger).orderBy(asc(remediationLedger.seq));
  return verifyChain(rows);
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

// --- identity ---------------------------------------------------------------
// A KeeperHub organisation key is a bearer credential for someone else's
// account. None of these functions accept or return one: the API hashes before
// it calls, so a key never reaches this layer and never reaches the disk.

export async function createOrgSession(
  db: Database,
  params: { tokenHash: string; orgId: string; keyHash: string; label?: string | null; at: Date },
): Promise<void> {
  await db.insert(orgSessions).values({
    tokenHash: params.tokenHash,
    orgId: params.orgId,
    keyHash: params.keyHash,
    label: params.label ?? null,
    createdAt: params.at,
    lastSeenAt: params.at,
  });
}

/** A revoked session resolves to nothing, and stays on the table for the audit. */
export async function findOrgSession(
  db: Database,
  tokenHash: string,
): Promise<{ orgId: string } | null> {
  const [row] = await db
    .select()
    .from(orgSessions)
    .where(and(eq(orgSessions.tokenHash, tokenHash), isNull(orgSessions.revokedAt)))
    .limit(1);
  return row ? { orgId: row.orgId } : null;
}

export async function touchOrgSession(db: Database, tokenHash: string, at: Date): Promise<void> {
  await db.update(orgSessions).set({ lastSeenAt: at }).where(eq(orgSessions.tokenHash, tokenHash));
}

export async function revokeOrgSession(db: Database, tokenHash: string, at: Date): Promise<void> {
  await db.update(orgSessions).set({ revokedAt: at }).where(eq(orgSessions.tokenHash, tokenHash));
}

export async function ownerOfAgent(db: Database, agentId: string): Promise<string | null> {
  const [row] = await db.select().from(agentOwners).where(eq(agentOwners.agentId, agentId)).limit(1);
  return row?.orgId ?? null;
}

export async function agentsOwnedByOrg(db: Database, orgId: string): Promise<string[]> {
  const rows = await db.select().from(agentOwners).where(eq(agentOwners.orgId, orgId));
  return rows.map((r) => r.agentId);
}

/** First registration wins; a second claim by the same org is not an error. */
export async function claimAgentForOrg(
  db: Database,
  params: { agentId: string; orgId: string; at: Date },
): Promise<'claimed' | 'already_yours' | 'owned_by_another'> {
  const existing = await ownerOfAgent(db, params.agentId);
  if (existing) return existing === params.orgId ? 'already_yours' : 'owned_by_another';
  await db
    .insert(agentOwners)
    .values({ agentId: params.agentId, orgId: params.orgId, claimedAt: params.at })
    .onConflictDoNothing({ target: agentOwners.agentId });
  return 'claimed';
}

export type AgentBreaker = typeof agentBreakers.$inferSelect;

/**
 * The breaker registered for an agent, if any.
 *
 * Returns the row rather than the address so a caller can tell a registered
 * breaker from a verified one. P4 will plan against an unverified breaker —
 * the pause is worth attempting even if the role check has gone stale — but
 * the console shows the difference.
 */
export async function breakerFor(db: Database, agentId: string): Promise<AgentBreaker | null> {
  const [row] = await db
    .select()
    .from(agentBreakers)
    .where(eq(agentBreakers.agentId, agentId))
    .limit(1);
  return row ?? null;
}

export async function breakersForOrg(db: Database, orgId: string): Promise<AgentBreaker[]> {
  return db.select().from(agentBreakers).where(eq(agentBreakers.orgId, orgId));
}

/**
 * Register or replace the breaker for an agent.
 *
 * Idempotent on the agent, because the operator re-registering after
 * redeploying a contract is the ordinary case, not a conflict. Ownership is
 * checked by the caller, which already knows who is asking.
 */
export async function registerBreaker(
  db: Database,
  params: {
    agentId: string;
    address: string;
    chainId: number;
    orgId: string;
    at: Date;
    verifiedAt?: Date | null;
  },
): Promise<void> {
  await db
    .insert(agentBreakers)
    .values({
      agentId: params.agentId,
      address: params.address.toLowerCase(),
      chainId: params.chainId,
      orgId: params.orgId,
      registeredAt: params.at,
      verifiedAt: params.verifiedAt ?? null,
    })
    .onConflictDoUpdate({
      target: agentBreakers.agentId,
      set: {
        address: params.address.toLowerCase(),
        chainId: params.chainId,
        orgId: params.orgId,
        registeredAt: params.at,
        verifiedAt: params.verifiedAt ?? null,
      },
    });
}

export async function removeBreaker(db: Database, agentId: string): Promise<void> {
  await db.delete(agentBreakers).where(eq(agentBreakers.agentId, agentId));
}

/**
 * Move everything an organisation owns from one id to another.
 *
 * Blackbox used to know one KeeperHub organisation by two different ids: a
 * key sign-in derived one from the key list, while OAuth used KeeperHub's own
 * `org` claim. The same operator was therefore two tenants, and an agent
 * claimed through one door was invisible from the other. Once the real id is
 * known, what was filed under the derived one is moved across.
 *
 * Idempotent: running it again moves nothing, because nothing is left.
 */
export async function remapOrganisation(
  db: Database,
  params: { from: string; to: string },
): Promise<{ agents: number; sessions: number; connections: number; workflows: number }> {
  if (params.from === params.to) {
    return { agents: 0, sessions: 0, connections: 0, workflows: 0 };
  }
  const agents = await db
    .update(agentOwners)
    .set({ orgId: params.to })
    .where(eq(agentOwners.orgId, params.from))
    .returning({ agentId: agentOwners.agentId });
  const sessions = await db
    .update(orgSessions)
    .set({ orgId: params.to })
    .where(eq(orgSessions.orgId, params.from))
    .returning({ tokenHash: orgSessions.tokenHash });
  const workflows = await db
    .update(watchedWorkflows)
    .set({ orgId: params.to })
    .where(eq(watchedWorkflows.orgId, params.from))
    .returning({ workflowId: watchedWorkflows.workflowId });
  // A connection is keyed by organisation, so it is moved only when the
  // destination has none of its own; theirs is the more current credential.
  const existing = await getKeeperhubConnection(db, params.to);
  let connections = 0;
  if (!existing) {
    const moved = await db
      .update(keeperhubConnections)
      .set({ orgId: params.to })
      .where(eq(keeperhubConnections.orgId, params.from))
      .returning({ orgId: keeperhubConnections.orgId });
    connections = moved.length;
  }
  return {
    agents: agents.length,
    sessions: sessions.length,
    connections,
    workflows: workflows.length,
  };
}

// --- oauth ------------------------------------------------------------------

export async function getOAuthClient(
  db: Database,
  issuer: string,
): Promise<{ clientId: string; redirectUri: string } | null> {
  const [row] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.issuer, issuer))
    .limit(1);
  return row ? { clientId: row.clientId, redirectUri: row.redirectUri } : null;
}

export async function saveOAuthClient(
  db: Database,
  params: { issuer: string; clientId: string; redirectUri: string; at: Date },
): Promise<void> {
  await db
    .insert(oauthClients)
    .values({
      issuer: params.issuer,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      registeredAt: params.at,
    })
    .onConflictDoUpdate({
      target: oauthClients.issuer,
      set: { clientId: params.clientId, redirectUri: params.redirectUri, registeredAt: params.at },
    });
}

export async function saveAuthRequest(
  db: Database,
  params: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    returnTo?: string | null;
    connectDays?: number | null;
    at: Date;
    expiresAt: Date;
  },
): Promise<void> {
  await db.insert(oauthAuthRequests).values({
    state: params.state,
    codeVerifier: params.codeVerifier,
    redirectUri: params.redirectUri,
    returnTo: params.returnTo ?? null,
    connectDays: params.connectDays ?? null,
    createdAt: params.at,
    expiresAt: params.expiresAt,
  });
}

/**
 * Read a sign-in and consume it in the same breath.
 *
 * Single-use by construction: the row is deleted before the code is exchanged,
 * so a replayed callback — or two browsers racing the same link — finds
 * nothing. An expired request is deleted and reported as absent.
 */
export async function takeAuthRequest(
  db: Database,
  state: string,
  now: Date,
): Promise<{
  codeVerifier: string;
  redirectUri: string;
  returnTo: string | null;
  connectDays: number | null;
} | null> {
  const [row] = await db
    .delete(oauthAuthRequests)
    .where(eq(oauthAuthRequests.state, state))
    .returning();
  if (!row) return null;
  if (row.expiresAt.getTime() < now.getTime()) return null;
  return {
    codeVerifier: row.codeVerifier,
    redirectUri: row.redirectUri,
    returnTo: row.returnTo,
    connectDays: row.connectDays,
  };
}

/** Housekeeping: abandoned sign-ins are rows nobody will ever come back for. */
export async function purgeExpiredAuthRequests(db: Database, now: Date): Promise<number> {
  const rows = await db
    .delete(oauthAuthRequests)
    .where(lt(oauthAuthRequests.expiresAt, now))
    .returning();
  return rows.length;
}

// --- webhook secrets --------------------------------------------------------

export async function createWebhookSecret(
  db: Database,
  params: { secretHash: string; orgId: string; label?: string | null; at: Date },
): Promise<void> {
  await db.insert(webhookSecrets).values({
    secretHash: params.secretHash,
    orgId: params.orgId,
    label: params.label ?? null,
    createdAt: params.at,
  });
}

/** Resolve a secret to the organisation that owns it, and record the use. */
export async function useWebhookSecret(
  db: Database,
  secretHash: string,
  at: Date,
): Promise<{ orgId: string } | null> {
  const [row] = await db
    .select()
    .from(webhookSecrets)
    .where(and(eq(webhookSecrets.secretHash, secretHash), isNull(webhookSecrets.revokedAt)))
    .limit(1);
  if (!row) return null;
  await db
    .update(webhookSecrets)
    .set({ lastUsedAt: at })
    .where(eq(webhookSecrets.secretHash, secretHash));
  return { orgId: row.orgId };
}

export async function revokeWebhookSecret(
  db: Database,
  secretHash: string,
  at: Date,
): Promise<void> {
  await db
    .update(webhookSecrets)
    .set({ revokedAt: at })
    .where(eq(webhookSecrets.secretHash, secretHash));
}

/**
 * How each agent executes, from what was actually recorded.
 *
 * The most recent classification wins, since an agent that has migrated from
 * its own key to a managed wallet is now the latter. Agents with no
 * classification are absent rather than guessed at.
 */
export async function recentAgentKinds(
  db: Database,
): Promise<{ agentId: string; agentKind: 'keeperhub' | 'signer' }[]> {
  const rows = await db
    .select({
      agentId: executionEvents.agentId,
      agentKind: executionEvents.agentKind,
      submittedAt: executionEvents.submittedAt,
    })
    .from(executionEvents)
    .orderBy(desc(executionEvents.submittedAt))
    .limit(2000);

  const seen = new Map<string, 'keeperhub' | 'signer'>();
  for (const row of rows) {
    if (!row.agentKind || seen.has(row.agentId)) continue;
    if (row.agentKind === 'keeperhub' || row.agentKind === 'signer') {
      seen.set(row.agentId, row.agentKind);
    }
  }
  return [...seen.entries()].map(([agentId, agentKind]) => ({ agentId, agentKind }));
}

// --- KeeperHub connections ---------------------------------------------------

export type ConnectionStatus = 'active' | 'needs_reauth' | 'disconnected';

export interface KeeperhubConnection {
  orgId: string;
  refreshTokenEnc: string;
  scope: string;
  subject: string | null;
  signer: string | null;
  connectedAt: Date;
  expiresAt: Date;
  lastRefreshedAt: Date | null;
  lastSweptAt: Date | null;
  status: ConnectionStatus;
  lastError: string | null;
  failureCount: number;
}

const asStatus = (s: string): ConnectionStatus =>
  s === 'active' || s === 'needs_reauth' || s === 'disconnected' ? s : 'disconnected';

const asConnection = (row: typeof keeperhubConnections.$inferSelect): KeeperhubConnection => ({
  ...row,
  status: asStatus(row.status),
});

/**
 * Store a freshly authorised connection.
 *
 * Reconnecting overwrites the credential and restarts both clocks, but leaves
 * the watched workflows alone — an operator re-authorising should not have to
 * choose again.
 */
export async function saveKeeperhubConnection(
  db: Database,
  params: {
    orgId: string;
    refreshTokenEnc: string;
    scope: string;
    subject?: string | null;
    at: Date;
    expiresAt: Date;
  },
): Promise<void> {
  const values = {
    orgId: params.orgId,
    refreshTokenEnc: params.refreshTokenEnc,
    scope: params.scope,
    subject: params.subject ?? null,
    connectedAt: params.at,
    expiresAt: params.expiresAt,
    lastRefreshedAt: null,
    status: 'active' as const,
    lastError: null,
    failureCount: 0,
  };
  await db
    .insert(keeperhubConnections)
    .values(values)
    .onConflictDoUpdate({ target: keeperhubConnections.orgId, set: values });
}

export async function getKeeperhubConnection(
  db: Database,
  orgId: string,
): Promise<KeeperhubConnection | null> {
  const [row] = await db
    .select()
    .from(keeperhubConnections)
    .where(eq(keeperhubConnections.orgId, orgId))
    .limit(1);
  return row ? asConnection(row) : null;
}

/** Connections the sweep should read from: active, and not past our own expiry. */
export async function listSweepableConnections(
  db: Database,
  now: Date,
): Promise<KeeperhubConnection[]> {
  const rows = await db
    .select()
    .from(keeperhubConnections)
    .where(and(eq(keeperhubConnections.status, 'active'), gte(keeperhubConnections.expiresAt, now)));
  return rows.map(asConnection);
}

/**
 * Persist the token KeeperHub handed back on a refresh.
 *
 * Their refresh tokens rotate: the one we just sent is dead. So this write is
 * not housekeeping — losing it loses the connection, which is why the caller
 * writes before using the new access token rather than after.
 */
export async function recordConnectionRefresh(
  db: Database,
  params: { orgId: string; refreshTokenEnc: string; at: Date },
): Promise<void> {
  await db
    .update(keeperhubConnections)
    .set({
      refreshTokenEnc: params.refreshTokenEnc,
      lastRefreshedAt: params.at,
      failureCount: 0,
      lastError: null,
    })
    .where(eq(keeperhubConnections.orgId, params.orgId));
}

/** How many accounts are connected. A count, never a list of who. */
export async function countConnections(db: Database): Promise<number> {
  const rows = await db
    .select({ orgId: keeperhubConnections.orgId })
    .from(keeperhubConnections)
    .where(eq(keeperhubConnections.status, 'active'));
  return rows.length;
}

/** Remember the address this organisation executes as, once we know it. */
export async function recordConnectionSigner(
  db: Database,
  orgId: string,
  signer: string,
): Promise<void> {
  await db
    .update(keeperhubConnections)
    .set({ signer: signer.toLowerCase() })
    .where(eq(keeperhubConnections.orgId, orgId));
}

export async function recordConnectionSweep(
  db: Database,
  orgId: string,
  at: Date,
): Promise<void> {
  await db
    .update(keeperhubConnections)
    .set({ lastSweptAt: at })
    .where(eq(keeperhubConnections.orgId, orgId));
}

/** A dead refresh token does not recover by being asked again. Stop sweeping. */
export async function markConnectionNeedsReauth(
  db: Database,
  orgId: string,
  reason: string,
): Promise<void> {
  await db
    .update(keeperhubConnections)
    .set({ status: 'needs_reauth', lastError: reason })
    .where(eq(keeperhubConnections.orgId, orgId));
}

/** A transient failure: counted, but the connection stays live. */
export async function recordConnectionFailure(
  db: Database,
  orgId: string,
  reason: string,
): Promise<number> {
  const [row] = await db
    .update(keeperhubConnections)
    .set({ failureCount: sql`${keeperhubConnections.failureCount} + 1`, lastError: reason })
    .where(eq(keeperhubConnections.orgId, orgId))
    .returning();
  return row?.failureCount ?? 0;
}

/**
 * Our own clock running out.
 *
 * Nothing is deleted: the operator reconnects and their workflow choices are
 * still there. Returns who was expired, so they can be told.
 */
export async function expireDueConnections(db: Database, now: Date): Promise<string[]> {
  const rows = await db
    .update(keeperhubConnections)
    .set({ status: 'needs_reauth', lastError: 'The connection reached the lifetime chosen when it was created.' })
    .where(and(eq(keeperhubConnections.status, 'active'), lt(keeperhubConnections.expiresAt, now)))
    .returning({ orgId: keeperhubConnections.orgId });
  return rows.map((r) => r.orgId);
}

/**
 * Disconnect: forget the credential and stop.
 *
 * KeeperHub exposes no revocation endpoint, so this deletes our copy and
 * nothing more. Saying that plainly is better than claiming a revocation we
 * cannot perform.
 */
export async function disconnectKeeperhub(db: Database, orgId: string): Promise<void> {
  await db
    .update(keeperhubConnections)
    .set({ refreshTokenEnc: '', status: 'disconnected', lastError: null })
    .where(eq(keeperhubConnections.orgId, orgId));
}

// --- watched workflows -------------------------------------------------------

export interface WatchedWorkflow {
  orgId: string;
  workflowId: string;
  name: string | null;
  active: boolean;
  connectedAt: Date;
  lastRunAt: Date | null;
}

/** Start watching workflows. Re-adding one that was stopped turns it back on. */
export async function watchWorkflows(
  db: Database,
  params: { orgId: string; workflows: { workflowId: string; name?: string | null }[]; at: Date },
): Promise<void> {
  if (params.workflows.length === 0) return;
  await db
    .insert(watchedWorkflows)
    .values(
      params.workflows.map((w) => ({
        orgId: params.orgId,
        workflowId: w.workflowId,
        name: w.name ?? null,
        active: true,
        connectedAt: params.at,
      })),
    )
    .onConflictDoUpdate({
      target: [watchedWorkflows.orgId, watchedWorkflows.workflowId],
      set: { active: true, name: sql`excluded.name` },
    });
}

export async function unwatchWorkflow(
  db: Database,
  orgId: string,
  workflowId: string,
): Promise<boolean> {
  const rows = await db
    .update(watchedWorkflows)
    .set({ active: false })
    .where(
      and(eq(watchedWorkflows.orgId, orgId), eq(watchedWorkflows.workflowId, workflowId)),
    )
    .returning({ workflowId: watchedWorkflows.workflowId });
  return rows.length > 0;
}

export async function listWatchedWorkflows(
  db: Database,
  orgId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<WatchedWorkflow[]> {
  const where =
    opts.activeOnly === true
      ? and(eq(watchedWorkflows.orgId, orgId), eq(watchedWorkflows.active, true))
      : eq(watchedWorkflows.orgId, orgId);
  return db.select().from(watchedWorkflows).where(where).orderBy(asc(watchedWorkflows.workflowId));
}

/** A run landed. Keeps the console's "last seen" honest, and their name fresh. */
export async function recordWorkflowRun(
  db: Database,
  params: { orgId: string; workflowId: string; name?: string | null; at: Date },
): Promise<void> {
  await db
    .update(watchedWorkflows)
    .set(params.name ? { lastRunAt: params.at, name: params.name } : { lastRunAt: params.at })
    .where(
      and(
        eq(watchedWorkflows.orgId, params.orgId),
        eq(watchedWorkflows.workflowId, params.workflowId),
      ),
    );
}
