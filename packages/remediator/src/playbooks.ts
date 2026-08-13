import {
  getChain,
  type AgentKind,
  type BlackboxConfig,
  type Incident,
  type IncidentClass,
} from '@blackbox/core';

/**
 * Remediation playbooks (PRD §6).
 *
 * A playbook decides *what* to submit and *how to know it worked*. It never
 * decides *whether* to act — that is the guards' job — and it never invents a
 * transaction: if the preconditions for a real submission are absent, it
 * declines with a reason rather than pretending.
 */

export type PlaybookId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7';

/** A concrete chain write, or a refusal with the reason stated. */
export type PlaybookPlan =
  | {
      kind: 'submit';
      description: string;
      /** Replacement submissions reuse a nonce deliberately. */
      nonce?: number;
      to: `0x${string}`;
      value: bigint;
      data?: `0x${string}`;
      /**
       * The same call named at ABI level. KeeperHub's contract-call endpoint
       * takes a function name and arguments, not raw calldata, so a plan that
       * should be submittable through KeeperHub has to carry both forms.
       */
      call?: { functionName: string; args: unknown[]; abi?: string };
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      route: 'public' | 'private';
    }
  | { kind: 'skip'; policy: 'skipped_by_policy'; reason: string };

export type PlanContext = {
  incident: Incident;
  config: BlackboxConfig;
  /** Current market rate, so a replacement is priced to actually displace. */
  baseFee: bigint;
  suggestedPriorityFee: bigint;
  /** Registered circuit breaker for this agent, if it has one (P4). */
  breakerAddress?: `0x${string}`;
  /** Funding wallet for top-ups (P5). */
  fundingWallet?: `0x${string}`;
  signerBalance?: bigint;
};

/**
 * Who can carry out a plan.
 *
 * `signer` puts a transaction on chain with a key Blackbox holds; `keeperhub`
 * submits through the platform, which chooses fees and nonces itself;
 * `keeperhub-workflow` runs a workflow; `user-signed` means a human's wallet
 * signs what Blackbox planned. They are not interchangeable — a plan that
 * carries a nonce cannot be executed by something that manages its own.
 */
export type ExecutorKind = 'signer' | 'keeperhub' | 'keeperhub-workflow' | 'user-signed';

export type Playbook = {
  id: PlaybookId;
  handles: IncidentClass[];
  /**
   * Which kinds of agent this playbook can fix.
   *
   * Declared rather than discovered at the moment of failure, so the router can
   * say "nothing here can serve this" before spending anything — and so a
   * console can show an operator why a fix is not on offer.
   */
  appliesTo: readonly AgentKind[];
  /**
   * Why this playbook cannot serve a kind of agent, in the operator's terms.
   *
   * "P1 does not apply to a keeperhub agent" is true and useless; it names a
   * rule rather than a reason, and leaves the operator with nothing to do.
   * Where the answer is structural, say what the structure is.
   */
  inapplicable?: Partial<Record<AgentKind, string>>;
  /**
   * Which executors can carry it out. A plan that names a nonce needs a signer;
   * one that pauses a contract does not care who sends it.
   */
  executors: readonly ExecutorKind[];
  plan: (ctx: PlanContext) => PlaybookPlan;
};

/**
 * Can this playbook be served at all, for this agent, by these executors?
 *
 * Returns the reason when it cannot, because "no remediation available" is a
 * worse answer than "this agent's nonces are managed by KeeperHub, so a
 * replacement submission is not something anyone here can send".
 */
export function servability(
  playbook: Playbook,
  agentKind: AgentKind | undefined,
  availableExecutors: readonly ExecutorKind[],
): { servable: boolean; reason?: string } {
  if (agentKind && !playbook.appliesTo.includes(agentKind)) {
    return {
      servable: false,
      reason:
        playbook.inapplicable?.[agentKind] ??
        `${playbook.id} does not apply to a ${agentKind} agent`,
    };
  }
  const usable = playbook.executors.filter((e) => availableExecutors.includes(e));
  if (usable.length === 0) {
    return {
      servable: false,
      reason: `${playbook.id} needs one of ${playbook.executors.join(', ')}; this deployment has ${
        availableExecutors.length > 0 ? availableExecutors.join(', ') : 'none'
      }`,
    };
  }
  return { servable: true };
}

