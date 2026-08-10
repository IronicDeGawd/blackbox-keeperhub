// The full arc on live Sepolia: induce a nonce gap, detect it, let Blackbox
// remediate it with a real transaction, verify inclusion from the chain, and
// watch the incident resolve attributed to Blackbox rather than to luck.
//
// P2 needs a specific nonce on the incident's own signer, which KeeperHub
// cannot do — it submits through a sponsored relayer at the sponsor's nonce.
// So this path signs with a held key. See PRD §6.2.
import {
  Remediator,
  RemediationLoop,
  RoutingExecutor,
  SignerExecutor,
  ReceiptVerifier,
} from '../../remediator/dist/index.js';
import {
  setup,
  pollUntil,
  incidentsFor,
  printIncident,
  printLoopResult,
  printRemediation,
  explorer,
  CHAIN,
} from './harness.mjs';

const { account, db, close, pub, rpcUrl, config, harness, recorder, tracker, makeId } = await setup({
  live: true,
});

const verifier = new ReceiptVerifier({ [CHAIN]: rpcUrl });
const loop = new RemediationLoop({
  db,
  remediator: new Remediator({
    db,
    config,
    executor: new RoutingExecutor({
      signer: new SignerExecutor([account], { [CHAIN]: rpcUrl }, verifier),
    }),
    market: async () => {
      const block = await pub.getBlock({ blockTag: 'latest' });
      return {
        baseFee: block.baseFeePerGas ?? 1_000_000_000n,
        suggestedPriorityFee: 1_000_000_000n,
        signerBalance: await pub.getBalance({ address: account.address }),
      };
    },
    makeId: makeId('rem'),
    logger: { info: () => {}, error: (m, d) => console.log('  [rem err]', m, d?.error?.message ?? '') },
  }),
  // Without this the tracker never learns Blackbox acted, and the gap it filled
  // itself resolves as `external`.
  onRemediated: (id, outcome) => tracker.attachRemediation(id, outcome.record),
  logger: { info: () => {}, error: (m, d) => console.log('  [loop err]', m, String(d?.error ?? '').slice(0, 200)) },
});

// --- induce ----------------------------------------------------------------
const result = await harness.c2NonceGap();
console.log('\nC2 gap submitted at nonce', result.detail.submittedNonce,
  '- leaves', result.detail.missingNonce, 'unfilled');
console.log('  ', explorer(result.txHashes[0]));

// --- detect ----------------------------------------------------------------
console.log('\n-- detection --');
const open = await pollUntil(recorder, db, account, (found) => found.some((i) => i.status === 'open'), {
  attempts: 10,
  intervalMs: 20_000,
  listParams: { status: 'open' },
});
if (open.length === 0) {
  console.log('nothing detected; nothing to remediate');
  await close();
  process.exit(1);
}

// --- remediate -------------------------------------------------------------
console.log('\n-- remediation --');
const tick = await loop.tick();
printLoopResult(tick);
for (const { incidentId, outcome } of tick.outcomes) {
  await printRemediation(pub, incidentId, outcome);
}

// --- confirm the gap actually closed ---------------------------------------
console.log('\n-- aftermath --');
console.log(
  'signer nonce latest',
  await pub.getTransactionCount({ address: account.address, blockTag: 'latest' }),
  'pending',
  await pub.getTransactionCount({ address: account.address, blockTag: 'pending' }),
);

await pollUntil(recorder, db, account, (found) => found.every((i) => i.status !== 'open'), {
  attempts: 6,
  intervalMs: 20_000,
});
for (const incident of await incidentsFor(db, account)) printIncident(incident, '   final: ');

await close();
