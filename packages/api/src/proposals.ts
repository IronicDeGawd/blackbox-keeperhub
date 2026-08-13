import { getChain, type BlackboxConfig, type Incident } from '@blackbox/core';
import { evaluateGuards, playbookFor, type PlaybookPlan } from '@blackbox/remediator';
import { recordRemediationAttempt, saveIncident, type Database } from '@blackbox/store';

/**
 * Remediation that Blackbox plans and somebody else signs.
 *
 * Filling a nonce gap or replacing a stuck transaction means occupying a
 * specific nonce on a specific account, which only that account's key can do.
 * Blackbox holding a stranger's private key is not an acceptable answer, so the
 * work splits: Blackbox decides exactly what transaction is needed and proves
 * why, the owner's wallet signs it, and Blackbox verifies what landed.
 *
 * The invariant in PRD §0 is untouched — a real transaction with a retrievable
 * hash, no simulation anywhere. What changes is custody.
 *
 * The provenance must not blur. An attempt submitted this way is recorded as
 * `user-signed`, because "Blackbox fixed this" and "Blackbox told me how to fix
 * this and I approved it" are different claims, and only one of them is true
 * here.
 */

export type MarketReader = (incident: Incident) => Promise<{
  baseFee: bigint;
  suggestedPriorityFee: bigint;
  signerBalance?: bigint;
}>;

export type ProposalDeps = {
  db: Database;
  config: BlackboxConfig;
  market: MarketReader;
  /** The circuit breaker registered for an agent, if any (P4). */
  breakerFor?: (agentId: string) => Promise<`0x${string}` | null>;
  fundingWallet?: `0x${string}`;
  now?: () => Date;
};

export type Proposal = {
  incidentId: string;
  playbookId: string | null;
  /**
   * Whether Blackbox could carry this out *itself*.
   *
   * Not the same question as whether there is anything to do: a plan whose
   * guards blocked autonomous action still carries a transaction for the
   * owner's wallet to sign, and a console reading only this field would hide
   * the button that is the entire point of the propose-and-verify path.
   */
  actionable: boolean;
  /** Whether a wallet has something to sign. Read this to show the button. */
  signable: boolean;
  /** Who must sign. A wallet connected as anyone else cannot help. */
  signerRequired: string;
  chainId: number;
  guards: { passed: string[]; failed: { guard: string; reason: string }[] };
  transaction: {
    to: string;
    value: string;
    data: string | null;
    nonce: number | null;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    chainId: number;
    description: string;
    route: string;
  } | null;
  declined: { policy: string; reason: string } | null;
};

/**
 * Work out what transaction would fix this incident, without submitting it.
 *
 * Guards still run. A plan that the guards would refuse is returned with the
 * refusal attached rather than withheld: an operator deciding whether to sign
 * deserves to see both what Blackbox would do and why Blackbox itself would
 * not. Only `dry_run` is ignored, since a human signing is not the automation
 * that flag exists to hold back.
 */
export async function buildProposal(
  deps: ProposalDeps,
  incident: Incident,
): Promise<Proposal> {
  const now = deps.now?.() ?? new Date();
  const playbook = playbookFor(incident.class);

  const base: Proposal = {
    incidentId: incident.id,
    playbookId: playbook?.id ?? null,
    actionable: false,
    signable: false,
    signerRequired: incident.signer,
    chainId: incident.chainId,
    guards: { passed: [], failed: [] },
    transaction: null,
    declined: null,
  };

  if (!playbook) {
    return { ...base, declined: { policy: 'no_playbook', reason: `no playbook handles ${incident.class}` } };
  }

  const guards = await evaluateGuards({
    db: deps.db,
    config: deps.config,
    incident,
    now,
    inFlight: new Set(),
  });
  // A human at a wallet is not the unattended automation `dry_run` guards
  // against, so it does not block a proposal — every other guard still does.
  const failed = guards.failed.filter((f) => f.guard !== 'dry_run');

  const market = await deps.market(incident);
  const breakerAddress = (await deps.breakerFor?.(incident.agentId)) ?? null;
  const plan: PlaybookPlan = playbook.plan({
    incident,
    config: deps.config,
    baseFee: market.baseFee,
    suggestedPriorityFee: market.suggestedPriorityFee,
    ...(market.signerBalance !== undefined ? { signerBalance: market.signerBalance } : {}),
    ...(breakerAddress ? { breakerAddress } : {}),
    ...(deps.fundingWallet ? { fundingWallet: deps.fundingWallet } : {}),
  });

  const guardReport = {
    passed: guards.passed.filter((g) => g !== 'dry_run'),
    failed,
  };

  if (plan.kind === 'skip') {
    return {
      ...base,
      playbookId: playbook.id,
      guards: guardReport,
      declined: { policy: plan.policy, reason: plan.reason },
    };
  }

  return {
    ...base,
    playbookId: playbook.id,
    actionable: failed.length === 0,
    // There is a transaction, so somebody can act — whatever the guards said
    // about Blackbox acting unattended.
    signable: true,
    guards: guardReport,
    transaction: {
      to: plan.to,
      // Wei as a decimal string all the way to the wallet: these values exceed
      // what a JSON number can carry without silently rounding.
      value: plan.value.toString(),
      data: plan.data ?? null,
      nonce: plan.nonce ?? null,
      maxFeePerGas: plan.maxFeePerGas.toString(),
      maxPriorityFeePerGas: plan.maxPriorityFeePerGas.toString(),
      chainId: incident.chainId,
      description: plan.description,
      route: plan.route,
    },
  };
}