const fact = (incident: Incident, key: string): unknown => incident.evidence.facts[key];

const asBigInt = (v: unknown): bigint | undefined => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  return undefined;
};

/**
 * P1 — replacement submission.
 *
 * Resubmits at the same nonce with a meaningfully higher fee. The 12.5%
 * replacement rule is a floor, not a target: a replacement that fails to
 * displace is worse than none, because it consumes a submission slot and the
 * time it takes to find out.
 */
export const P1: Playbook = {
  id: 'P1',
  handles: ['GAS_UNDERPRICED', 'STUCK_TRANSACTION'],
  inapplicable: {
    keeperhub:
      'KeeperHub prices and re-prices its own submissions through the sponsored relayer, ' +
      'and a replacement has to reuse the original nonce — which belongs to that relayer, ' +
      'not to this agent. Raise it with KeeperHub if their gas strategy is leaving ' +
      'transactions unmined.',
  },
  // A replacement reuses the stuck transaction's nonce, so it can only be sent
  // by something that controls that nonce. KeeperHub manages its own.
  appliesTo: ['signer'],
  executors: ['signer', 'user-signed'],
  plan(ctx) {
    const nonce = fact(ctx.incident, 'nonce');
    if (typeof nonce !== 'number') {
      return {
        kind: 'skip',
        policy: 'skipped_by_policy',
        reason: 'no nonce recorded on the incident, so there is nothing to replace',
      };
    }

    const previousFee =
      asBigInt(fact(ctx.incident, 'submittedMaxFee')) ??
      asBigInt(fact(ctx.incident, 'submittedMaxFeePerGas')) ??
      0n;

    const bump = BigInt(Math.round(ctx.config.remediation.bumpMultiple * 100));
    const floor = (previousFee * 115n) / 100n; // the protocol's 12.5%, rounded up
    const market = ((ctx.baseFee * 2n + ctx.suggestedPriorityFee) * bump) / 100n;
    const maxFeePerGas = market > floor ? market : floor;
    const maxPriorityFeePerGas = (ctx.suggestedPriorityFee * bump) / 100n;

    const chain = getChain(ctx.incident.chainId);
    return {
      kind: 'submit',
      description: `replace nonce ${nonce} at ${maxFeePerGas} wei`,
      nonce,
      // A zero-value self-send replaces the stuck transaction without
      // re-executing whatever it was trying to do. Replaying unknown calldata
      // could double-spend an action that is merely slow rather than lost.
      to: ctx.incident.signer,
      value: 0n,
      maxFeePerGas,
      maxPriorityFeePerGas,
      route: chain.privateMempool ? 'private' : 'public',
    };
  },
};

/**
 * P2 — nonce gap clear.
 *
 * Fills the lowest missing nonce with a zero-value self-send, priced to be
 * included promptly. A slow fill leaves every later transaction wedged.
 */
export const P2: Playbook = {
  id: 'P2',
  handles: ['NONCE_GAP'],
  // Filling a gap means sending *at* the missing nonce. Only a key holder can.
  appliesTo: ['signer'],
  executors: ['signer', 'user-signed'],
  plan(ctx) {
    const missing = fact(ctx.incident, 'missingNonces');
    const lowest = Array.isArray(missing) ? missing.find((n) => typeof n === 'number') : undefined;
    if (typeof lowest !== 'number') {
      return {
        kind: 'skip',
        policy: 'skipped_by_policy',
        reason: 'no missing nonce recorded on the incident',
      };
    }

    const chain = getChain(ctx.incident.chainId);
    return {
      kind: 'submit',
      description: `fill missing nonce ${lowest}`,
      nonce: lowest,
      to: ctx.incident.signer,
      value: 0n,
      // Aggressive on purpose: this transaction unblocks everything behind it.
      maxFeePerGas: ctx.baseFee * 3n + ctx.suggestedPriorityFee,
      maxPriorityFeePerGas: ctx.suggestedPriorityFee * 2n,
      route: chain.privateMempool ? 'private' : 'public',
    };
  },
};

