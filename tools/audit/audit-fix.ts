/** Feature audit — the propose-and-verify path: Blackbox plans, a wallet signs. */
import { describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const H = 'https://blackbox-kh.parakramlabs.com';
const ID = process.env['INCIDENT_ID']!;
const log = (id: string, detail: unknown): void =>
  console.log(`AUDIT|${id}|${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);

describe('propose and verify', () => {
  it('signs the fix Blackbox planned, and reports it back', { timeout: 300_000 }, async () => {
    const account = privateKeyToAccount(process.env['CHAOS_SIGNER_PRIVATE_KEY'] as Hex);
    const rpc = process.env['SEPOLIA_RPC_URL']!;
    const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
    const chain = createPublicClient({ chain: sepolia, transport: http(rpc) });

    const plan = (await (await fetch(`${H}/api/incidents/${ID}/remediation-plan`)).json()) as {
      transaction: {
        to: `0x${string}`;
        value: string;
        data: string | null;
        nonce: number;
        maxFeePerGas: string;
        maxPriorityFeePerGas: string;
        description: string;
      };
    };
    log('fix.plan', plan.transaction.description);

    const t = plan.transaction;
    const hash = await wallet.sendTransaction({
      to: t.to,
      value: BigInt(t.value),
      ...(t.data ? { data: t.data as `0x${string}` } : {}),
      nonce: t.nonce,
      maxFeePerGas: BigInt(t.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
    });
    log('fix.signed', hash);

    const receipt = await chain.waitForTransactionReceipt({ hash, timeout: 180_000 });
    log('fix.mined', { block: Number(receipt.blockNumber), status: receipt.status });

    const reported = await fetch(`${H}/api/incidents/${ID}/remediation-tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: hash }),
    });
    log('fix.reported', { status: reported.status, body: JSON.stringify(await reported.json()).slice(0, 240) });

    // The gap is filled, so the queued transaction can finally execute.
    const pending = await chain.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const latest = await chain.getTransactionCount({ address: account.address, blockTag: 'latest' });
    log('fix.nonces', { latest, pending });
    expect(receipt.status).toBe('success');
  });
});
