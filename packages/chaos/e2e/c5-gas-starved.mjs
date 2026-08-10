// C5 on live Sepolia: starve a signer until it can no longer afford its own
// work, and watch R6 say so.
//
// The original C5 swept the chaos signer itself, which is why it was written
// and never run — it blocks every other scenario until someone refunds it.
// This uses a throwaway wallet instead: funded, made to do a little work so
// there is a real cost history to reason about, then swept down to dust.
//
// R6 needs two things, both of which the normal pipeline already provides: the
// signer's balance from corroboration, and events carrying gasUsed and
// effectiveGasPrice so it can take a median. It fires when the balance falls
// below that median times the configured multiple.
import { createWalletClient, createPublicClient, http, formatEther, parseEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { setup, incidentsFor, printIncident, sleep, explorer, CHAIN } from './harness.mjs';

const API = process.env.BLACKBOX_API_URL ?? 'http://localhost:4000';

const { db, close, pub, account: funder, rpcUrl } = await setup();

// A wallet that exists only for this run, so nothing else depends on its
// balance and the scenario is repeatable.
const victimKey = process.env.C5_KEY ?? generatePrivateKey();
const victim = privateKeyToAccount(victimKey);
const wallet = createWalletClient({ account: victim, transport: http(rpcUrl) });
const funderWallet = createWalletClient({ account: funder, transport: http(rpcUrl) });

console.log(`victim ${victim.address}`);

// Register before funding: discovery starts from the block we are registered
// at, so anything sent earlier is invisible.
const watch = await fetch(`${API}/api/watched`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ signer: victim.address, agentId: 'starved-agent', label: 'C5 victim' }),
});
console.log('watching:', watch.status === 201 ? 'registered' : await watch.text());

const fees = async () => {
  const block = await pub.getBlock({ blockTag: 'latest' });
  const base = block.baseFeePerGas ?? 1_000_000_000n;
  return { maxFeePerGas: base * 2n + 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
};

// --- fund it ---------------------------------------------------------------
const FUNDING = parseEther('0.0004');
const fundHash = await funderWallet.sendTransaction({
  account: funder,
  chain: null,
  to: victim.address,
  value: FUNDING,
  ...(await fees()),
});
await pub.waitForTransactionReceipt({ hash: fundHash });
console.log(`funded ${formatEther(FUNDING)} ETH  ${explorer(fundHash)}`);

// --- give it a cost history ------------------------------------------------
// R6 takes a median of what this signer's work actually costs, so it needs to
// have done some. Three self-sends is enough for a median that means something.
console.log('\nworking (3 self-sends, so there is a median cost to compare against)');
for (let i = 0; i < 3; i++) {
  const hash = await wallet.sendTransaction({
    account: victim,
    chain: null,
    to: victim.address,
    value: 0n,
    ...(await fees()),
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`  tx ${i + 1}: ${receipt.gasUsed} gas @ ${receipt.effectiveGasPrice} wei`);
}

// --- starve it -------------------------------------------------------------
// Sweep almost everything back, leaving less than one action's worth. Not to
// zero: a signer at zero cannot submit the transaction that would prove the
// problem, and R6 is about runway rather than emptiness.
const balance = await pub.getBalance({ address: victim.address });
const f = await fees();
const sweepCost = f.maxFeePerGas * 21_000n;
const keep = sweepCost / 3n;
const value = balance - sweepCost - keep;

if (value > 0n) {
  const hash = await wallet.sendTransaction({
    account: victim,
    chain: null,
    to: funder.address,
    value,
    ...f,
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`\nswept ${formatEther(value)} ETH back  ${explorer(hash)}`);
}

const left = await pub.getBalance({ address: victim.address });
console.log(`victim now holds ${formatEther(left)} ETH`);

// --- detect ----------------------------------------------------------------
console.log('\n-- detection --');
for (let i = 1; i <= 12; i++) {
  const incidents = await incidentsFor(db, victim);
  console.log(`tick ${i}: ${incidents.length} incident(s) for this signer`);
  for (const incident of incidents) {
    printIncident(incident);
    if (incident.evidence.ruleId === 'R6') {
      console.log('   facts', JSON.stringify(incident.evidence.facts));
      console.log('   balance seen:', incident.evidence.corroboration?.signerBalance);
    }
  }
  if (incidents.some((i) => i.class === 'SIGNER_GAS_STARVED')) break;
  await sleep(15_000);
}

console.log(`\nC5_KEY=${victimKey}  (to re-run against the same wallet)`);
await close();
