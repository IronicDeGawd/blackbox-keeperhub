import { getChain, type BlackboxConfig, type Incident, type IncidentClass } from '@blackbox/core';

/**
 * Remediation playbooks (PRD §6).
 *
 * A playbook decides *what* to submit and *how to know it worked*. It never
 * decides *whether* to act — that is the guards' job — and it never invents a
 * transaction: if the preconditions for a real submission are absent, it
 * declines with a reason rather than pretending.
 */

export type PlaybookId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

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

export type Playbook = {
  id: PlaybookId;
  handles: IncidentClass[];
  plan: (ctx: PlanContext) => PlaybookPlan;
};

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
  handles: ['RETRY_STORM', 'SIM_PASS_EXEC_REVERT'],
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

export const ALL_PLAYBOOKS: readonly Playbook[] = [P1, P2, P3, P4, P5];

/**
 * The playbook for an incident class.
 *
 * P1 handles both stuck and underpriced transactions, and R3 already suppresses
 * R1 when both fire, so one incident maps to exactly one playbook.
 */
export function playbookFor(cls: IncidentClass): Playbook | undefined {
  return ALL_PLAYBOOKS.find((p) => p.handles.includes(cls));
}
