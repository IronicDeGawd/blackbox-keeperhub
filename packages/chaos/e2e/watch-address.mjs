// Watch an arbitrary address with no integration on its side at all.
//
//   node e2e/watch-address.mjs 0xSomeAddress [agentId]
//
// Registers the address, scans blocks for its transactions, ingests whatever it
// finds, and evaluates the rules against it. Nothing is asked of whoever
// controls that address — no SDK, no wrapper, no cooperation.
import { watchSigner } from '../../store/dist/index.js';
import { BlockScanner } from '../../recorder/dist/index.js';
import { setup, incidentsFor, printIncident, sleep, CHAIN } from './harness.mjs';

const target = process.argv[2];
const agentId = process.argv[3] ?? 'external';
if (!target || !/^0x[0-9a-fA-F]{40}$/.test(target)) {
  console.log('usage: node e2e/watch-address.mjs 0xAddress [agentId]');
  process.exit(1);
}

const { db, close, pub, recorder } = await setup();

await watchSigner(db, { signer: target, chainId: CHAIN, agentId, at: new Date() });
console.log(`\nwatching ${target} as agent "${agentId}" — nothing installed on their side`);

const scanner = new BlockScanner({
  db,
  chainId: CHAIN,
  reader: {
    getBlockNumber: async () => pub.getBlockNumber(),
    getBlockWithTransactions: async (_chainId, blockNumber) => {
      const block = await pub.getBlock({ blockNumber, includeTransactions: true });
      return {
        transactions: block.transactions.map((t) => ({ hash: t.hash, from: t.from, to: t.to })),
      };
    },
  },
  logger: { info: () => {}, error: (m, d) => console.log('  [scan]', m, d?.error?.message ?? '') },
});

// The first tick only establishes the cursor at the safe head; discovery starts
// from the moment we were asked to watch, not from genesis.
const first = await scanner.tick();
console.log(`cursor established at block ${first.toBlock}\n`);

let discovered = 0;
for (let i = 1; i <= 12; i++) {
  const scan = await scanner.tick();
  discovered += scan.matched;
  const rec = await recorder.tick();
  const incidents = await incidentsFor(db, { address: target });

  console.log(
    `tick ${i}: blocks ${scan.fromBlock ?? '-'}..${scan.toBlock ?? '-'} ` +
      `matched=${scan.matched} (total ${discovered}) events=${rec.eventsInserted} ` +
      `incidents=${incidents.length}`,
  );
  for (const incident of incidents) printIncident(incident);

  if (discovered > 0 && i >= 4) break;
  await sleep(15_000);
}

console.log(`\ndiscovered ${discovered} transaction(s) belonging to ${target}`);
await close();
