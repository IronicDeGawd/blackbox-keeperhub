import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { blackboxConfigSchema, getChain, KeeperHubClient, KeeperHubMcp } from '@blackbox/core';
import { ChaosHarness } from '@blackbox/chaos';
import {
  KeeperHubExecutor,
  ReceiptVerifier,
  RemediationLoop,
  Remediator,
  RoutingExecutor,
  SignerExecutor,
  WorkflowExecutor,
} from '@blackbox/remediator';
import { createDb, getIncident, saveIncident, type Database } from '@blackbox/store';
import { buildApp, type ChaosScenario } from './app.js';
import { EventBus } from './bus.js';
import { planChaos } from './chaos-plans.js';
import {
  buildProposal,
  recordUserRemediation,
  verifyUserSubmission,
  type Proposal,
} from './proposals.js';
import { diagnosticianFromEnv, keeperHubFromEnv, Runtime } from './runtime.js';

/**
 * Composition root.
 *
 * Every capability is conditional on what the environment actually provides, so
 * a process with no key cannot pretend to remediate and the console is told
 * which controls to show. Reads `.env.local` if present so a developer needs no
 * shell setup, and falls back to the process environment for a deployed run.
 */
function loadEnv(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env };
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      if (!line.includes('=') || line.trim().startsWith('#')) continue;
      const i = line.indexOf('=');
      const key = line.slice(0, i).trim();
      if (merged[key] === undefined) merged[key] = line.slice(i + 1).trim();
    }
  } catch {
    // No file is a normal deployment; the environment carries everything.
  }
  // An unset variable and one set to nothing must mean the same thing. Compose
  // and most orchestrators pass an absent value through as an empty string, so
  // without this a blank KEEPERHUB_ORG_KEY defeats its own default and a blank
  // ALCHEMY_RPC_URL wins the fallback against a perfectly good SEPOLIA_RPC_URL.
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined && value.trim() === '') delete merged[key];
  }
  return merged;
}

const env = loadEnv();
const chainId = Number(env['CHAIN_ID'] ?? 11155111);
const rpcUrl = env['ALCHEMY_RPC_URL'] ?? env['SEPOLIA_RPC_URL'];
if (!rpcUrl) throw new Error('No RPC URL: set ALCHEMY_RPC_URL or SEPOLIA_RPC_URL');
// Every endpoint we know of, for finding a transaction a stranger's wallet
// broadcast somewhere else. Queued transactions are not gossiped, so which
// node holds one is a matter of which node their wallet talked to.
const lookupRpcUrls = [env['SEPOLIA_RPC_URL'], env['ALCHEMY_RPC_URL'], env['FALLBACK_RPC_URL']]
  .filter((url): url is string => Boolean(url))
  .filter((url) => url !== rpcUrl);

// The local compose database is a convenience for development and a trap in a
// container: unset in a deployment, the process would boot, look healthy, and
// quietly fail every query against a host that does not exist. Refuse instead,
// unless something is actually listening locally.
const databaseUrl = env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
if (!env['DATABASE_URL'] && env['K_SERVICE']) {
  throw new Error(
    'DATABASE_URL is not set. Refusing to start against the local development database ' +
      'from inside a managed container, where it cannot exist.',
  );
}
const signerAccount = env['CHAOS_SIGNER_PRIVATE_KEY']
  ? privateKeyToAccount(env['CHAOS_SIGNER_PRIVATE_KEY'] as `0x${string}`)
  : undefined;

const config = blackboxConfigSchema.parse({
  keeperHub: { orgKey: env['KEEPERHUB_ORG_KEY'] ?? 'kh_unset' },
  databaseUrl,
  remediation: {
    // Live remediation stays an explicit opt-in, even here.
    dryRun: env['BLACKBOX_DRY_RUN'] !== 'false',
    ...(signerAccount ? { signerAllowlist: [signerAccount.address] } : {}),
    chainAllowlist: [chainId],
  },
});

const { db, close } = createDb(databaseUrl);
const bus = new EventBus();
const logger = {
  info: (m: string, d?: unknown) => console.log('[info]', m, d ?? ''),
  error: (m: string, d?: unknown) => console.error('[error]', m, d ?? ''),
};

const keeperHub = keeperHubFromEnv(env);
const diagnostician = diagnosticianFromEnv(env);

/** Answers already paid for, keyed by chain and hash. */
const diagnosisCache = new Map<string, unknown>();

