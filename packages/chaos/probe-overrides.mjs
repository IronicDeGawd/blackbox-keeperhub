// Does KeeperHub's Direct Execution API honour caller-supplied nonce and fee
// fields? P1 and P2 are unimplementable through KeeperHub if it does not.
// Sends 1 wei with distinctive values, then reads the tx back off the chain.
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';

const env = Object.fromEntries(
  readFileSync('/project/blackbox/.env.local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const pub = createPublicClient({ transport: http(env.ALCHEMY_RPC_URL) });
const managed = env.KH_MANAGED_WALLET_ADDRESS;
const nonce = await pub.getTransactionCount({ address: managed, blockTag: 'pending' });

// Distinctive enough that a coincidence is not plausible.
const PRIORITY = 1234567n;
const MAXFEE = 7_000_000_007n;

const body = {
  network: 'sepolia',
  recipientAddress: env.CHAOS_SIGNER_ADDRESS,
  amount: '0.000000000000000001',
  nonce,
  maxFeePerGas: MAXFEE.toString(),
  maxPriorityFeePerGas: PRIORITY.toString(),
  gasPrice: MAXFEE.toString(),
};

console.log('managed wallet', managed, 'pending nonce', nonce);
console.log('sending with overrides', { nonce, maxFeePerGas: MAXFEE.toString(), maxPriorityFeePerGas: PRIORITY.toString() });

const res = await fetch('https://app.keeperhub.com/api/execute/transfer', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.KEEPERHUB_ORG_KEY}`,
    Origin: 'https://app.keeperhub.com',
    Referer: 'https://app.keeperhub.com/',
  },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log('status', res.status);
console.log(text.slice(0, 1200));

let parsed;
try { parsed = JSON.parse(text); } catch { parsed = null; }
const hash = parsed?.receipts?.at(-1)?.transactionHash ?? parsed?.transactionHash;
if (!hash) { console.log('no tx hash in response — cannot verify'); process.exit(1); }

console.log('\nexplorer https://sepolia.etherscan.io/tx/' + hash);
let tx = null;
for (let i = 0; i < 20 && !tx; i++) {
  try { tx = await pub.getTransaction({ hash }); } catch { await new Promise((r) => setTimeout(r, 3000)); }
}
if (!tx) { console.log('tx not visible yet'); process.exit(1); }

console.log('\nonchain:');
console.log('  nonce               ', tx.nonce, tx.nonce === nonce ? '== requested' : `!= requested ${nonce}`);
console.log('  maxFeePerGas        ', tx.maxFeePerGas?.toString(), tx.maxFeePerGas === MAXFEE ? 'HONOURED' : 'ignored');
console.log('  maxPriorityFeePerGas', tx.maxPriorityFeePerGas?.toString(), tx.maxPriorityFeePerGas === PRIORITY ? 'HONOURED' : 'ignored');