/**
 * P3 — private reroute.
 *
 * Unavailable on chains with no private mempool, which includes Base and Base
 * Sepolia (KeeperHub's own `usePrivateMempoolRpc` is false there). There is
 * nothing to reroute *to*, so it declines rather than resubmitting publicly
 * and calling that a fix.
 *
 * Even where a private route exists, a blind replay is refused unless the
 * action is declared replay-safe. Never re-send a value transfer on the
 * assumption it was lost.
 */
export const P3: Playbook = {
  id: 'P3',
  handles: ['ADVERSE_INCLUSION'],
  inapplicable: {
    keeperhub:
      'Rerouting means resubmitting the same action through a private mempool, which ' +
      'requires signing as the agent. KeeperHub submits from a shared relayer, so there ' +
      'is nothing here for Blackbox to reroute.',
  },
  // Rerouting picks the mempool a transaction is sent to, which is a choice
  // KeeperHub makes for itself.
  appliesTo: ['signer'],
  executors: ['signer'],
  plan(ctx) {
    const chain = getChain(ctx.incident.chainId);
    if (!chain.privateMempool) {
      return {
        kind: 'skip',
        policy: 'skipped_by_policy',
        reason: `${chain.name} has no private mempool, so there is no alternative route to submit through`,
      };
    }
    return {
      kind: 'skip',
      policy: 'skipped_by_policy',
      reason:
        'the action is not declared replay-safe; rerouting would re-execute it, and a value transfer must never be blind-replayed',
    };
  },
};

/**
 * P4 — circuit breaker.
 *
 * Calls `pause()` on the agent's registered breaker. Requires the agent to
 * have registered a contract and granted Blackbox the pauser role; without
 * that there is nothing to call.
 */
const PAUSE_SELECTOR = '0x8456cb59' as const; // pause()

export const P4: Playbook = {
  id: 'P4',
  handles: ['RETRY_STORM', 'SIM_PASS_EXEC_REVERT', 'WORKFLOW_MISCONFIGURED'],
  /**
   * Pausing a contract carries no nonce and asks nothing of the sender beyond
   * having the pauser role — so it works for either kind of agent, and is the
   * one playbook a managed wallet can actually be served by today.
   */
  appliesTo: ['signer', 'keeperhub'],
  executors: ['signer', 'keeperhub', 'keeperhub-workflow', 'user-signed'],
  plan(ctx) {
    if (!ctx.breakerAddress) {
      return {
        kind: 'skip',
        policy: 'skipped_by_policy',
        reason:
          'no circuit breaker registered for this agent; register one and grant Blackbox the pauser role to enable auto-halt',
      };
    }
    const chain = getChain(ctx.incident.chainId);
    return {
      kind: 'submit',
      description: `pause the circuit breaker at ${ctx.breakerAddress}`,
      to: ctx.breakerAddress,
      value: 0n,
      data: PAUSE_SELECTOR,
      call: { functionName: 'pause', args: [] },
      maxFeePerGas: ctx.baseFee * 2n + ctx.suggestedPriorityFee,
      maxPriorityFeePerGas: ctx.suggestedPriorityFee,
      route: chain.privateMempool ? 'private' : 'public',
    };
  },
};

/**
 * P5 — signer top-up.
 *
 * Sends enough for a target number of further actions, from a funding wallet
 * to the starved signer.
 */
