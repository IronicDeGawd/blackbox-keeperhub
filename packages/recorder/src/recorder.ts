import {
  detectionFor,
  normaliseExecution,
  type BlackboxConfig,
  type ExecutionEvent,
  type Incident,
  type KeeperHubExecution,
} from '@blackbox/core';
import {
  evaluateRules,
  findNonceGap,
  IncidentTracker,
  type RuleContext,
} from '@blackbox/detector';
import {
  dueExecutions,
  dueTransactions,
  markTransactionPolled,
  insertEvents,
  loadSignerWindow,
  markPolled,
  recordGapObservation,
  saveIncident,
  type Database,
  type WatchedExecution,
  type WatchedTransaction,
} from '@blackbox/store';
import type { CorroborationProvider } from './corroboration.js';
import { enrichEvents, type TransactionProvider } from './enrich.js';
import { buildEventFromChain, type ChainReader } from './chain-source.js';
import type { KeeperHubIngestResult } from './keeperhub-source.js';

/** The one call the recorder makes against KeeperHub. */
export type ExecutionFetcher = {
  getExecutionStatus(executionId: string): Promise<KeeperHubExecution>;
};

export type RecorderOptions = {
  db: Database;
  keeperHub: ExecutionFetcher;
  corroboration: CorroborationProvider;
  /** Optional. Supplies submitted fee data the audit record omits. */
  transactions?: TransactionProvider;
  /** Optional. Observes transactions that have no KeeperHub execution record. */
  chain?: ChainReader;
  /**
   * Optional. Ingests the organisation's whole run history, including runs
   * Blackbox never submitted — the audit trail the PRD calls the input.
   */
  keeperHubRuns?: { ingest(): Promise<KeeperHubIngestResult> };
  /**
   * Optional. Announces incidents somewhere a person will see them. Absent
   * means detection still works and stays inside the process — which is what
   * every deployment did before this existed.
   */
  alerter?: { consider(incident: Incident): Promise<unknown> };
  /**
   * Reads the organisation's daily execution budget, for SPEND_CAP_EXHAUSTED.
   * Absent means that rule declines rather than guesses, which is correct: a
   * budget we cannot read is not a budget we can say anything about.
   */
  spendLimits?: {
    getSpendingLimits(): Promise<{ dailyCapWei: string | null; dailyUsedWei: string | null }>;
  };
  config: BlackboxConfig;
  tracker: IncidentTracker;
  makeId: () => string;
  now?: () => Date;
  /** How far back the per-signer rule window reaches. */
  windowMs?: number;
  batchSize?: number;
  logger?: { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
};

export type TickResult = {
  polled: number;
  settled: number;
  eventsInserted: number;
  /** Runs read from the organisation's KeeperHub history this tick. */
  runsIngested: number;
  signersEvaluated: number;
  incidentsCreated: number;
  incidentsUpdated: number;
  incidentsResolved: number;
  errors: number;
};

const DEFAULT_WINDOW_MS = 60 * 60_000;

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/**
 * The recorder is a long-lived stateful loop, not a request handler. One `tick`
 * is: poll watched executions, normalise and persist what came back, then
 * evaluate rules for every signer that saw activity.
 *
 * Nothing here is allowed to throw. A failing RPC or a single malformed
 * execution must degrade that one item, not stop the loop — the moment the
 * watchdog dies is the moment the incidents it exists to catch go unreported.
 */
export class Recorder {
  private readonly windowMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;

  constructor(private readonly options: RecorderOptions) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.batchSize = options.batchSize ?? 50;
    this.now = options.now ?? (() => new Date());
  }

  async tick(): Promise<TickResult> {
    const result: TickResult = {
      polled: 0,
      settled: 0,
      eventsInserted: 0,
      runsIngested: 0,
      signersEvaluated: 0,
      incidentsCreated: 0,
      incidentsUpdated: 0,
      incidentsResolved: 0,
      errors: 0,
    };

    const due = await dueExecutions(this.options.db, this.batchSize);
    /** Signers touched this tick, so evaluation is scoped to what changed. */
    const touched = new Map<string, { signer: `0x${string}`; chainId: number; agentId: string }>();

    // Runs first: an organisation's history is the widest input, and the
    // signers it touches deserve the same evaluation as a watched execution.
    if (this.options.keeperHubRuns) {
      try {
        const ingested = await this.options.keeperHubRuns.ingest();
        result.runsIngested += ingested.runsIngested;
        result.eventsInserted += ingested.eventsInserted;
        result.errors += ingested.errors;
        for (const target of ingested.touched) {
          touched.set(`${target.signer}|${target.chainId}`, target);
        }
      } catch (error) {
        result.errors += 1;
        this.options.logger?.error('keeperhub run ingest failed', { error });
      }
    }

    for (const watched of due) {
      try {
        const inserted = await this.pollOne(watched);
        result.polled += 1;
        result.eventsInserted += inserted.eventsInserted;
        if (inserted.settled) result.settled += 1;
        touched.set(`${watched.signer}|${watched.chainId}`, {
          signer: watched.signer as `0x${string}`,
          chainId: watched.chainId,
          agentId: watched.agentId,
        });
      } catch (error) {
        result.errors += 1;
        this.options.logger?.error('poll failed', { executionId: watched.executionId, error });
      }
    }

    if (this.options.chain) {
      const dueTx = await dueTransactions(this.options.db, this.batchSize);
      for (const watched of dueTx) {
        try {
          const outcome = await this.pollTransaction(watched);
          result.polled += 1;
          result.eventsInserted += outcome.eventsInserted;
          if (outcome.settled) result.settled += 1;
          touched.set(`${watched.signer}|${watched.chainId}`, {
            signer: watched.signer as `0x${string}`,
            chainId: watched.chainId,
            agentId: watched.agentId,
          });
        } catch (error) {
          result.errors += 1;
          this.options.logger?.error('transaction poll failed', {
            txHash: watched.txHash,
            error,
          });
        }
      }
    }

    for (const target of touched.values()) {
      try {
        const evaluated = await this.evaluateSigner(target);
        result.signersEvaluated += 1;
        result.incidentsCreated += evaluated.created;
        result.incidentsUpdated += evaluated.updated;
        result.incidentsResolved += evaluated.resolved;
      } catch (error) {
        result.errors += 1;
        this.options.logger?.error('evaluation failed', { signer: target.signer, error });
      }
    }

    return result;
  }

  /** Register an execution for watching. Called by the wrapper and the harness. */
  private async pollOne(
    watched: WatchedExecution,
  ): Promise<{ eventsInserted: number; settled: boolean }> {
    const execution = await this.options.keeperHub.getExecutionStatus(watched.executionId);
    const at = this.now();

    const normalised = normaliseExecution(execution, {
      agentId: watched.agentId,
      signer: watched.signer as `0x${string}`,
      chainId: watched.chainId,
      now: at,
      makeId: this.options.makeId,
      ...(watched.submitted ? { submitted: reviveSubmitted(watched.submitted) } : {}),
    });

    // Fee parameters come from the chain, not from KeeperHub. Failure here
    // must not lose the event: better a record without fees than no record.
    let events = normalised;
    if (this.options.transactions) {
      try {
        events = await enrichEvents(normalised, this.options.transactions);
      } catch (error) {
        this.options.logger?.error('enrichment failed', {
          executionId: watched.executionId,
          error,
        });
      }
    }

    const eventsInserted = await insertEvents(this.options.db, events);
    const settled = TERMINAL_STATUSES.has(execution.status);
    await markPolled(this.options.db, watched.executionId, { at, settled });
    return { eventsInserted, settled };
  }

  /** Observe a transaction directly on chain; it has no execution record. */
  private async pollTransaction(
    watched: WatchedTransaction,
  ): Promise<{ eventsInserted: number; settled: boolean }> {
    const at = this.now();
    const built = await buildEventFromChain(this.options.chain!, {
      txHash: watched.txHash as `0x${string}`,
      agentId: watched.agentId,
      signer: watched.signer as `0x${string}`,
      chainId: watched.chainId,
      label: watched.label,
      simulation: deserialiseSimulation(watched.simulation),
      logicalActionId: watched.logicalActionId,
      registeredAt: watched.registeredAt,
      now: at,
      makeId: this.options.makeId,
    });

    const eventsInserted = built.event ? await insertEvents(this.options.db, [built.event]) : 0;
    await markTransactionPolled(this.options.db, watched.txHash, { at, settled: built.settled });
    return { eventsInserted, settled: built.settled };
  }

  private async evaluateSigner(target: {
    signer: `0x${string}`;
    chainId: number;
    agentId: string;
  }): Promise<{ created: number; updated: number; resolved: number }> {
    const now = this.now();

    let corroboration = {};
    try {
      corroboration = await this.options.corroboration.gather(target);
    } catch (error) {
      // Degrade rather than fail: rules that need chain facts will decline to
      // fire, which is preferable to reporting incidents from stale data.
      this.options.logger?.error('corroboration failed', { signer: target.signer, error });
    }

    const window = await loadSignerWindow(this.options.db, {
      signer: target.signer,
      chainId: target.chainId,
      since: new Date(now.getTime() - this.windowMs),
    });

    const c = corroboration as { latestNonce?: number };
    /**
     * A managed wallet has no nonce queue of its own — KeeperHub owns gas
     * estimation, nonce management and ordering, and submits from a shared
     * relayer. Nonces read for such an account belong to KeeperHub's traffic,
     * not this agent's, so deriving a gap from them would manufacture evidence
     * for an incident the agent cannot have.
     */
    const managed = window.some((e) => e.agentKind === 'keeperhub');
    /**
     * Established from what was actually recorded, not configured. A window
     * with no kind on any event leaves this undefined, and every rule is
     * offered the window — the old behaviour, which is right for an agent we
     * have not classified.
     */
    const agentKind = managed
      ? ('keeperhub' as const)
      : window.some((e) => e.agentKind === 'signer')
        ? ('signer' as const)
        : undefined;

    // The gap is derived from what we observed being submitted, not from
    // pending minus latest: a queued transaction does not raise the pending
    // count, so those two are equal during a real gap. The counter is durable
    // so R2 survives a restart mid-gap.
    let consecutiveGapPolls: number | undefined;
    if (c.latestNonce !== undefined && !managed) {
      const { missingNonces } = findNonceGap(window, c.latestNonce);
      consecutiveGapPolls = await recordGapObservation(this.options.db, {
        signer: target.signer,
        chainId: target.chainId,
        gapPresent: missingNonces.length > 0,
        at: now,
      });
    }

    /**
     * Read once per evaluation, and only for a managed wallet — a signer-kind
     * agent pays its own gas, so an organisation budget says nothing about it.
     * A failure here degrades to no spend-cap rule rather than no evaluation.
     */
    let spendCap: { dailyCapWei: bigint | null; dailyUsedWei: bigint } | undefined;
    if (managed && this.options.spendLimits) {
      try {
        const limits = await this.options.spendLimits.getSpendingLimits();
        spendCap = {
          dailyCapWei: limits.dailyCapWei === null ? null : BigInt(limits.dailyCapWei),
          dailyUsedWei: BigInt(limits.dailyUsedWei ?? '0'),
        };
      } catch (error) {
        this.options.logger?.error('spend cap read failed', { error });
      }
    }

    const ctx: RuleContext = {
      now,
      detection: detectionFor(this.options.config, target.chainId),
      agentId: target.agentId,
      signer: target.signer,
      chainId: target.chainId,
      ...(agentKind ? { agentKind } : {}),
      corroboration: {
        ...corroboration,
        ...(consecutiveGapPolls !== undefined ? { consecutiveGapPolls } : {}),
        // Without this, a rule reading `latestNonce` cannot tell a wallet whose
        // nonces the agent controls from one whose nonces it does not.
        ...(managed ? { managedNonces: true } : {}),
        ...(spendCap ? { spendCap } : {}),
      },
    };

    const drafts = evaluateRules(window, ctx);
    const { created, updated, resolved } = this.options.tracker.ingest(drafts, window, ctx);

    for (const incident of [...created, ...updated, ...resolved]) {
      await saveIncident(this.options.db, {
        id: incident.id,
        key: incident.key,
        class: incident.class,
        severity: incident.severity,
        status: incident.status,
        agentId: incident.agentId,
        signer: incident.signer,
        chainId: incident.chainId,
        detectedAt: incident.detectedAt,
        firstEventAt: incident.firstEventAt,
        lastSeenAt: incident.lastSeenAt,
        resolvedAt: incident.resolvedAt ?? null,
        resolvedBy: incident.resolvedBy ?? null,
        ruleId: incident.evidence.ruleId,
        confidence: incident.confidence,
        evidence: serialiseEvidence(incident.evidence),
        rca: incident.rca ?? null,
        remediation: incident.remediation ?? null,
      });

      // After the save, so an alert never describes a state that was not
      // persisted. The alerter decides whether this is worth saying at all.
      try {
        await this.options.alerter?.consider(incident);
      } catch (error) {
        // Delivery is not allowed to cost a detection.
        this.options.logger?.error('alerting failed', { incidentId: incident.id, error });
      }
    }

    return { created: created.length, updated: updated.length, resolved: resolved.length };
  }
}

