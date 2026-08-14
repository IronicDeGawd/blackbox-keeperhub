// P4 on Base mainnet, executed through KeeperHub with sponsored gas.
//
// Everything here is real: three genuine failed runs of a KeeperHub workflow
// on Base, the same detector that watches a customer's agent, and a pause
// transaction submitted by KeeperHub from a wallet holding no ETH — the gas is
// sponsored, which is the claim this script exists to evidence.
//
// One wrinkle worth knowing. KeeperHub's /analytics/runs reports `network:
// null` and `networks: []` for a run that fails after the chain was resolved,
// even when the error names that chain ("Insufficient BASE balance"). So the
// chain cannot be read from the run, and is taken from the workflow's own
// definition instead — which is where the author declared it.
import { KeeperHubClient, normaliseRun } from '../../core/dist/index.js';
import { KeeperHubSource } from '../../recorder/dist/index.js';
import { evaluateRules } from '../../detector/dist/index.js';
import {
  Remediator,
  RoutingExecutor,
  KeeperHubExecutor,
  ReceiptVerifier,
} from '../../remediator/dist/index.js';
import { createDb, insertEvents, saveIncident, getIncident } from '../../store/dist/index.js';
import { IncidentTracker } from '../../detector/dist/index.js';
import { blackboxConfigSchema, detectionFor } from '../../core/dist/index.js';
import { createPublicClient, http } from 'viem';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('/project/blackbox/.env.local', 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const BASE = 8453;
const BREAKER = '0x8ecbE030145794596A98167Fc4b56817CeA1E36c';
const WORKFLOW = 'mc7qiql67a5gy8k2zt3qd';
const MANAGED = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5';
const AGENT = `kh:${WORKFLOW}`;

const kh = new KeeperHubClient({ orgKey: env.KEEPERHUB_ORG_KEY });
const pub = createPublicClient({ transport: http('https://mainnet.base.org') });
const { db, close } = createDb('postgres://blackbox:blackbox@localhost:5433/blackbox');

const PAUSED = [{ name: 'isPaused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }];
const readPaused = () => pub.readContract({ address: BREAKER, abi: PAUSED, functionName: 'isPaused' });

console.log('breaker      ', BREAKER, 'on Base mainnet');
console.log('paused before', await readPaused());
console.log('pauser       ', MANAGED, '(KeeperHub managed wallet)');

// The chain comes from the workflow's own definition, since the run record
// does not carry it. Declared here as the constant it is.
console.log('workflow     ', WORKFLOW, '| declared network 8453');

// --- ingest the real failed runs -------------------------------------------
const source = new KeeperHubSource({
  db,
  client: kh,
  orgId: 'base-demo',
  cursorKey: `base-demo:${Date.now()}`,
  agentId: AGENT,
  signer: MANAGED,
  fallbackChainId: BASE,
  watches: (run) => run.workflowId === WORKFLOW,
  makeId: (() => { let n = 0; return () => `evt-base-${Date.now()}-${n++}`; })(),
  range: '1h',
});
const swept = await source.ingest();
console.log('\n-- ingest --');
console.log('  runs seen', swept.runsSeen, '| kept', swept.runsIngested, '| events', swept.eventsInserted);

// --- detect ----------------------------------------------------------------
const config = blackboxConfigSchema.parse({
  keeperHub: { orgKey: env.KEEPERHUB_ORG_KEY },
  databaseUrl: 'postgres://blackbox:blackbox@localhost:5433/blackbox',
  remediation: { dryRun: false, signerAllowlist: [MANAGED], chainAllowlist: [BASE] },
});
const { loadSignerWindow } = await import('../../store/dist/index.js');
const window = await loadSignerWindow(db, {
  signer: MANAGED, chainId: BASE, since: new Date(Date.now() - 3600_000),
});
console.log('\n-- detection --');
console.log('  events in window', window.length);

const tracker = new IncidentTracker({ makeId: (() => { let n = 0; return () => `inc-base-${Date.now()}-${n++}`; })() });
const ctx = {
  now: new Date(),
  detection: detectionFor(config, BASE),
  agentId: AGENT,
  signer: MANAGED,
  chainId: BASE,
  agentKind: 'keeperhub',
};
const drafts = evaluateRules(window, ctx);
const { created } = tracker.ingest(drafts, window, ctx);
for (const i of created) {
  await saveIncident(db, {
    id: i.id, key: i.key, class: i.class, severity: i.severity, status: i.status,
    agentId: i.agentId, signer: i.signer, chainId: i.chainId,
    detectedAt: i.detectedAt, firstEventAt: i.firstEventAt, lastSeenAt: i.lastSeenAt,
    resolvedAt: null, resolvedBy: null, ruleId: i.evidence.ruleId, confidence: i.confidence,
    evidence: i.evidence, rca: null, remediation: null,
  });
  console.log('  detected', i.class, i.id, '| rule', i.evidence.ruleId, '| chain', i.chainId, '| confidence', i.confidence);
}
if (created.length === 0) { console.log('  nothing detected'); await close(); process.exit(1); }

// --- remediate through KeeperHub -------------------------------------------
const PAUSE_ABI = JSON.stringify([{ name: 'pause', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] }]);
const submitter = {
  transfer: async (p) => { const e = await kh.transfer(p); return { executionId: e.executionId, transactionHash: e.transactionHash ?? undefined }; },
  getExecutionStatus: async (id) => { const e = await kh.getExecutionStatus(id); return { transactionHash: e.transactionHash ?? null }; },
  writeContract: async (p) => {
    console.log('  -> KeeperHub contract-call', JSON.stringify({ ...p, abi: undefined }));
    const e = await kh.writeContract({ ...p, abi: p.abi ?? PAUSE_ABI });
    console.log('  <- execution', e.executionId, e.status, e.transactionHash ?? '(hash follows)');
    return { executionId: e.executionId, transactionHash: e.transactionHash ?? undefined };
  },
};

const remediator = new Remediator({
  db,
  config,
  executor: new RoutingExecutor({
    keeperHub: new KeeperHubExecutor(submitter, new ReceiptVerifier({ [BASE]: 'https://mainnet.base.org' })),
  }),
  market: async () => {
    const b = await pub.getBlock({ blockTag: 'latest' });
    return { baseFee: b.baseFeePerGas ?? 1_000_000n, suggestedPriorityFee: 1_000_000n };
  },
  breakerFor: async (agentId) => (agentId === AGENT ? BREAKER : null),
  makeId: (() => { let n = 0; return () => `rem-base-${Date.now()}-${n++}`; })(),
  logger: { info: () => {}, error: (m, d) => console.log('  [rem err]', m, d?.error?.message ?? d ?? '') },
});

console.log('\n-- remediation via KeeperHub, gas sponsored --');
const target = await getIncident(db, created[0].id);
const outcome = await remediator.remediate(target);
console.log('  final', outcome.record.finalStatus);
for (const a of outcome.record.attempts) {
  console.log('  attempt', a.status, '| executor', a.executor ?? '-', '| tx', a.txHash ?? '-');
  if (a.failureReason) console.log('    reason:', a.failureReason);
  if (a.validation) console.log('    keeperhub validate_workflow:', JSON.stringify(a.validation));
  if (a.txHash) console.log('    https://basescan.org/tx/' + a.txHash);
}

console.log('\npaused after ', await readPaused());
await close();