export type SubmittedTransaction = {
  from: string;
  to: string | null;
  nonce: number;
};

export type VerifyDeps = {
  db: Database;
  getTransaction: (hash: `0x${string}`) => Promise<SubmittedTransaction | null>;
  waitForReceipt: (
    hash: `0x${string}`,
  ) => Promise<{ included: boolean; gasUsed?: bigint; effectiveGasPrice?: bigint }>;
  makeId: () => string;
  now?: () => Date;
};

export type VerifyResult = {
  accepted: boolean;
  reason?: string;
  included?: boolean;
  gasUsed?: string;
  explorerUrl?: string;
};

/**
 * Accept a transaction someone else signed as the remediation for an incident.
 *
 * Checked before it is believed. A hash is not evidence on its own: it must
 * come from the incident's own signer and, when the plan named a nonce, occupy
 * exactly that nonce. Without those checks any hash at all could be posted to
 * mark an incident fixed, and the audit trail would be worth nothing.
 */
export async function verifyUserSubmission(
  deps: VerifyDeps,
  incident: Incident,
  proposal: Proposal,
  txHash: `0x${string}`,
): Promise<VerifyResult> {
  const tx = await deps.getTransaction(txHash);
  if (!tx) {
    return { accepted: false, reason: 'No such transaction on this chain yet.' };
  }

  if (tx.from.toLowerCase() !== incident.signer.toLowerCase()) {
    return {
      accepted: false,
      reason:
        `That transaction was sent by ${tx.from}, but this incident is about ${incident.signer}. ` +
        'Only a transaction from the incident\'s own signer can resolve it.',
    };
  }

  const wanted = proposal.transaction?.nonce;
  if (wanted !== null && wanted !== undefined && tx.nonce !== wanted) {
    return {
      accepted: false,
      reason:
        `The plan needed nonce ${wanted} and that transaction used nonce ${tx.nonce}. ` +
        'A different nonce does not fill the gap this incident is about.',
    };
  }

  const receipt = await deps.waitForReceipt(txHash);
  const at = deps.now?.() ?? new Date();

  await recordRemediationAttempt(deps.db, {
    id: deps.makeId(),
    incidentId: incident.id,
    playbookId: proposal.playbookId ?? 'unknown',
    signer: incident.signer,
    chainId: incident.chainId,
    attemptedAt: at,
    // The cost, not the gas count. Recording units in a column named for wei
    // is what made the ledger report 21,000 wei for a real transaction.
    ...(receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined
      ? { gasSpentWei: receipt.gasUsed * receipt.effectiveGasPrice }
      : {}),
    status: receipt.included ? 'succeeded' : 'failed',
    txHash,
    executor: 'user-signed',
  });

  const explorerUrl = safeExplorer(incident.chainId, txHash);
  return {
    accepted: true,
    included: receipt.included,
    ...(receipt.gasUsed !== undefined ? { gasUsed: receipt.gasUsed.toString() } : {}),
    ...(explorerUrl ? { explorerUrl } : {}),
  };
}

/** Attach the outcome to the incident, keeping the provenance explicit. */
export async function recordUserRemediation(
  db: Database,
  row: Record<string, unknown>,
  incident: Incident,
  proposal: Proposal,
  txHash: string,
  result: VerifyResult,
  at: Date,
): Promise<void> {
  await saveIncident(db, {
    ...row,
    /**
     * Blackbox planned this and a wallet signed it through Blackbox's own
     * route, so calling it `external` understates what happened — `external`
     * is for a fix that arrived without us. The distinction matters because
     * mean-time-to-remediation counts our work and not the world's.
     */
    ...(result.included
      ? { resolvedAt: at, resolvedBy: 'blackbox-proposed', status: 'resolved' }
      : {}),
    remediation: {
      playbookId: proposal.playbookId ?? 'unknown',
      finalStatus: result.included ? 'succeeded' : 'failed',
      ...(result.included ? { verifiedAt: at } : {}),
      attempts: [
        {
          attemptIndex: 0,
          startedAt: at,
          completedAt: at,
          guardsPassed: proposal.guards.passed,
          guardsFailed: proposal.guards.failed.map((f) => f.guard),
          txHash,
          executor: 'user-signed',
          status: result.included ? 'succeeded' : 'failed',
          ...(result.gasUsed ? { gasUsed: result.gasUsed } : {}),
        },
      ],
    },
  } as never);
}

function safeExplorer(chainId: number, hash: string): string | undefined {
  try {
    return getChain(chainId).explorerTxUrl(hash);
  } catch {
    return undefined;
  }
}
