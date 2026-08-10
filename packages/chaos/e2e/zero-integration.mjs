// Proves the claim that matters to anyone evaluating this: Blackbox can watch
// an address that has integrated nothing.
//
// It registers an address, then sends a transaction that NOTHING tells Blackbox
// about — no `watchTransaction`, no wrapper, no KeeperHub record — and shows the
// block scanner discovering it, ingesting it, and evaluating rules against it.
//
// Uses the chaos signer only because we need a key to send with. Nothing about
// the discovery path knows or cares whose address it is; `watch-address.mjs`
// does the same for an address we do not control.
import { createWalletClient, http } from 'viem';
import { watchSigner } from '../../store/dist/index.js';
import { BlockScanner } from '../../recorder/dist/index.js';
import { setup, incidentsFor, printIncident, sleep, explorer, CHAIN } from './harness.mjs';

const { db, close, pub, account, recorder, rpcUrl } = await setup();

await watchSigner(db, {
  signer: account.address,
  chainId: CHAIN,
  agentId: 'unintegrated-agent',
  label: 'zero-integration demo',
  at: new Date(),
});
console.log(`\nwatching ${account.address} — registered as an address, not as a transaction`);

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

const first = await scanner.tick();
console.log(`cursor established at block ${first.toBlock}`);

// Sent with a bare wallet client. The chaos harness is deliberately not used
// here, because it registers the hash and that is the thing being proven
// unnecessary.
const block = await pub.getBlock({ blockTag: 'latest' });
const wallet = createWalletClient({ account, transport: http(rpcUrl) });
const hash = await wallet.sendTransaction({
  account,
  chain: null,
  to: account.address,
  value: 0n,
  maxFeePerGas: (block.baseFeePerGas ?? 1_000_000_000n) * 2n,
  maxPriorityFeePerGas: 1_000_000_000n,
});
console.log(`sent, and told Blackbox nothing about it: ${explorer(hash)}\n`);

let discovered = 0;
for (let i = 1; i <= 10; i++) {
  const scan = await scanner.tick();
  discovered += scan.matched;
  const rec = await recorder.tick();
  const incidents = await incidentsFor(db, account);

  console.log(
    `tick ${i}: blocks ${scan.fromBlock ?? '-'}..${scan.toBlock ?? '-'} ` +
      `matched=${scan.matched} events=${rec.eventsInserted} incidents=${incidents.length}`,
  );
  for (const incident of incidents) printIncident(incident);

  if (discovered > 0 && rec.eventsInserted === 0 && i > 2) break;
  await sleep(13_000);
}

console.log(
  discovered > 0
    ? `\nDISCOVERED ${discovered} transaction(s) with zero integration.`
    : '\nnothing discovered — the transaction may not have been mined yet',
);
await close();