/** Evidence holds bigints from corroboration; JSONB needs them as strings. */
function serialiseEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Record<string, unknown>;
}

function reviveSubmitted(stored: unknown): {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
  route?: 'public' | 'private';
} {
  const s = stored as Record<string, unknown>;
  return {
    ...(s['maxFeePerGas'] ? { maxFeePerGas: BigInt(String(s['maxFeePerGas'])) } : {}),
    ...(s['maxPriorityFeePerGas']
      ? { maxPriorityFeePerGas: BigInt(String(s['maxPriorityFeePerGas'])) }
      : {}),
    ...(s['nonce'] !== undefined && s['nonce'] !== null ? { nonce: Number(s['nonce']) } : {}),
    ...(s['route'] === 'public' || s['route'] === 'private'
      ? { route: s['route'] as 'public' | 'private' }
      : {}),
  };
}

/**
 * Rehydrate a simulation the submitter recorded when it registered the
 * transaction. `gasEstimate` was stored as a decimal string, since JSONB has no
 * bigint.
 */
function deserialiseSimulation(raw: unknown): ExecutionEvent['simulation'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const sim = raw as Record<string, unknown>;
  return {
    performed: Boolean(sim['performed']),
    ...(sim['success'] !== undefined && sim['success'] !== null
      ? { success: Boolean(sim['success']) }
      : {}),
    ...(sim['simulatedAtBlock'] !== undefined && sim['simulatedAtBlock'] !== null
      ? { simulatedAtBlock: Number(sim['simulatedAtBlock']) }
      : {}),
    ...(sim['gasEstimate'] !== undefined && sim['gasEstimate'] !== null
      ? { gasEstimate: BigInt(String(sim['gasEstimate'])) }
      : {}),
    ...(sim['revertReason'] ? { revertReason: String(sim['revertReason']) } : {}),
  };
}
