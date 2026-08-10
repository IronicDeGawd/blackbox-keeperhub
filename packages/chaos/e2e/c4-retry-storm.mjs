// C4 on live Sepolia: four attempts at a call that always reverts, sharing one
// logical action id, until R5 sees them as one storm rather than four failures.
import { setup, pollUntil, explorer } from './harness.mjs';

const { account, db, close, harness, recorder } = await setup();

// --- induce ----------------------------------------------------------------
console.log('\n-- retry storm: 4 attempts at alwaysRevert() --');
const result = await harness.c4RetryStorm(4);
console.log('  action', result.detail.logicalActionId);
for (const [i, hash] of result.txHashes.entries()) console.log(`  attempt ${i}`, explorer(hash));

// --- detect ----------------------------------------------------------------
console.log('\n-- detection --');
const incidents = await pollUntil(
  recorder,
  db,
  account,
  (found) => found.some((i) => i.class === 'RETRY_STORM'),
  { attempts: 8 },
);
for (const incident of incidents.filter((i) => i.evidence.ruleId === 'R5')) {
  console.log('   facts', JSON.stringify(incident.evidence.facts));
}

await close();
