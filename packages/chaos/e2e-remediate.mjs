// The full arc on live Sepolia: induce a nonce gap, detect it, let Blackbox
// remediate it with a real transaction, verify inclusion from the chain.
// Nothing here is simulated; every hash printed is retrievable on Etherscan.
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatEther } from 'viem';
import { blackboxConfigSchema } from '../core/dist/index.js';
import { IncidentTracker } from '../detector/dist/index.js';
import { createDb, listIncidents } from '../store/dist/index.js';
import { Recorder, RpcCorroborator } from '../recorder/dist/index.js';
import {
  Remediator,
  RemediationLoop,
  RoutingExecutor,
  SignerExecutor,
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
const explorer = (h) => `https://sepolia.etherscan.io/tx/${h}`;

const account = privateKeyToAccount(env.CHAOS_SIGNER_PRIVATE_KEY);
const { db, close } = createDb(DB);
const pub = createPublicClient({ transport: http(RPC) });

console.log('chaos signer', account.address, formatEther(await pub.getBalance({ address: account.address })), 'ETH');

const harness = new ChaosHarness({ db, account, chainId: CHAIN, rpcUrl: RPC });

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
  logger: { info: () => {}, error: (m, d) => console.log('  [err]', m, d?.error?.message?.slice(0, 90) ?? '') },
});

const verifier = new ReceiptVerifier({ [CHAIN]: RPC });
const signerExecutor = new SignerExecutor([account], { [CHAIN]: RPC }, verifier);
const loop = new RemediationLoop({
  db,
  remediator: new Remediator({
    db,
    config,
    executor: new RoutingExecutor({ signer: signerExecutor }),
    market: async () => {
      const block = await pub.getBlock({ blockTag: 'latest' });
      return {
        baseFee: block.baseFeePerGas ?? 1_000_000_000n,
        suggestedPriorityFee: 1_000_000_000n,
        signerBalance: await pub.getBalance({ address: account.address }),
      };
    },
    makeId: () => `rem-${Date.now()}-${n++}`,
    logger: { info: () => {}, error: (m, d) => console.log('  [rem err]', m, d?.error?.message ?? '') },
  }),
  // Without this the tracker never learns Blackbox acted, and the gap it
  // filled itself resolves as `external`.
  onRemediated: (id, outcome) => {
    const attached = tracker.attachRemediation(id, outcome.record);
    console.log('  attribution recorded on tracker:', attached);
  },
  logger: { info: () => {}, error: (m, d) => console.log('  [loop err]', m, String(d?.error ?? '').slice(0, 200)) },
});

// --- induce ----------------------------------------------------------------
const result = await harness.c2NonceGap();
console.log('\nC2 gap submitted at nonce', result.detail.submittedNonce,
  '- leaves', result.detail.missingNonce, 'unfilled');
console.log('  ', explorer(result.txHashes[0]));

// --- detect ----------------------------------------------------------------
console.log('\n-- detection --');
let open = [];
for (let i = 1; i <= 10; i++) {
  const r = await recorder.tick();
  open = (await listIncidents(db, { status: 'open' })).filter((x) => x.signer.toLowerCase() === account.address.toLowerCase());
  console.log(`tick ${i}: events=${r.eventsInserted} created=${r.incidentsCreated} open=${open.length}`);
  for (const i2 of open) console.log(`   ${i2.class} [${i2.severity}] conf=${i2.confidence} rule=${i2.evidence.ruleId} facts=${JSON.stringify(i2.evidence.facts)}`);
  if (open.length) break;
  await new Promise((res) => setTimeout(res, 20_000));
}
if (!open.length) { console.log('no incident detected; nothing to remediate'); await close(); process.exit(1); }

// --- remediate -------------------------------------------------------------
console.log('\n-- remediation --');
const tick = await loop.tick();
console.log('loop:', JSON.stringify({ considered: tick.considered, attempted: tick.attempted, succeeded: tick.succeeded, skipped: tick.skipped, failed: tick.failed, errors: tick.errors }));

for (const { incidentId, outcome } of tick.outcomes) {
  const a = outcome.record.attempts[0];
  console.log(`\nincident ${incidentId} -> ${outcome.record.playbookId} ${outcome.record.finalStatus}`);
  if (a?.txHash) console.log('  REMEDIATION TX', explorer(a.txHash));
  if (a?.gasUsed !== undefined) console.log('  gas used     ', a.gasUsed.toString());
  if (a?.failureReason) console.log('  reason       ', a.failureReason);
  if (outcome.guardsFailed.length) console.log('  guards failed', outcome.guardsFailed.map((g) => `${g.guard}: ${g.reason}`).join(' | '));
  if (a?.txHash) {
    const tx = await pub.getTransaction({ hash: a.txHash });
    console.log('  onchain      ', 'from', tx.from, 'nonce', tx.nonce);
  }
}

// --- confirm the gap actually closed ---------------------------------------
console.log('\n-- aftermath --');
const latest = await pub.getTransactionCount({ address: account.address, blockTag: 'latest' });
const pending = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
console.log('signer nonce latest', latest, 'pending', pending);

for (let i = 1; i <= 6; i++) {
  await recorder.tick();
  const all = await listIncidents(db);
  const mine = all.filter((x) => x.signer.toLowerCase() === account.address.toLowerCase());
  console.log(`tick ${i}:`, mine.map((x) => `${x.class}=${x.status}${x.resolvedBy ? '/' + x.resolvedBy : ''}`).join(' '));
  if (mine.every((x) => x.status !== 'open')) break;
  await new Promise((res) => setTimeout(res, 20_000));
}

await close();