const runtime = new Runtime({
  db,
  config,
  bus,
  chainId,
  rpcUrl,
  ...(lookupRpcUrls.length > 0 ? { fallbackRpcUrls: lookupRpcUrls } : {}),
  ...(diagnostician ? { diagnostician } : {}),
  ...(keeperHub ? { keeperHub } : {}),
  ...(env['BLACKBOX_TICK_MS'] ? { intervalMs: Number(env['BLACKBOX_TICK_MS']) } : {}),
  logger,
});

// --- remediation ------------------------------------------------------------
// KeeperHub first, because a remediation that goes through it lands in the
// customer's own audit trail and under its spend controls. A held key is the
// fallback, and only it can serve a plan that names a nonce.
const verifier = new ReceiptVerifier({ [chainId]: rpcUrl });
const breakers = env['CIRCUIT_BREAKER_ADDRESS']
  ? { chaos: env['CIRCUIT_BREAKER_ADDRESS'] as `0x${string}` }
  : undefined;

const keeperHubExecutor = keeperHub
  ? new KeeperHubExecutor(
      {
        transfer: async (params) => {
          const execution = await keeperHub.transfer(params);
          return {
            executionId: execution.executionId,
            ...(execution.transactionHash ? { transactionHash: execution.transactionHash } : {}),
          };
        },
        writeContract: async (params) => {
          const execution = await keeperHub.writeContract(params);
          return {
            executionId: execution.executionId,
            ...(execution.transactionHash ? { transactionHash: execution.transactionHash } : {}),
          };
        },
        // Pre-flight with the same body that will be sent, per their
        // documented sequence: it catches a bad address, a wrong ABI or an
        // insufficient balance before any gas is spent.
        simulate: (path, params) => keeperHub.simulate(path, params),
        // A contract-call submission answers without a hash even once mined, so
        // the hash is read from the status record — preferring a verified
        // receipt, which is re-fetched from the chain, over the self-reported
        // field on the write path.
        getExecutionStatus: async (id) => {
          const execution = await keeperHub.getExecutionStatus(id);
          return { transactionHash: KeeperHubClient.verifiedHash(execution) };
        },
      },
      verifier,
    )
  : undefined;

// Workflows are the preferred path: the remediation becomes a run in the
// operator's own KeeperHub dashboard rather than a call only Blackbox can see.
// KeeperHub's own MCP server checks the workflow first — advisory only, since
// its validator currently rejects templated `network` fields that execute fine.
const orgKey = env['KEEPERHUB_ORG_KEY'];
const validator = orgKey?.startsWith('kh_') ? new KeeperHubMcp({ orgKey }) : undefined;
const workflowExecutor = keeperHub
  ? new WorkflowExecutor(keeperHub, verifier, {
      ...(validator ? { validator } : {}),
      logger,
    })
  : undefined;

const signerExecutor = signerAccount
  ? new SignerExecutor([signerAccount], { [chainId]: rpcUrl }, verifier)
  : undefined;

const canRemediate = Boolean(workflowExecutor ?? keeperHubExecutor ?? signerExecutor);
const remediator = canRemediate
  ? new Remediator({
      db,
      config,
      executor: new RoutingExecutor({
        ...(workflowExecutor ? { workflow: workflowExecutor } : {}),
        ...(keeperHubExecutor ? { keeperHub: keeperHubExecutor } : {}),
        ...(signerExecutor ? { signer: signerExecutor } : {}),
      }),
      market: async () => runtime.market(),
      ...(breakers ? { breakers } : {}),
      makeId: () => runtime.nextId('rem'),
      logger,
    })
  : undefined;

const loop = remediator
  ? new RemediationLoop({
      db,
      remediator,
      onRemediated: (id, outcome) =>
        bus.publish({
          type: outcome.record.finalStatus === 'succeeded'
            ? 'remediation.succeeded'
            : 'remediation.failed',
          data: { incidentId: id, ...outcome.record },
        }),
      logger,
    })
  : undefined;

// --- chaos ------------------------------------------------------------------
// Only when a signer key exists and the chain is a permitted chaos target; the
// harness refuses anything else at construction, which is the real guard.
const harness =
  signerAccount && env['CHAOS_TARGET_ADDRESS']
    ? new ChaosHarness({
        db,
        account: signerAccount,
        chainId,
        rpcUrl,
        chaosTarget: env['CHAOS_TARGET_ADDRESS'] as `0x${string}`,
      })
    : undefined;

