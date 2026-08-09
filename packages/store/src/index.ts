import { and, asc, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { ExecutionEvent } from '@blackbox/core';
import {
  executionEvents,
  incidents,
  ingestCursors,
  signerState,
  watchedExecutions,
  watchedTransactions,
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
    .onConflictDoNothing({ target: [executionEvents.sourceId, executionEvents.attemptIndex] })
    .returning({ id: executionEvents.id });
  return inserted.length;
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

/** Upsert by id so a tracked incident's evidence and status stay current. */
export async function saveIncident(db: Database, incident: IncidentRow): Promise<void> {
  await db
    .insert(incidents)
    .values(incident)
    .onConflictDoUpdate({
      target: incidents.id,
      set: {
        severity: incident.severity,
        status: incident.status,
        lastSeenAt: incident.lastSeenAt,
        resolvedAt: incident.resolvedAt ?? null,
        resolvedBy: incident.resolvedBy ?? null,
        confidence: incident.confidence,
        evidence: incident.evidence,
        rca: incident.rca ?? null,
        remediation: incident.remediation ?? null,
      },
    });
}

export async function listIncidents(
  db: Database,
  params: { limit?: number; status?: string } = {},
): Promise<(typeof incidents.$inferSelect)[]> {
  const where = params.status ? eq(incidents.status, params.status) : undefined;
  return db
    .select()
    .from(incidents)
    .where(where)
    .orderBy(desc(incidents.detectedAt))
    .limit(params.limit ?? 100);
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
