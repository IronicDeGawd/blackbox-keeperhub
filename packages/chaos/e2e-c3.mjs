// C3 on live Sepolia: arm a trap, simulate clean, submit, watch it revert, and
// watch R4 classify it as SIM_PASS_EXEC_REVERT. Real transactions throughout.
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
const explorer = (h) => `https://sepolia.etherscan.io/tx/${h}`;

const account = privateKeyToAccount(env.CHAOS_SIGNER_PRIVATE_KEY);
const { db, close } = createDb(DB);
const pub = createPublicClient({ transport: http(RPC) });

console.log('chaos signer', account.address, formatEther(await pub.getBalance({ address: account.address })), 'ETH');
console.log('chaos target', env.CHAOS_TARGET_ADDRESS);

const harness = new ChaosHarness({
  db,
  account,
  chainId: CHAIN,
  rpcUrl: RPC,
  chaosTarget: env.CHAOS_TARGET_ADDRESS,
});

const chain = {
  getTransaction: async ({ hash }) => { try { return await pub.getTransaction({ hash }); } catch { return null; } },
  getReceipt: async ({ hash }) => { try { return await pub.getTransactionReceipt({ hash }); } catch { return null; } },
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
  logger: { info: () => {}, error: (m, d) => console.log('  [err]', m, d?.error?.message?.slice(0, 120) ?? '') },
});

// --- induce ----------------------------------------------------------------
console.log('\n-- arming trap, simulating, submitting --');
const result = await harness.c3SimPassExecRevert();
console.log('armed at block', result.detail.armedAtBlock);
console.log('simulation passed:', result.detail.simulationPassed);
console.log('  arm ', explorer(result.txHashes[0]));
console.log('  work', explorer(result.txHashes[1]));

const receipt = await pub.waitForTransactionReceipt({ hash: result.txHashes[1] });
console.log('work receipt:', receipt.status, 'block', Number(receipt.blockNumber),
  '(drift', Number(receipt.blockNumber) - result.detail.armedAtBlock, 'blocks)');

// --- detect ----------------------------------------------------------------
console.log('\n-- detection --');
for (let i = 1; i <= 6; i++) {
  const r = await recorder.tick();
  const all = await listIncidents(db);
  const mine = all.filter((x) => x.signer.toLowerCase() === account.address.toLowerCase());
  console.log(`tick ${i}: events=${r.eventsInserted} created=${r.incidentsCreated} errors=${r.errors}`);
  for (const x of mine) {
    console.log(`   ${x.class} [${x.severity}] ${x.status} conf=${x.confidence} rule=${x.evidence.ruleId}`);
    if (x.evidence.ruleId === 'R4') console.log('     facts', JSON.stringify(x.evidence.facts));
  }
  if (mine.some((x) => x.class === 'SIM_PASS_EXEC_REVERT')) break;
  await new Promise((res) => setTimeout(res, 15_000));
}

// --- clean up so the target is reusable ------------------------------------
console.log('\n-- disarming --');
const disarmHash = await harness.disarmTrap();
console.log('  ', explorer(disarmHash));
await pub.waitForTransactionReceipt({ hash: disarmHash });

await close();
