// End-to-end on live Sepolia: induce a nonce gap, watch Blackbox detect it,
// heal it, watch Blackbox resolve it. Real transactions, real hashes.
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatEther } from 'viem';
import { blackboxConfigSchema } from '../core/dist/index.js';
import { IncidentTracker } from '../detector/dist/index.js';
import { createDb, listIncidents } from '../store/dist/index.js';
import { Recorder, RpcCorroborator } from '../recorder/dist/index.js';
import { ChaosHarness } from './dist/index.js';

const env = Object.fromEntries(
  readFileSync('/project/blackbox/.env.local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const RPC = env.ALCHEMY_RPC_URL;
const CHAIN = 11155111;
const DB = 'postgres://blackbox:blackbox@localhost:5433/blackbox';

const account = privateKeyToAccount(env.CHAOS_SIGNER_PRIVATE_KEY);
const { db, close } = createDb(DB);
const pub = createPublicClient({ transport: http(RPC) });

const bal = await pub.getBalance({ address: account.address });
console.log('chaos signer', account.address, formatEther(bal), 'ETH');

const harness = new ChaosHarness({ db, account, chainId: CHAIN, rpcUrl: RPC });
console.log('chain:', harness.chainName);

const chain = {
  getTransaction: async ({ hash }) => {
    try { return await pub.getTransaction({ hash }); } catch { return null; }
  },
  getReceipt: async ({ hash }) => {
    try { return await pub.getTransactionReceipt({ hash }); } catch { return null; }
  },
};

let n = 0;
const recorder = new Recorder({
  db,
  keeperHub: { getExecutionStatus: async () => { throw new Error('unused in this run'); } },
  corroboration: new RpcCorroborator({ rpcUrls: { [CHAIN]: RPC } }),
  chain,
  config: blackboxConfigSchema.parse({ keeperHub: { orgKey: env.KEEPERHUB_ORG_KEY }, databaseUrl: DB }),
  tracker: new IncidentTracker({ makeId: () => `inc-${Date.now()}-${n++}` }),
  makeId: () => `evt-${Date.now()}-${n++}`,
  logger: { info: () => {}, error: (m, d) => console.log('  [err]', m, d?.error?.message?.slice(0, 90) ?? '') },
});

const show = async (tag) => {
  const all = await listIncidents(db);
  for (const i of all) {
    console.log(`   ${tag} ${i.class} [${i.severity}] ${i.status} conf=${i.confidence} rule=${i.evidence.ruleId}` +
      (i.resolvedBy ? ` resolvedBy=${i.resolvedBy}` : ''));
  }
  return all;
};

// --- induce ----------------------------------------------------------------
const result = await harness.c2NonceGap();
console.log('\nC2 submitted:', result.txHashes[0]);
console.log('  latest nonce  ', result.detail.latestNonce);
console.log('  submitted at  ', result.detail.submittedNonce, '(leaves', result.detail.missingNonce, 'unfilled)');
console.log('  explorer      ', `https://sepolia.etherscan.io/tx/${result.txHashes[0]}`);

// --- detect ----------------------------------------------------------------
console.log('\n-- detection phase (R1 needs 90s pending; R2 needs 2 gap polls) --');
for (let i = 1; i <= 10; i++) {
  const r = await recorder.tick();
  console.log(`tick ${i}: polled=${r.polled} events=${r.eventsInserted} created=${r.incidentsCreated} errors=${r.errors}`);
  const all = await show('->');
  if (all.some((x) => x.status === 'open')) break;
  await new Promise((res) => setTimeout(res, 25_000));
}

// --- heal ------------------------------------------------------------------
console.log('\n-- healing the gap --');
const healHash = await harness.healNonceGap();
console.log('heal tx:', healHash);
console.log('  explorer', `https://sepolia.etherscan.io/tx/${healHash}`);

// --- resolve ---------------------------------------------------------------
console.log('\n-- resolution phase --');
for (let i = 1; i <= 10; i++) {
  const r = await recorder.tick();
  console.log(`tick ${i}: polled=${r.polled} events=${r.eventsInserted} resolved=${r.incidentsResolved} errors=${r.errors}`);
  const all = await show('->');
  if (all.length && all.every((x) => x.status === 'resolved')) break;
  await new Promise((res) => setTimeout(res, 25_000));
}

const final = await pub.getTransactionCount({ address: account.address, blockTag: 'latest' });
console.log('\nfinal latest nonce', final);
await close();
