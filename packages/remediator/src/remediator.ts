import type { AgentKind, BlackboxConfig, Incident, RemediationRecord } from '@blackbox/core';
import { recordRemediationAttempt, type Database } from '@blackbox/store';
import { evaluateGuards, mutexKey, type GuardName } from './guards.js';
import {
  playbookFor,
  servability,
  type ExecutorKind,
  type PlaybookPlan,
  type PlanContext,
} from './playbooks.js';

/**
 * Submits the transaction a playbook planned and reports what happened.
 *
 * Deliberately an interface: the remediator must not care whether the write
 * went through KeeperHub or straight to a node, and tests must be able to
 * drive it without a chain. What it must never do is fabricate a hash — an
 * implementation that cannot submit has to throw.
 */
export type RemediationExecutor = {
  submit(params: {
    plan: Extract<PlaybookPlan, { kind: 'submit' }>;
    incident: Incident;
  }): Promise<{
    txHash: `0x${string}`;
    keeperHubActionId?: string;
    /** Which path put it on chain, for the ledger and the console. */
    executor?: 'signer' | 'keeperhub' | 'keeperhub-workflow';
  }>;
  /** Resolves once the submission is confirmed, or rejects on timeout. */
  verify(params: {
    txHash: `0x${string}`;
    incident: Incident;
    timeoutMs: number;
  }): Promise<{
    included: boolean;
    gasUsed?: bigint;
    effectiveGasPrice?: bigint;
    uncertain?: boolean;
    detail?: string;
  }>;
};

export type MarketData = {
  baseFee: bigint;
  suggestedPriorityFee: bigint;
  signerBalance?: bigint;
};

