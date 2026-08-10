// C3 on live Sepolia: arm a trap, simulate clean, submit, watch it revert one
// block later, and watch R4 classify it as SIM_PASS_EXEC_REVERT.
import { setup, pollUntil, explorer } from './harness.mjs';

const { account, db, close, pub, harness, recorder } = await setup();

// --- induce ----------------------------------------------------------------
console.log('\n-- arming trap, simulating, submitting --');
const result = await harness.c3SimPassExecRevert();
console.log('armed at block   ', result.detail.armedAtBlock);
console.log('simulation passed', result.detail.simulationPassed);
console.log('  arm ', explorer(result.txHashes[0]));
console.log('  work', explorer(result.txHashes[1]));

const receipt = await pub.waitForTransactionReceipt({ hash: result.txHashes[1] });
console.log(
  'work receipt:', receipt.status, 'block', Number(receipt.blockNumber),
  `(drift ${Number(receipt.blockNumber) - result.detail.armedAtBlock} block(s))`,
);

// --- detect ----------------------------------------------------------------
console.log('\n-- detection --');
const incidents = await pollUntil(
  recorder,
  db,
  account,
  (found) => found.some((i) => i.class === 'SIM_PASS_EXEC_REVERT'),
  { attempts: 6 },
);
for (const incident of incidents.filter((i) => i.evidence.ruleId === 'R4')) {
  console.log('   facts', JSON.stringify(incident.evidence.facts));
}

// --- clean up so the target is reusable ------------------------------------
console.log('\n-- disarming --');
const disarmHash = await harness.disarmTrap();
console.log('  ', explorer(disarmHash));
await pub.waitForTransactionReceipt({ hash: disarmHash });

await close();
