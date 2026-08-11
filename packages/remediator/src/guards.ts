import type { BlackboxConfig, Incident } from '@blackbox/core';
import {
  attemptsForIncident,
  remediationSpendForAgent,
  remediationSpendSince,
  type Database,
} from '@blackbox/store';

/**
 * Universal guards (PRD §6). All must pass before any playbook runs.
 *
 * A guard failure is a first-class outcome, not an error. Blackbox declining to
 * act with a stated reason is correct behaviour and part of the reliability
 * story, so the failing guard is named and rendered rather than swallowed.
 *
 * Every guard is evaluated independently and all failures are collected. A
 * report saying only "the first thing that stopped me" would send an operator
 * round the loop fixing one blocker at a time.
 */

export type GuardName =
  | 'dry_run'
  | 'min_confidence'
  | 'signer_allowlist'
  | 'chain_allowlist'
  | 'budget'
  | 'agent_daily_budget'
  | 'no_remediation_in_flight'
  | 'max_attempts'
  | 'not_self';

export type GuardResult = {
  passed: GuardName[];
  failed: { guard: GuardName; reason: string }[];
};

export type GuardContext = {
  db: Database;
  config: BlackboxConfig;
  incident: Incident;
  now: Date;
  /** Signers with a remediation currently running (the per-signer mutex). */
  inFlight: ReadonlySet<string>;
};

const BUDGET_WINDOW_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export async function evaluateGuards(ctx: GuardContext): Promise<GuardResult> {
  const { config, incident } = ctx;
  const passed: GuardName[] = [];
  const failed: { guard: GuardName; reason: string }[] = [];
  const check = (guard: GuardName, ok: boolean, reason: string): void => {
    if (ok) passed.push(guard);
    else failed.push({ guard, reason });
  };

  check(
    'dry_run',
    config.remediation.dryRun === false,
    'dry run is enabled; live remediation is an explicit opt-in',
  );

  check(
    'min_confidence',
    incident.confidence >= config.remediation.minConfidence,
    `confidence ${incident.confidence} is below the ${config.remediation.minConfidence} required to spend gas`,
  );

  const allowedSigners = config.remediation.signerAllowlist.map((s) => s.toLowerCase());
  check(
    'signer_allowlist',
    allowedSigners.includes(incident.signer.toLowerCase()),
    `signer ${incident.signer} is not on the operator's allowlist`,
  );

  check(
    'chain_allowlist',
    config.remediation.chainAllowlist.includes(incident.chainId),
    `chain ${incident.chainId} is not on the allowlist`,
  );

  // Blackbox watches itself, and that is deliberate — a failed remediation
  // shows up as an incident on Blackbox's own signer. It must never remediate
  // those, or a bad playbook becomes a loop that spends gas until the budget
  // stops it.
  check(
    'not_self',
    incident.agentId !== 'blackbox',
    'incident belongs to Blackbox itself; self-incidents are diagnosed but never auto-remediated',
  );

  check(
    'no_remediation_in_flight',
    !ctx.inFlight.has(mutexKey(incident.signer, incident.chainId)),
    `a remediation is already running for ${incident.signer}; concurrent attempts would collide on nonce`,
  );

  const attempts = await attemptsForIncident(ctx.db, incident.id);
  check(
    'max_attempts',
    attempts < config.remediation.maxAttempts,
    `incident has already had ${attempts} of ${config.remediation.maxAttempts} permitted attempts`,
  );

  const spend = await remediationSpendSince(ctx.db, {
    signer: incident.signer,
    chainId: incident.chainId,
    since: new Date(ctx.now.getTime() - BUDGET_WINDOW_MS),
  });
  const { maxRemediationsPerHour, maxGasWeiPerHour } = config.remediation.budget;
  const withinCount = spend.count < maxRemediationsPerHour;
  const withinGas = spend.gasWei < maxGasWeiPerHour;
  check(
    'budget',
    withinCount && withinGas,
    !withinCount
      ? `${spend.count} remediations in the last hour reaches the cap of ${maxRemediationsPerHour}`
      : `${spend.gasWei} wei spent in the last hour reaches the cap of ${maxGasWeiPerHour}`,
  );

  /**
   * A second ceiling, per agent per day.
   *
   * The one above is per signer, and every workflow in a KeeperHub
   * organisation executes from the same managed wallet — so on its own it is a
   * single bucket shared by everything the organisation runs, and one workflow
   * failing in a loop can spend the lot. This one is the workflow's own
   * allowance.
   */
  const daily = await remediationSpendForAgent(ctx.db, {
    agentId: incident.agentId,
    since: new Date(ctx.now.getTime() - DAY_MS),
  });
  const { maxRemediationsPerDayPerAgent } = config.remediation.budget;
  check(
    'agent_daily_budget',
    daily.count < maxRemediationsPerDayPerAgent,
    `${incident.agentId} has had ${daily.count} remediations today, which reaches its cap of ${maxRemediationsPerDayPerAgent}`,
  );

  return { passed, failed };
}

/** Per-signer mutex key. Two remediations on one signer collide on nonce. */
export const mutexKey = (signer: string, chainId: number): string =>
  `${signer.toLowerCase()}|${chainId}`;