const SCENARIOS: ChaosScenario[] = [
  { id: 'C1', name: 'Underpriced submission', induces: ['GAS_UNDERPRICED', 'STUCK_TRANSACTION'], enabled: true, deterministic: false, note: 'Bids at the base fee with no tip; inclusion depends on network conditions.' },
  { id: 'C2', name: 'Nonce gap', induces: ['NONCE_GAP'], enabled: true, deterministic: true, note: 'The reliable one. Detected within two polls.' },
  { id: 'C3', name: 'Simulation passes, execution reverts', induces: ['SIM_PASS_EXEC_REVERT'], enabled: true, deterministic: true, note: 'Arms a trap that springs one block later.' },
  { id: 'C4', name: 'Retry storm', induces: ['RETRY_STORM'], enabled: true, deterministic: true, note: 'Four attempts at a call that always reverts.' },
  { id: 'C5', name: 'Signer gas starvation', induces: ['SIGNER_GAS_STARVED'], enabled: true, deterministic: true, note: 'Funds a wallet made for the run, works it, then sweeps it to dust. No shared signer is drained.' },
  { id: 'C6', name: 'Adverse inclusion', induces: ['ADVERSE_INCLUSION'], enabled: false, deterministic: false, note: 'Needs controllable block ordering; local fork only.' },
];

async function runScenario(id: string): Promise<{ runId: string; txHashes: string[] }> {
  if (!harness) throw new Error('chaos is not configured in this process');
  const runId = runtime.nextId('run');
  switch (id) {
    case 'C1':
      return { runId, txHashes: (await harness.c1UnderpricedStuck()).txHashes };
    case 'C2':
      return { runId, txHashes: (await harness.c2NonceGap()).txHashes };
    case 'C3':
      return { runId, txHashes: (await harness.c3SimPassExecRevert()).txHashes };
    case 'C4':
      return { runId, txHashes: (await harness.c4RetryStorm(4)).txHashes };
    case 'C5':
      return { runId, txHashes: (await harness.c5GasStarve()).txHashes };
    default:
      throw new Error(`scenario ${id} cannot be run from here`);
  }
}

// --- proposals --------------------------------------------------------------
const proposalDeps = {
  db,
  config,
  market: async () => runtime.market(),
  ...(breakers ? { breakers } : {}),
};

async function loadIncident(id: string): Promise<{ row: Record<string, unknown>; incident: import('@blackbox/core').Incident } | null> {
  const row = await getIncident(db as Database, id);
  if (!row) return null;
  return {
    row: row as unknown as Record<string, unknown>,
    incident: {
      id: row.id,
      class: row.class,
      severity: row.severity,
      status: row.status,
      agentId: row.agentId,
      signer: row.signer,
      chainId: row.chainId,
      detectedAt: row.detectedAt,
      firstEventAt: row.firstEventAt,
      ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
      confidence: row.confidence,
      evidence: row.evidence,
    } as import('@blackbox/core').Incident,
  };
}