export const P5: Playbook = {
  id: 'P5',
  handles: ['SIGNER_GAS_STARVED'],
  inapplicable: {
    keeperhub:
      'A managed wallet is funded through KeeperHub, not by a transfer from Blackbox. ' +
      'Top it up in KeeperHub, or raise the organisation spending cap.',
  },
  // Topping up a balance only helps an agent that pays from one. A managed
  // wallet's equivalent problem is the organisation's spend cap, which is
  // raised in KeeperHub's own settings rather than fixed by a transfer.
  appliesTo: ['signer'],
  executors: ['signer', 'user-signed'],
  plan(ctx) {
    if (!ctx.fundingWallet) {
      return {
        kind: 'skip',
        policy: 'skipped_by_policy',
        reason: 'no funding wallet configured, so there is nothing to top up from',
      };
    }
    const medianCost = asBigInt(fact(ctx.incident, 'medianRecentCost'));
    if (medianCost === undefined || medianCost === 0n) {
      return {
        kind: 'skip',
        policy: 'skipped_by_policy',
        reason: 'no spend history to size a top-up from',
      };
    }

    const chain = getChain(ctx.incident.chainId);
    const amount = medianCost * BigInt(ctx.config.remediation.topupActionsTarget);
    return {
      kind: 'submit',
      description: `top up ${ctx.incident.signer} with ${amount} wei`,
      to: ctx.incident.signer,
      value: amount,
      maxFeePerGas: ctx.baseFee * 2n + ctx.suggestedPriorityFee,
      maxPriorityFeePerGas: ctx.suggestedPriorityFee,
      route: chain.privateMempool ? 'private' : 'public',
    };
  },
};

/**
 * P6 — a stalled workflow.
 *
 * There is nothing to submit. A workflow that has not finished is KeeperHub's
 * to cancel or continue, and sending a transaction would not touch it. The
 * playbook exists so the answer is "here is what to do and why Blackbox is not
 * doing it" rather than "no playbook handles EXECUTION_STALLED", which reads
 * like a missing feature instead of a considered position.
 */
export const P6: Playbook = {
  id: 'P6',
  handles: ['EXECUTION_STALLED'],
  appliesTo: ['keeperhub'],
  executors: ['keeperhub', 'keeperhub-workflow'],
  plan(ctx) {
    const workflowId = fact(ctx.incident, 'workflowId');
    const name = fact(ctx.incident, 'workflowName');
    return {
      kind: 'skip',
      policy: 'skipped_by_policy',
      reason:
        `${name ? `workflow "${String(name)}"` : 'this workflow'} has not finished` +
        `${workflowId ? ` (${String(workflowId)})` : ''}. Nothing on chain can end it: ` +
        `cancel or re-run it in KeeperHub, and check the step it stopped at.`,
    };
  },
};

/**
 * P7 — the organisation's daily budget.
 *
 * Raising a spend cap is a billing action inside KeeperHub, not a transaction,
 * so no executor here can serve it. Saying exactly that is more use than
 * silence, because the operator's next move is a specific one.
 */
export const P7: Playbook = {
  id: 'P7',
  handles: ['SPEND_CAP_EXHAUSTED'],
  appliesTo: ['keeperhub'],
  executors: ['keeperhub'],
  plan(ctx) {
    const used = fact(ctx.incident, 'dailyUsedWei');
    const cap = fact(ctx.incident, 'dailyCapWei');
    const exhausted = fact(ctx.incident, 'exhausted') === true;
    return {
      kind: 'skip',
      policy: 'skipped_by_policy',
      reason:
        (exhausted
          ? 'the daily execution budget is spent, so KeeperHub will submit nothing more today'
          : 'the daily execution budget is nearly spent') +
        `${cap ? ` (${String(used)} of ${String(cap)} wei)` : ''}. ` +
        `Raise the cap in KeeperHub's organisation settings, or wait for it to reset; ` +
        `no transaction can fix this one.`,
    };
  },
};

export const ALL_PLAYBOOKS: readonly Playbook[] = [P1, P2, P3, P4, P5, P6, P7];

/**
 * The playbook for an incident class.
 *
 * P1 handles both stuck and underpriced transactions, and R3 already suppresses
 * R1 when both fire, so one incident maps to exactly one playbook.
 */
export function playbookFor(cls: IncidentClass): Playbook | undefined {
  return ALL_PLAYBOOKS.find((p) => p.handles.includes(cls));
}
