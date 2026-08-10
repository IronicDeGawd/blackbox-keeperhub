/**
 * The judge's path, end to end.
 *
 * Stands in for someone visiting the public URL with their own wallet: ask the
 * API to plan a failure for an address it holds no key for, sign the returned
 * transactions locally, and wait for Blackbox to notice on its own. Nothing is
 * reported back to the server — if the incident appears, it appeared from
 * block scanning alone, which is the claim being tested.
 *
 *   node packages/chaos/e2e/self-signed-chaos.mjs [scenario]
 */
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const API = process.env.API_URL ?? 'http://localhost:4000';
const scenario = process.argv[2] ?? 'C2';

const key = process.env.CHAOS_SIGNER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
if (!key) throw new Error('Set CHAOS_SIGNER_PRIVATE_KEY to the wallet standing in for the judge');

const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
const rpc = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });

const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
};

console.log(`Judge wallet: ${account.address}`);
const plan = await post('/api/chaos/plan', { scenario, signer: account.address });
if (plan.declined) throw new Error(`Declined: ${plan.declined}`);
console.log(`Plan: ${plan.induces} in ${plan.steps.length} step(s). Watching: ${plan.watching}`);

const sent = [];
for (const step of plan.steps) {
  const t = step.transaction;
  const hash = await wallet.sendTransaction({
    to: t.to,
    value: BigInt(t.value),
    ...(t.data ? { data: t.data } : {}),
    ...(t.nonce !== null ? { nonce: t.nonce } : {}),
    maxFeePerGas: BigInt(t.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
    ...(t.gas ? { gas: BigInt(t.gas) } : {}),
  });
  sent.push(hash);
  console.log(`  ${step.order}. ${step.label} -> ${hash}`);
  // Some scenarios only work if the previous step is already in a block.
  if (step.waitForInclusion) {
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`     mined`);
  }
}

// What a browser wallet would do: hand back the hashes it produced. Required
// for the queued cases — a transaction above an unused nonce is in no block,
// so there is nothing for block scanning to find.
const seen = await post('/api/chaos/observe', {
  txHashes: sent,
  chainId: plan.chainId,
  runId: `judge-${scenario}-${sent[0].slice(0, 10)}`,
});
console.log(`Reported ${seen.observed.length} tx, ignored ${seen.ignored.length}`);

console.log(`\nWaiting for Blackbox to notice...`);
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const { items } = await (await fetch(`${API}/api/incidents?limit=20`)).json();
  const hit = items.find(
    (i) => i.class === plan.induces && i.signer?.toLowerCase() === account.address.toLowerCase(),
  );
  if (hit) {
    console.log(`\nDetected ${hit.class} (${hit.ruleId}) — ${hit.summary}`);
    console.log(`Incident ${hit.id}, severity ${hit.severity}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 5_000));
}
console.error(`\nNot detected within 180s. Sent: ${sent.join(', ')}`);
process.exit(1);