const app = await buildApp({
  db,
  config,
  bus,
  // Diagnosis spends a model call, and the route is open to anyone. The
  // background loop already refuses to explain the same incident twice for
  // this reason; the on-demand path needs the same memory, or the same hash
  // asked for repeatedly bills us repeatedly for one answer.
  diagnose: async (params) => {
    const key = `${params.chainId}:${params.txHash.toLowerCase()}`;
    const remembered = diagnosisCache.get(key);
    if (remembered) return remembered;
    const answer = await runtime.diagnoseTransaction(params);
    // Bounded, oldest out first: a cache nobody can flush is another way to be
    // filled up by strangers.
    if (diagnosisCache.size >= 500) {
      const oldest = diagnosisCache.keys().next().value;
      if (oldest) diagnosisCache.delete(oldest);
    }
    diagnosisCache.set(key, answer);
    return answer;
  },
  signerHealth: (params) => runtime.signerHealth(params),
  ...(loop
    ? {
        remediate: async (incidentId: string) => {
          const loaded = await loadIncident(incidentId);
          if (!loaded) return { accepted: false, finalStatus: 'not_found' };
          const outcome = await remediator!.remediate(loaded.incident);

          // Persist it. The background loop writes the outcome onto the
          // incident, and this path did not, so an operator who pressed
          // Remediate saw the incident unchanged and no remediation panel —
          // the work happened and left no trace anyone could see.
          await saveIncident(db, {
            ...(loaded.row as Record<string, unknown>),
            remediation: outcome.record,
          } as never);
          runtime.attachRemediation(incidentId, outcome.record);
          bus.publish({
            type: outcome.record.finalStatus === 'succeeded'
              ? 'remediation.succeeded'
              : 'remediation.failed',
            data: { incidentId, ...outcome.record },
          });

          const attempt = outcome.record.attempts[0];
          return {
            accepted: outcome.record.finalStatus === 'succeeded',
            playbookId: outcome.record.playbookId,
            finalStatus: outcome.record.finalStatus,
            guardsFailed: outcome.guardsFailed,
            ...(attempt?.txHash ? { txHash: attempt.txHash } : {}),
            ...(attempt?.failureReason ? { reason: attempt.failureReason } : {}),
          };
        },
      }
    : {}),
  ...(harness
    ? {
        chaos: {
          scenarios: () => SCENARIOS,
          context: async () => {
            const chain = getChain(chainId);
            return {
              chainId,
              chainName: chain.name,
              isTestnet: chain.isTestnet,
              signer: signerAccount!.address,
              signerBalanceWei: (await runtime.signerHealth({ signer: signerAccount!.address, chainId })).balanceWei,
              targets: {
                chaosTarget: env['CHAOS_TARGET_ADDRESS'] ?? null,
                circuitBreaker: env['CIRCUIT_BREAKER_ADDRESS'] ?? null,
              },
            };
          },
          run: runScenario,
        },
      }
    : {}),
  // Unconditional, unlike `chaos` above: planning needs no key and no funds,
  // only the ability to read the chain. This is what a public deployment
  // offers a visitor who wants to see the loop run on their own wallet.
  chaosPlan: {
    plan: async ({ scenario, signer, chainId: requested }) => {
      const state = await runtime.chaosChainState(signer);
      return planChaos(scenario, {
        chainId: requested,
        signer,
        state,
        tickSeconds: Math.round(Number(env['BLACKBOX_TICK_MS'] ?? 15_000) / 1000),
        ...(env['CHAOS_TARGET_ADDRESS'] ? { chaosTarget: env['CHAOS_TARGET_ADDRESS'] } : {}),
      });
    },
    observe: (params) => runtime.observeSubmissions(params),
  },
  proposals: {
    plan: async (incidentId: string) => {
      const loaded = await loadIncident(incidentId);
      if (!loaded) return { error: 'not_found' };
      return buildProposal(proposalDeps, loaded.incident);
    },
    accept: async (incidentId: string, txHash: string) => {
      const loaded = await loadIncident(incidentId);
      if (!loaded) return { accepted: false, reason: 'incident not found' };

      const proposal: Proposal = await buildProposal(proposalDeps, loaded.incident);
      const result = await verifyUserSubmission(
        {
          db,
          getTransaction: (hash) => runtime.getSubmittedTransaction(hash),
          waitForReceipt: (hash) => runtime.waitForReceipt(hash),
          makeId: () => runtime.nextId('rem'),
        },
        loaded.incident,
        proposal,
        txHash as `0x${string}`,
      );

      if (result.accepted) {
        await recordUserRemediation(
          db,
          loaded.row,
          loaded.incident,
          proposal,
          txHash,
          result,
          new Date(),
        );
      }
      return result as { accepted: boolean; reason?: string } & Record<string, unknown>;
    },
  },
  logger: false,
});

const port = Number(env['PORT'] ?? 4000);
await app.listen({ port, host: '0.0.0.0' });
runtime.start();

console.log(`blackbox api on http://localhost:${port}`);
console.log(
  `  chain ${chainId} · keeperhub ${keeperHub ? 'on' : 'off'} · ` +
    `diagnostician ${diagnostician ? 'on' : 'off'} · remediate ${canRemediate ? 'on' : 'off'} · ` +
    `chaos ${harness ? 'on' : 'off'} · dryRun ${config.remediation.dryRun}`,
);
console.log('  POST /api/watched                          watch any address');
console.log('  POST /api/diagnose                         explain any transaction');
console.log('  GET  /api/incidents/:id/remediation-plan   what to sign');
console.log('  POST /api/incidents/:id/remediation-tx     what you signed');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      runtime.stop();
      loop?.tick;
      await app.close();
      await close();
      process.exit(0);
    })();
  });
}