export type RemediatorOptions = {
  db: Database;
  config: BlackboxConfig;
  executor: RemediationExecutor;
  market: (incident: Incident) => Promise<MarketData>;
  makeId: () => string;
  now?: () => Date;
  /** Registered circuit breakers, by agent id (P4). */
  breakers?: Record<string, `0x${string}`>;
  fundingWallet?: `0x${string}`;
  /**
   * How the agent behind an incident executes, when it has been established.
   * Absent means unknown, and an unknown agent is offered every playbook —
   * declining on a guess would refuse a fix somebody could have used.
   */
  agentKind?: (incident: Incident) => AgentKind | undefined;
  /**
   * What this deployment can actually execute with. Defaults to the executor
   * it was given, which is the honest answer for a process holding one.
   */
  executorKinds?: readonly ExecutorKind[];
  logger?: { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
};

export type RemediationOutcome = {
  record: RemediationlikeRecord;
  /** Named so the console can show why Blackbox declined. */
  guardsFailed: { guard: GuardName; reason: string }[];
};

type RemediationlikeRecord = RemediationRecord & { playbookId: string };

export class Remediator {
  /** Per-signer mutex. Two remediations on one signer collide on nonce. */
  private readonly inFlight = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly options: RemediatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** What this process can execute with, as the router understands it. */
  private executors(): readonly ExecutorKind[] {
    return this.options.executorKinds ?? ['signer', 'keeperhub', 'keeperhub-workflow'];
  }

  get busySigners(): string[] {
    return [...this.inFlight];
  }

  /**
   * Attempt to remediate one incident.
   *
   * Never throws for an expected outcome. A blocked guard, an unavailable
   * playbook and a failed submission are all results that must be recorded and
   * shown, because "Blackbox declined, and here is why" is as much a part of
   * the audit trail as a successful fix.
   */
  async remediate(incident: Incident): Promise<RemediationOutcome> {
    const playbook = playbookFor(incident.class);
    if (!playbook) {
      return {
        record: skipped('none', 'skipped_by_policy', this.now(), `no playbook handles ${incident.class}`),
        guardsFailed: [],
      };
    }

    /**
     * Refuse before spending anything, and say why.
     *
     * "No remediation available" is a worse answer than "this agent's nonces
     * are managed by KeeperHub, so a replacement submission is not something
     * anyone here can send". The first sounds like a missing feature; the
     * second is a fact about the agent that an operator can act on.
     */
    const serve = servability(playbook, this.options.agentKind?.(incident), this.executors());
    if (!serve.servable) {
      return {
        record: skipped(playbook.id, 'skipped_by_policy', this.now(), serve.reason ?? 'not servable'),
        guardsFailed: [],
      };
    }

    const guards = await evaluateGuards({
      db: this.options.db,
      config: this.options.config,
      incident,
      now: this.now(),
      inFlight: this.inFlight,
    });

    if (guards.failed.length > 0) {
      const at = this.now();
      const record: RemediationlikeRecord = {
        playbookId: playbook.id,
        attempts: [
          {
            attemptIndex: 0,
            startedAt: at,
            guardsPassed: guards.passed,
            guardsFailed: guards.failed.map((f) => f.guard),
            status: 'skipped',
            failureReason: guards.failed.map((f) => `${f.guard}: ${f.reason}`).join('; '),
            completedAt: at,
          },
        ],
        finalStatus: 'skipped_by_guard',
      };
      return { record, guardsFailed: guards.failed };
    }

    const market = await this.options.market(incident);
    const planCtx: PlanContext = {
      incident,
      config: this.options.config,
      baseFee: market.baseFee,
      suggestedPriorityFee: market.suggestedPriorityFee,
      ...(market.signerBalance !== undefined ? { signerBalance: market.signerBalance } : {}),
      ...(this.options.breakers?.[incident.agentId]
        ? { breakerAddress: this.options.breakers[incident.agentId]! }
        : {}),
      ...(this.options.fundingWallet ? { fundingWallet: this.options.fundingWallet } : {}),
    };

    const plan = playbook.plan(planCtx);
    if (plan.kind === 'skip') {
      const at = this.now();
      await this.record(incident, playbook.id, at, 'skipped');
      return {
        record: skipped(playbook.id, plan.policy, at, plan.reason, guards.passed),
        guardsFailed: [],
      };
    }

    // Held across submission *and* verification: releasing early would let a
    // second remediation pick the same nonce while the first is still settling.
    const key = mutexKey(incident.signer, incident.chainId);
    this.inFlight.add(key);
    const startedAt = this.now();
    try {
      const { txHash, keeperHubActionId, executor } = await this.options.executor.submit({
        plan,
        incident,
      });
      let included = false;
      let gasUsed: bigint | undefined;
      let gasSpentWei: bigint | undefined;
      let failureReason: string | undefined;

      try {
        const verified = await this.options.executor.verify({
          txHash,
          incident,
          timeoutMs: this.options.config.remediation.verifyTimeoutMs,
        });
        included = verified.included;
        gasUsed = verified.gasUsed;
        // What it cost, rather than how much gas it burned. Without the price
        // the ledger records a count of gas in a column named for wei, which
        // understates every remediation by roughly nine orders of magnitude.
        gasSpentWei =
          verified.gasUsed !== undefined && verified.effectiveGasPrice !== undefined
            ? verified.gasUsed * verified.effectiveGasPrice
            : undefined;
        if (!included) {
          // Says which of the two happened. An operator deciding whether to
          // resubmit needs to know the difference between "the chain did not
          // include it" and "we never managed to ask", and resubmitting a
          // transaction that actually landed is its own incident.
          failureReason = verified.uncertain
            ? `submitted, but inclusion could not be verified — ${verified.detail ?? 'no node answered'}. ` +
              `This is not proof it failed; check the hash before resubmitting.`
            : 'submitted but not confirmed within the verify timeout';
        }
      } catch (error) {
        failureReason = `verification failed: ${(error as Error).message}`;
      }

      await this.record(
        incident,
        playbook.id,
        startedAt,
        included ? 'succeeded' : 'failed',
        gasSpentWei,
        txHash,
        executor,
      );

      const completedAt = this.now();
      return {
        record: {
          playbookId: playbook.id,
          attempts: [
            {
              attemptIndex: 0,
              startedAt,
              guardsPassed: guards.passed,
              guardsFailed: [],
              txHash,
              ...(keeperHubActionId ? { keeperHubActionId } : {}),
              ...(executor ? { executor } : {}),
              status: included ? 'succeeded' : 'failed',
              ...(failureReason ? { failureReason } : {}),
              ...(gasUsed !== undefined ? { gasUsed } : {}),
              completedAt,
            },
          ],
          finalStatus: included ? 'succeeded' : 'failed',
          ...(included ? { verifiedAt: completedAt } : {}),
        },
        guardsFailed: [],
      };
    } catch (error) {
      // A submission that could not be made is a failed remediation with its
      // own record, surfaced loudly. It is never silently dropped.
      const completedAt = this.now();
      await this.record(incident, playbook.id, startedAt, 'failed');
      this.options.logger?.error('remediation submission failed', {
        incidentId: incident.id,
        error,
      });
      return {
        record: {
          playbookId: playbook.id,
          attempts: [
            {
              attemptIndex: 0,
              startedAt,
              guardsPassed: guards.passed,
              guardsFailed: [],
              status: 'failed',
              failureReason: (error as Error).message,
              completedAt,
            },
          ],
          finalStatus: 'failed',
        },
        guardsFailed: [],
      };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async record(
    incident: Incident,
    playbookId: string,
    at: Date,
    status: string,
    gasSpentWei?: bigint,
    txHash?: string,
    executor?: string,
  ): Promise<void> {
    // Every attempt is ledgered, including failures and skips: they cost gas or
    // capacity, and the budget guard has to see them.
    await recordRemediationAttempt(this.options.db, {
      id: this.options.makeId(),
      incidentId: incident.id,
      playbookId,
      signer: incident.signer,
      chainId: incident.chainId,
      // What the per-agent daily cap counts.
      agentId: incident.agentId,
      attemptedAt: at,
      // Cost, not units. `gasUsed` is a count of gas; what the budget guard
      // and the ledger care about is what it was bought for.
      ...(gasSpentWei !== undefined ? { gasSpentWei } : {}),
      status,
      ...(txHash ? { txHash } : {}),
      ...(executor ? { executor } : {}),
    });
  }
}

function skipped(
  playbookId: string,
  policy: 'skipped_by_policy',
  at: Date,
  reason: string,
  guardsPassed: GuardName[] = [],
): RemediationlikeRecord {
  return {
    playbookId,
    attempts: [
      {
        attemptIndex: 0,
        startedAt: at,
        guardsPassed,
        guardsFailed: [],
        status: 'skipped',
        failureReason: reason,
        completedAt: at,
      },
    ],
    finalStatus: policy,
  };
}
