/**
 * Feature audit — the headline path, end to end, against the deployment.
 *
 * Plan chaos for a wallet we hold, sign it ourselves, report the hashes, and
 * wait for Blackbox to notice unattended. Then exercise the routes that only
 * exist once there is a real incident.
 */
import { describe, expect, it } from 'vitest';
import { createWalletClient, createPublicClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const H = process.env['AUDIT_HOST'] ?? 'https://blackbox-kh.parakramlabs.com';
const log = (id: string, detail: unknown): void =>
  console.log(`AUDIT|${id}|${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);

const post = async (path: string, body: unknown, token?: string) => {
  const res = await fetch(`${H}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as never };
};

const get = async (path: string, token?: string) => {
  const res = await fetch(`${H}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as never };
};

describe('wallet-signed chaos, end to end on the deployment', () => {
  it('plan → sign → observe → detect → act', { timeout: 600_000 }, async () => {
    const account = privateKeyToAccount(process.env['CHAOS_SIGNER_PRIVATE_KEY'] as Hex);
    const rpc = process.env['SEPOLIA_RPC_URL']!;
    const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
    const chain = createPublicClient({ chain: sepolia, transport: http(rpc) });

    const balance = await chain.getBalance({ address: account.address });
    log('cycle.wallet', { address: account.address, balanceEth: Number(balance) / 1e18 });
    expect(balance).toBeGreaterThan(0n);

    // 1. Ask for a plan. Blackbox holds no key for this wallet.
    const plan = await post('/api/chaos/plan', {
      signer: account.address,
      scenario: 'C2',
      chainId: 11155111,
    });
    log('cycle.plan', {
      status: plan.status,
      induces: plan.body?.['induces'],
      steps: (plan.body?.['steps'] as unknown[])?.length,
      expectedDetectionSeconds: plan.body?.['expectedDetectionSeconds'],
    });
    expect(plan.status).toBe(200);

    // 2. Sign and broadcast every step ourselves.
    //    The plan carries an absolute nonce per step, chosen server-side to
    //    leave the hole — the wallet's own next nonce is not what to use.
    const hashes: string[] = [];
    const steps = plan.body['steps'] as {
      label: string;
      waitForInclusion?: boolean;
      transaction: {
        to: `0x${string}`;
        data: string | null;
        value: string;
        nonce: number;
        maxFeePerGas: string;
        maxPriorityFeePerGas: string;
        gas: string;
      };
    }[];
    for (const step of steps) {
      const t = step.transaction;
      const hash = await wallet.sendTransaction({
        to: t.to,
        ...(t.data ? { data: t.data as `0x${string}` } : {}),
        value: BigInt(t.value),
        nonce: t.nonce,
        gas: BigInt(t.gas),
        maxFeePerGas: BigInt(t.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
      });
      hashes.push(hash);
      log('cycle.signed', { label: step.label, hash, nonce: t.nonce });
      if (step.waitForInclusion) {
        await chain.waitForTransactionReceipt({ hash, timeout: 120_000 });
      }
    }

    // 3. Report them. The queued transaction exists on no block, so Blackbox
    //    cannot find it by scanning — this is the only way it learns of it.
    const observed = await post('/api/chaos/observe', { txHashes: hashes, chainId: 11155111 });
    log('cycle.observe', { status: observed.status, observed: observed.body?.['observed'] });
    expect(observed.status).toBe(200);

    // 4. Wait for detection, unattended.
    let incident: Record<string, unknown> | undefined;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10_000));
      const list = await get(
        `/api/incidents?signer=${account.address.toLowerCase()}&limit=20`,
      );
      const items = (list.body?.['items'] ?? []) as Record<string, unknown>[];
      const found = items.find((i) => i['class'] === 'NONCE_GAP' && i['status'] !== 'resolved');
      if (found) {
        incident = found;
        break;
      }
    }
    log('cycle.detected', incident ? { id: incident['id'], class: incident['class'], summary: incident['summary'] } : 'NOT DETECTED');
    expect(incident, 'no NONCE_GAP incident appeared within 5 minutes').toBeTruthy();

    const id = String(incident!['id']);

    // 5. The routes that only exist once there is an incident.
    const detail = await get(`/api/incidents/${id}`);
    log('cycle.detail', {
      status: detail.status,
      ruleId: (detail.body?.['evidence'] as Record<string, unknown>)?.['ruleId'],
      events: (detail.body?.['events'] as unknown[])?.length,
    });

    const planRoute = await get(`/api/incidents/${id}/remediation-plan`);
    log('cycle.remediationPlan', { status: planRoute.status, body: JSON.stringify(planRoute.body).slice(0, 220) });

    const remediate = await post(`/api/incidents/${id}/remediate`, {});
    log('cycle.remediate', { status: remediate.status, body: JSON.stringify(remediate.body).slice(0, 260) });

    const ack = await post(`/api/incidents/${id}/acknowledge`, {});
    log('cycle.acknowledge', { status: ack.status, status_after: ack.body?.['status'] });

    expect(detail.status).toBe(200);
  });
});
