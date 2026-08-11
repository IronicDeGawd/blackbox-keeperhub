import type { PlannedTransaction } from './types';

/**
 * The injected wallet, spoken to directly over EIP-1193.
 *
 * Deliberately not through a client that builds transactions for you. Some
 * fixes have to occupy one specific nonce on one specific account — that is the
 * whole point of a nonce gap — so every field is sent exactly as planned. A
 * library that helpfully re-prices or re-nonces the transaction produces
 * something that costs money and fixes nothing, and the server will reject the
 * hash because it does not match the plan.
 *
 * Only the gas limit is left to the wallet, because the plan does not carry one.
 */

type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

/**
 * An EIP-1193 quantity: hex, no leading zeros, `0x0` for zero. BigInt renders
 * exactly this, and the values are wei figures no float could carry anyway.
 */
export function toQuantity(value: bigint | number | string): string {
  return `0x${BigInt(value).toString(16)}`;
}

function provider(): Eip1193Provider | null {
  const injected = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
  return injected ?? null;
}

export function walletAvailable(): boolean {
  return provider() !== null;
}

export type WalletConnection = { address: string; chainId: number };

export async function connectWallet(): Promise<WalletConnection> {
  const wallet = provider();
  if (!wallet) throw new Error('No injected wallet was found in this browser.');

  const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts[0];
  if (!address) throw new Error('The wallet connected but returned no account.');

  const chainId = Number(await wallet.request({ method: 'eth_chainId' }));
  return { address, chainId };
}

/**
 * Sign a message to prove an address. Nothing is sent to a chain.
 *
 * `personal_sign` takes the message first and the address second — the reverse
 * of `eth_sign`, which is deprecated for good reason. The message is passed as
 * text rather than hex so the wallet shows the operator what they are signing,
 * which is the entire point of the challenge wording.
 */
export async function signMessage(message: string, address: string): Promise<string> {
  const wallet = provider();
  if (!wallet) throw new Error('No injected wallet was found in this browser.');

  const signature = (await wallet.request({
    method: 'personal_sign',
    params: [message, address],
  })) as string;
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    throw new Error('The wallet returned no signature.');
  }
  return signature;
}

export async function switchChain(chainId: number): Promise<void> {
  const wallet = provider();
  if (!wallet) throw new Error('No injected wallet was found in this browser.');

  await wallet.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: toQuantity(chainId) }],
  });
}

/** Sends the plan verbatim. Nothing here recomputes a nonce or a fee. */
export async function sendPlannedTransaction(
  plan: PlannedTransaction,
  from: string,
): Promise<string> {
  const wallet = provider();
  if (!wallet) throw new Error('No injected wallet was found in this browser.');

  const request: Record<string, string> = {
    from,
    to: plan.to,
    value: toQuantity(plan.value),
    nonce: toQuantity(plan.nonce),
    maxFeePerGas: toQuantity(plan.maxFeePerGas),
    maxPriorityFeePerGas: toQuantity(plan.maxPriorityFeePerGas),
  };
  if (plan.data) request['data'] = plan.data;

  return (await wallet.request({ method: 'eth_sendTransaction', params: [request] })) as string;
}

/** Addresses differing only in case are the same account. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
