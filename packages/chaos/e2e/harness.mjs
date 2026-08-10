// Shared wiring for the live end-to-end scripts.
//
// Every script below induces a real failure on a real testnet and watches
// Blackbox react, so they all need the same six things: env, a database, a
// chain client, a chaos harness, a recorder, and a way to print incidents.
// Six copies of that meant a fix to one script silently left the others on the
// old behaviour — the `logicalActionId` plumbing had to be added twice for
// exactly that reason.
//
// Deliberately not a test helper: these scripts spend real gas, and each one
// stays a readable top-to-bottom script. This module only removes the wiring
// they have no reason to differ on.
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatEther } from 'viem';
import { blackboxConfigSchema } from '../../core/dist/index.js';
import { IncidentTracker } from '../../detector/dist/index.js';
import { createDb, listIncidents } from '../../store/dist/index.js';
import { Recorder, RpcCorroborator } from '../../recorder/dist/index.js';
import { ChaosHarness } from '../dist/index.js';

const ENV_PATH = '/project/blackbox/.env.local';
export const CHAIN = 11155111;
export const DB_URL = 'postgres://blackbox:blackbox@localhost:5433/blackbox';

export const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

export const explorer = (hash) => `https://sepolia.etherscan.io/tx/${hash}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build everything a live run needs.
 *
 * `remediation` opts the config into acting: without it every playbook is
 * blocked by the dry-run guard, which is the correct default and the wrong
 * thing for a script whose whole purpose is to remediate.
 */
export async function setup(options = {}) {
  const rpcUrl = env.ALCHEMY_RPC_URL;
  const account = privateKeyToAccount(env.CHAOS_SIGNER_PRIVATE_KEY);
  const { db, close } = createDb(DB_URL);
  const pub = createPublicClient({ transport: http(rpcUrl) });

  const config = blackboxConfigSchema.parse({
    keeperHub: { orgKey: env.KEEPERHUB_ORG_KEY },
    databaseUrl: DB_URL,
    ...(options.live
      ? {
          remediation: {
            dryRun: false,
            signerAllowlist: [account.address],
            chainAllowlist: [CHAIN],
          },
        }
      : {}),
  });

  const harness = new ChaosHarness({
    db,
    account,
    chainId: CHAIN,
    rpcUrl,
    ...(env.CHAOS_TARGET_ADDRESS ? { chaosTarget: env.CHAOS_TARGET_ADDRESS } : {}),
  });

  // A transaction that is not yet visible to this node is a normal state, not
  // an error: the recorder polls until it settles.
  const chain = {
    getTransaction: async ({ hash }) => {
      try {
        return await pub.getTransaction({ hash });
      } catch {
        return null;
      }
    },
    getReceipt: async ({ hash }) => {
      try {
        return await pub.getTransactionReceipt({ hash });
      } catch {
        return null;
      }
    },
  };

  let n = 0;
  const makeId = (prefix) => () => `${prefix}-${Date.now()}-${n++}`;
  const tracker = new IncidentTracker({ makeId: makeId('inc') });

  const recorder = new Recorder({
    db,
    // These runs observe raw chain transactions; nothing polls KeeperHub.
    keeperHub: {
      getExecutionStatus: async () => {
        throw new Error('not used in this run');
      },
    },
    corroboration: new RpcCorroborator({ rpcUrls: { [CHAIN]: rpcUrl } }),
    chain,
    config,
    tracker,
    makeId: makeId('evt'),
    logger: {
      info: () => {},
      error: (m, d) => console.log('  [err]', m, d?.error?.message?.slice(0, 120) ?? ''),
    },
  });

  const balance = await pub.getBalance({ address: account.address });
  console.log('chaos signer', account.address, formatEther(balance), 'ETH');
  console.log('chain       ', harness.chainName);
  if (env.CHAOS_TARGET_ADDRESS) console.log('chaos target', env.CHAOS_TARGET_ADDRESS);

  return { account, db, close, pub, rpcUrl, config, harness, recorder, tracker, makeId };
}

/** Incidents for the chaos signer, newest first. */
export async function incidentsFor(db, account, params = {}) {
  const all = await listIncidents(db, params);
  return all.filter((i) => i.signer.toLowerCase() === account.address.toLowerCase());
}

export function printIncident(incident, indent = '   ') {
  console.log(
    `${indent}${incident.class} [${incident.severity}] ${incident.status} ` +
      `conf=${incident.confidence} rule=${incident.evidence.ruleId}` +
      (incident.resolvedBy ? ` resolvedBy=${incident.resolvedBy}` : ''),
  );
}

/**
 * Tick the recorder until `done` is satisfied, or the attempts run out.
 *
 * Detection is not instant by design — R1 waits for a transaction to be
 * genuinely stuck, and R2 wants the gap confirmed across polls — so every
 * script needs this loop and none of them should implement it differently.
 */
export async function pollUntil(recorder, db, account, done, options = {}) {
  const attempts = options.attempts ?? 8;
  const intervalMs = options.intervalMs ?? 15_000;

  for (let i = 1; i <= attempts; i++) {
    const result = await recorder.tick();
    const incidents = await incidentsFor(db, account, options.listParams ?? {});
    console.log(
      `tick ${i}: events=${result.eventsInserted} created=${result.incidentsCreated} ` +
        `errors=${result.errors} incidents=${incidents.length}`,
    );
    for (const incident of incidents) printIncident(incident);
    if (done(incidents)) return incidents;
    if (i < attempts) await sleep(intervalMs);
  }
  return incidentsFor(db, account, options.listParams ?? {});
}

/** Print one remediation outcome, including a refusal and why. */
export async function printRemediation(pub, incidentId, outcome) {
  const attempt = outcome.record.attempts[0];
  console.log(`\nincident ${incidentId} -> ${outcome.record.playbookId} ${outcome.record.finalStatus}`);
  if (attempt?.txHash) console.log('  REMEDIATION TX', explorer(attempt.txHash));
  if (attempt?.keeperHubActionId) console.log('  keeperhub exec', attempt.keeperHubActionId);
  if (attempt?.gasUsed !== undefined) console.log('  gas used      ', attempt.gasUsed.toString());
  if (attempt?.failureReason) console.log('  reason        ', attempt.failureReason);
  if (outcome.guardsFailed.length) {
    console.log(
      '  guards failed ',
      outcome.guardsFailed.map((g) => `${g.guard}: ${g.reason}`).join(' | '),
    );
  }
  if (attempt?.txHash) {
    const tx = await pub.getTransaction({ hash: attempt.txHash });
    console.log('  onchain       from', tx.from, 'nonce', tx.nonce, 'to', tx.to);
  }
}

export function printLoopResult(tick) {
  console.log(
    'loop:',
    JSON.stringify({
      considered: tick.considered,
      attempted: tick.attempted,
      succeeded: tick.succeeded,
      skipped: tick.skipped,
      failed: tick.failed,
      errors: tick.errors,
    }),
  );
}
