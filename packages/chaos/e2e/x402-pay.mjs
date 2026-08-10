// Pay for a KeeperHub Marketplace call over x402, end to end.
//
// Blackbox publishes one of its own rules as a paid workflow. This is the other
// side of that: an agent discovering the resource, being told to pay, signing
// the payment, and getting the answer.
//
// The payer needs USDC on Base and no ETH at all. x402's "exact" scheme is an
// EIP-3009 TransferWithAuthorization — the payer signs an authorisation and a
// facilitator submits it and pays the gas.
import { readFileSync } from 'node:fs';
import { createPublicClient, http, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { x402HTTPClient } from '@x402/core/http';
import { toClientEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';

const env = Object.fromEntries(
  readFileSync('/project/blackbox/.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const SLUG = process.argv[2] ?? 'signer-gas-runway';
const URL = `https://app.keeperhub.com/api/mcp/workflows/${SLUG}/call`;
const BODY = {
  address: '0x01cc313321eb09c51f5b649f2bbd578ee32750a5',
  network: 'sepolia',
};

const account = privateKeyToAccount(env.CHAOS_SIGNER_PRIVATE_KEY);
const pub = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });

const usdc = (address, token) =>
  pub.readContract({
    address: token,
    abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [address],
  });

// --- 1. ask, and get told to pay -------------------------------------------
console.log(`calling ${SLUG} without paying`);
const challenge = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(BODY),
});
console.log('  ->', challenge.status, challenge.statusText);
if (challenge.status !== 402) {
  console.log('expected 402 Payment Required, got', challenge.status);
  process.exit(1);
}

const required = await challenge.json();
const terms = required.accepts[0];
console.log('  network :', terms.network);
console.log('  asset   :', terms.asset);
console.log('  amount  :', terms.amount, `(${formatUnits(BigInt(terms.amount), 6)} USDC)`);
console.log('  payTo   :', terms.payTo);

// --- 2. sign the authorisation ---------------------------------------------
// Built with the reference client rather than by hand. Reconstructing the
// payload from the spec got the signature right and the envelope wrong, which
// the server can only answer with another bare 402 — there is nothing it can
// usefully say about a payload it could not parse.
const before = await usdc(account.address, terms.asset);
console.log(`\npayer ${account.address} holds ${formatUnits(before, 6)} USDC`);
if (before < BigInt(terms.amount)) {
  console.log('not enough USDC to pay for this call');
  process.exit(1);
}

const signer = toClientEvmSigner(account, pub);
const client = new x402Client();
// register(network, scheme) — the same shape KeeperHub's own server uses.
client.register(terms.network, new ExactEvmScheme(signer));
const httpClient = new x402HTTPClient(client);

const built = await httpClient.createPaymentPayload(required);
// The reference client returns `{x402Version, payload}` and leaves `accepted`
// off, but the server matches the payment against the requirements it offered
// and answers "No matching payment requirements" without it. Echo back the
// exact terms it quoted.
const paymentPayload = { ...built, accepted: terms, resource: required.resource };
const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);
console.log('signed EIP-3009 authorisation, no gas spent');

// --- 3. ask again, paying --------------------------------------------------
console.log('\nretrying with PAYMENT-SIGNATURE');
const paid = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(BODY),
});
const text = await paid.text();
console.log('  ->', paid.status, paid.statusText);
console.log('  sent payload:', JSON.stringify(paymentPayload).slice(0, 400));
for (const [k, v] of paid.headers.entries()) {
  if (/payment|auth|error|x402/i.test(k)) console.log(`  hdr ${k}: ${String(v).slice(0, 200)}`);
}

const receipt = paid.headers.get('Payment-Receipt');
if (receipt) console.log('  receipt:', receipt.slice(0, 120));
console.log('  body   :', text.slice(0, 400));

// --- 4. confirm the money actually moved -----------------------------------
if (paid.ok) {
  let after = before;
  for (let i = 0; i < 20 && after === before; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    after = await usdc(account.address, terms.asset);
  }
  console.log(
    `\npayer balance ${formatUnits(before, 6)} -> ${formatUnits(after, 6)} USDC` +
      (after === before ? '  (not settled yet)' : `  (paid ${formatUnits(before - after, 6)})`),
  );
}
