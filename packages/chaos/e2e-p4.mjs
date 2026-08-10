// The KeeperHub remediation path, end to end on live Sepolia:
// C4 burns gas in a retry storm, R5 detects it, and P4 pauses the agent's
// circuit breaker — submitted through KeeperHub Direct Execution, not from a
// key Blackbox holds. Verified by reading isPaused() back off the chain.
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatEther, encodeFunctionData } from 'viem';
import { blackboxConfigSchema, KeeperHubClient } from '../core/dist/index.js';
import { IncidentTracker } from '../detector/dist/index.js';
import { createDb, listIncidents } from '../store/dist/index.js';
import { Recorder, RpcCorroborator } from '../recorder/dist/index.js';
import {
  Remediator,
  RemediationLoop,
  RoutingExecutor,
  KeeperHubExecutor,
  ReceiptVerifier,
} from '../remediator/dist/index.js';
import { ChaosHarness } from './dist/index.js';

const env = Object.fromEntries(
  readFileSync('/project/blackbox/.env.local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const RPC = env.ALCHEMY_RPC_URL;
const CHAIN = 11155111;
const DB = 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const BREAKER = env.CIRCUIT_BREAKER_ADDRESS;
const explorer = (h) => `https://sepolia.etherscan.io/tx/${h}`;

const account = privateKeyToAccount(env.CHAOS_SIGNER_PRIVATE_KEY);
const { db, close } = createDb(DB);
const pub = createPublicClient({ transport: http(RPC) });

const IS_PAUSED = [{ name: 'isPaused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }];
const readPaused = () => pub.readContract({ address: BREAKER, abi: IS_PAUSED, functionName: 'isPaused' });

console.log('chaos signer ', account.address, formatEther(await pub.getBalance({ address: account.address })), 'ETH');
console.log('breaker      ', BREAKER);
console.log('paused now   ', await readPaused());

const harness = new ChaosHarness({
  db, account, chainId: CHAIN, rpcUrl: RPC, chaosTarget: env.CHAOS_TARGET_ADDRESS,
});

const chain = {
  getTransaction: async ({ hash }) => { try { return await pub.getTransaction({ hash }); } catch { return null; } },
  getReceipt: async ({ hash }) => { try { return await pub.getTransactionReceipt({ hash }); } catch { return null; } },
};

let n = 0;
const config = blackboxConfigSchema.parse({
  keeperHub: { orgKey: env.KEEPERHUB_ORG_KEY },
  databaseUrl: DB,
  remediation: {
    dryRun: false,
    signerAllowlist: [account.address],
    chainAllowlist: [CHAIN],
  },
});

const tracker = new IncidentTracker({ makeId: () => `inc-${Date.now()}-${n++}` });
const recorder = new Recorder({
  db,
  keeperHub: { getExecutionStatus: async () => { throw new Error('unused in this run'); } },
  corroboration: new RpcCorroborator({ rpcUrls: { [CHAIN]: RPC } }),
  chain,
  config,
  tracker,
  makeId: () => `evt-${Date.now()}-${n++}`,
  logger: { info: () => {}, error: (m, d) => console.log('  [err]', m, d?.error?.message?.slice(0, 120) ?? '') },
});

// KeeperHub as the submission path. Note what is NOT here: no private key for
// the breaker's pauser. The managed wallet is the pauser, and KeeperHub drives it.
const kh = new KeeperHubClient({ orgKey: env.KEEPERHUB_ORG_KEY });
const PAUSE_ABI = JSON.stringify([
  { name: 'pause', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
]);

const submitter = {
  transfer: async (p) => {
    const x = await kh.transfer(p);
    return { executionId: x.executionId, transactionHash: x.transactionHash ?? undefined };
  },
  getExecutionStatus: async (id) => {
    const x = await kh.getExecutionStatus(id);
    return { transactionHash: x.transactionHash ?? null };
  },
  writeContract: async (p) => {
    console.log('  -> KeeperHub contract-call', JSON.stringify(p));
    const x = await kh.writeContract({ ...p, abi: p.abi ?? PAUSE_ABI });
    console.log('  <- execution', x.executionId, x.status, x.transactionHash ?? '(no hash)');
    return { executionId: x.executionId, transactionHash: x.transactionHash ?? undefined };
  },
};

const loop = new RemediationLoop({
  db,
  remediator: new Remediator({
    db,
    config,
    executor: new RoutingExecutor({
      keeperHub: new KeeperHubExecutor(submitter, new ReceiptVerifier({ [CHAIN]: RPC })),
    }),
    market: async () => {
      const block = await pub.getBlock({ blockTag: 'latest' });
      return { baseFee: block.baseFeePerGas ?? 1_000_000_000n, suggestedPriorityFee: 1_000_000_000n };
    },
    // The breaker this agent registered. P4 declines without one.
    breakers: { chaos: BREAKER },
    makeId: () => `rem-${Date.now()}-${n++}`,
    logger: { info: () => {}, error: (m, d) => console.log('  [rem err]', m, d?.error?.message ?? '') },
  }),
  onRemediated: (id, outcome) => tracker.attachRemediation(id, outcome.record),
  logger: { info: () => {}, error: (m, d) => console.log('  [loop err]', m, String(d?.error ?? '').slice(0, 300)) },
});

// --- induce ----------------------------------------------------------------
console.log('\n-- retry storm --');
const result = await harness.c4RetryStorm(4);
console.log('  attempts:', result.txHashes.length, 'action', result.detail.logicalActionId);

// --- detect ----------------------------------------------------------------
console.log('\n-- detection --');
let open = [];
for (let i = 1; i <= 6; i++) {
  const r = await recorder.tick();
  open = (await listIncidents(db, { status: 'open' }));
  console.log(`tick ${i}: events=${r.eventsInserted} created=${r.incidentsCreated} open=${open.length}`);
  for (const x of open) console.log(`   ${x.class} [${x.severity}] conf=${x.confidence} rule=${x.evidence.ruleId}`);
  if (open.some((x) => x.class === 'RETRY_STORM')) break;
  await new Promise((res) => setTimeout(res, 15_000));
}
if (!open.length) { console.log('nothing detected'); await close(); process.exit(1); }

// --- remediate through KeeperHub -------------------------------------------
console.log('\n-- remediation via KeeperHub --');
const tick = await loop.tick();
console.log('loop:', JSON.stringify({ considered: tick.considered, attempted: tick.attempted, succeeded: tick.succeeded, skipped: tick.skipped, failed: tick.failed, errors: tick.errors }));

for (const { incidentId, outcome } of tick.outcomes) {
  const a = outcome.record.attempts[0];
  console.log(`\nincident ${incidentId} -> ${outcome.record.playbookId} ${outcome.record.finalStatus}`);
  if (a?.txHash) console.log('  REMEDIATION TX', explorer(a.txHash));
  if (a?.keeperHubActionId) console.log('  keeperhub exec', a.keeperHubActionId);
  if (a?.gasUsed !== undefined) console.log('  gas used      ', a.gasUsed.toString());
  if (a?.failureReason) console.log('  reason        ', a.failureReason);
  if (outcome.guardsFailed.length) console.log('  guards failed ', outcome.guardsFailed.map((g) => `${g.guard}: ${g.reason}`).join(' | '));
  if (a?.txHash) {
    const tx = await pub.getTransaction({ hash: a.txHash });
    console.log('  onchain from  ', tx.from, 'to', tx.to);
  }
}

// --- verify the agent is actually halted -----------------------------------
console.log('\n-- aftermath --');
console.log('breaker isPaused:', await readPaused());
const workData = encodeFunctionData({
  abi: [{ name: 'work', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] }],
  functionName: 'work',
});
try {
  await pub.call({ account: account.address, to: env.CHAOS_TARGET_ADDRESS, data: workData });
  console.log('work() still simulates clean — the agent is NOT halted');
} catch (error) {
  console.log('work() now reverts:', String(error.message).split('\n')[0].slice(0, 120));
}

await close();
