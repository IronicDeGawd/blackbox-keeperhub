// C2 on live Sepolia: induce a nonce gap, watch R2 detect it, heal it by hand,
// watch the incident resolve. Detection only — nothing remediates here.
import { setup, pollUntil, incidentsFor, explorer, printIncident, sleep } from './harness.mjs';

const { account, db, close, harness, recorder } = await setup();

// --- induce ----------------------------------------------------------------
const result = await harness.c2NonceGap();
console.log('\nC2 gap submitted at nonce', result.detail.submittedNonce,
  '- leaves', result.detail.missingNonce, 'unfilled');
console.log('  ', explorer(result.txHashes[0]));

// --- detect ----------------------------------------------------------------
console.log('\n-- detection (R2 needs the gap confirmed across two polls) --');
const open = await pollUntil(
  recorder,
  db,
  account,
  (incidents) => incidents.some((i) => i.status === 'open'),
  { attempts: 10, intervalMs: 25_000 },
);
if (open.length === 0) {
  console.log('nothing detected');
  await close();
  process.exit(1);
}

// --- heal ------------------------------------------------------------------
console.log('\n-- healing the gap by hand --');
const healHash = await harness.healNonceGap();
console.log('  ', explorer(healHash));
await sleep(15_000);

// --- resolve ---------------------------------------------------------------
console.log('\n-- resolution --');
await pollUntil(recorder, db, account, (incidents) => incidents.every((i) => i.status !== 'open'), {
  attempts: 6,
  intervalMs: 20_000,
});

for (const incident of await incidentsFor(db, account)) printIncident(incident, '   final: ');
await close();
