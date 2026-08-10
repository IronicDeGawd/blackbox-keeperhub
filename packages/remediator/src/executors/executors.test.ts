import { describe, expect, it, vi } from 'vitest';
import { CHAIN_IDS, type Incident } from '@blackbox/core';
import { privateKeyToAccount } from 'viem/accounts';
import type { PlaybookPlan } from '../playbooks.js';
import { KeeperHubExecutor, type KeeperHubSubmitter } from './keeperhub.js';
import { SignerExecutor } from './signer.js';
import { RoutingExecutor } from './routing.js';
import { ReceiptVerifier } from './verify.js';

const ACCOUNT = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const OTHER = '0x00000000000000000000000000000000000000ff' as `0x${string}`;
const TX = `0x${'a'.repeat(64)}` as `0x${string}`;
const T0 = new Date('2026-08-10T12:00:00.000Z');

const incident = (over: Partial<Incident> = {}): Incident =>
  ({
    id: 'inc-1',
    class: 'NONCE_GAP',
    severity: 'critical',
    status: 'open',
    agentId: 'chaos',
    signer: ACCOUNT.address,
    chainId: CHAIN_IDS.sepolia,
    detectedAt: T0,
    firstEventAt: T0,
    confidence: 0.9,
    evidence: { eventIds: ['e0'], ruleId: 'R2', facts: {} },
    ...over,
  }) as Incident;

const submitPlan = (over: Partial<Extract<PlaybookPlan, { kind: 'submit' }>> = {}) =>
  ({
    kind: 'submit',
    description: 'test plan',
    to: OTHER,
    value: 0n,
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 10n,
    route: 'public',
    ...over,
  }) as Extract<PlaybookPlan, { kind: 'submit' }>;

const stubSubmitter = (over: Partial<KeeperHubSubmitter> = {}): KeeperHubSubmitter => ({
  transfer: vi.fn(async () => ({ executionId: 'exec-1', transactionHash: TX })),
  writeContract: vi.fn(async () => ({ executionId: 'exec-2', transactionHash: TX })),
  ...over,
});

const verifier = () => new ReceiptVerifier({ [CHAIN_IDS.sepolia]: 'http://unused' });

describe('KeeperHubExecutor', () => {
  it('refuses any plan that names a nonce, because it submits via a sponsored relayer', async () => {
    const executor = new KeeperHubExecutor(stubSubmitter(), verifier());
    await expect(
      executor.submit({ plan: submitPlan({ nonce: 42 }), incident: incident() }),
    ).rejects.toThrow(/cannot submit at a chosen nonce/i);
  });

  it('names the signer and the required nonce in the refusal so the router can act on it', async () => {
    const executor = new KeeperHubExecutor(stubSubmitter(), verifier());
    await expect(
      executor.submit({ plan: submitPlan({ nonce: 7 }), incident: incident() }),
    ).rejects.toThrow(new RegExp(`${ACCOUNT.address}[\\s\\S]*nonce 7|nonce 7`, 'i'));
  });

  it('sends a value-only plan through the transfer endpoint', async () => {
    const client = stubSubmitter();
    const executor = new KeeperHubExecutor(client, verifier());
    const result = await executor.submit({
      plan: submitPlan({ value: 1_000_000_000_000_000_000n }),
      incident: incident(),
    });
    expect(client.transfer).toHaveBeenCalledWith({
      network: 'sepolia',
      recipientAddress: OTHER,
      amount: '1',
    });
    expect(result).toEqual({ txHash: TX, keeperHubActionId: 'exec-1' });
  });

  it('sends an ABI-level call through the contract-call endpoint', async () => {
    const client = stubSubmitter();
    const executor = new KeeperHubExecutor(client, verifier());
    await executor.submit({
      plan: submitPlan({ data: '0x8456cb59', call: { functionName: 'pause', args: [] } }),
      incident: incident(),
    });
    expect(client.writeContract).toHaveBeenCalledWith({
      network: 'sepolia',
      contractAddress: OTHER,
      functionName: 'pause',
      functionArgs: '[]',
    });
  });

  it('throws rather than reporting a remediation when no hash can be obtained', async () => {
    const client = stubSubmitter({
      transfer: vi.fn(async () => ({ executionId: 'exec-9' })),
    });
    const executor = new KeeperHubExecutor(client, verifier(), {
      hashLookupAttempts: 1,
      sleep: async () => {},
    });
    await expect(executor.submit({ plan: submitPlan(), incident: incident() })).rejects.toThrow(
      /no transaction hash/i,
    );
  });

  it('looks the hash up when the submission response omits it', async () => {
    // A live pause() came back `completed` with no hash while the transaction
    // was already on chain, so a real remediation was recorded as failed.
    const getExecutionStatus = vi
      .fn()
      .mockResolvedValueOnce({ transactionHash: null })
      .mockResolvedValueOnce({ transactionHash: TX });
    const client = stubSubmitter({
      writeContract: vi.fn(async () => ({ executionId: 'exec-2' })),
      getExecutionStatus,
    });
    const executor = new KeeperHubExecutor(client, verifier(), {
      hashLookupAttempts: 3,
      sleep: async () => {},
    });

    const result = await executor.submit({
      plan: submitPlan({ call: { functionName: 'pause', args: [] } }),
      incident: incident(),
    });
    expect(result).toEqual({ txHash: TX, keeperHubActionId: 'exec-2' });
    expect(getExecutionStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps asking when a status lookup throws', async () => {
    const getExecutionStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce({ transactionHash: TX });
    const client = stubSubmitter({
      transfer: vi.fn(async () => ({ executionId: 'exec-3' })),
      getExecutionStatus,
    });
    const executor = new KeeperHubExecutor(client, verifier(), {
      hashLookupAttempts: 3,
      sleep: async () => {},
    });
    await expect(executor.submit({ plan: submitPlan(), incident: incident() })).resolves.toEqual({
      txHash: TX,
      keeperHubActionId: 'exec-3',
    });
  });
});

describe('SignerExecutor', () => {
  it('refuses a signer whose key it does not hold', async () => {
    const executor = new SignerExecutor([], {}, verifier());
    await expect(
      executor.submit({ plan: submitPlan({ nonce: 3 }), incident: incident() }),
    ).rejects.toThrow(/no key held/i);
  });

  it('submits at the exact nonce and fees the playbook planned', async () => {
    const sendTransaction = vi.fn(async () => TX);
    const executor = new SignerExecutor(
      [ACCOUNT],
      {},
      verifier(),
      () => ({ sendTransaction }) as never,
    );
    const result = await executor.submit({
      plan: submitPlan({ nonce: 41, maxFeePerGas: 999n, maxPriorityFeePerGas: 5n }),
      incident: incident(),
    });
    expect(result).toEqual({ txHash: TX });
    expect(sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 41, maxFeePerGas: 999n, maxPriorityFeePerGas: 5n }),
    );
  });

  it('matches the held key case-insensitively', () => {
    const executor = new SignerExecutor([ACCOUNT], {}, verifier());
    expect(executor.holdsKeyFor(ACCOUNT.address.toUpperCase())).toBe(true);
  });
});

describe('RoutingExecutor', () => {
  const kh = { submit: vi.fn(), verify: vi.fn() };
  const signer = { submit: vi.fn(), verify: vi.fn(), holdsKeyFor: () => true };

  it('routes a nonce-precise plan to the key-holding executor', () => {
    const router = new RoutingExecutor({ keeperHub: kh, signer });
    expect(router.route(submitPlan({ nonce: 41 }), incident())).toBe(signer);
  });

  it('prefers KeeperHub when the plan does not need a nonce', () => {
    const router = new RoutingExecutor({ keeperHub: kh, signer });
    expect(router.route(submitPlan(), incident())).toBe(kh);
  });

  it('explains why a nonce-precise plan cannot run when no key is held', () => {
    const router = new RoutingExecutor({
      keeperHub: kh,
      signer: { ...signer, holdsKeyFor: () => false },
    });
    expect(() => router.route(submitPlan({ nonce: 41 }), incident())).toThrow(
      /sponsored relayer[\s\S]*no key is held/i,
    );
  });

  it('falls back to the key-holding executor when KeeperHub is not configured', () => {
    const router = new RoutingExecutor({ signer });
    expect(router.route(submitPlan(), incident())).toBe(signer);
  });
});

describe('ReceiptVerifier', () => {
  const receiptClient = (receipts: unknown[]) => {
    let i = 0;
    return {
      getTransactionReceipt: vi.fn(async () => {
        const next = receipts[i];
        i = Math.min(i + 1, receipts.length - 1);
        if (next instanceof Error) throw next;
        return next;
      }),
    };
  };

  const build = (client: unknown, now: () => number) => {
    const verifier = new ReceiptVerifier(
      { [CHAIN_IDS.sepolia]: 'http://unused' },
      async () => {},
      0,
      now,
    );
    vi.spyOn(verifier, 'client').mockReturnValue(client as never);
    return verifier;
  };

  it('reports a reverted receipt as not included', async () => {
    const verifier = build(receiptClient([{ status: 'reverted', gasUsed: 21_000n }]), () => 0);
    await expect(
      verifier.waitForReceipt({ txHash: TX, chainId: CHAIN_IDS.sepolia, timeoutMs: 1000 }),
    ).resolves.toEqual({ included: false, gasUsed: 21_000n });
  });

  it('keeps polling past a not-yet-mined error and then confirms', async () => {
    const client = receiptClient([new Error('not found'), { status: 'success', gasUsed: 21_000n }]);
    const verifier = build(client, () => 0);
    await expect(
      verifier.waitForReceipt({ txHash: TX, chainId: CHAIN_IDS.sepolia, timeoutMs: 1000 }),
    ).resolves.toEqual({ included: true, gasUsed: 21_000n });
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it('gives up at the deadline rather than waiting forever', async () => {
    let t = 0;
    const verifier = build(
      receiptClient([new Error('not found')]),
      () => (t += 600),
    );
    await expect(
      verifier.waitForReceipt({ txHash: TX, chainId: CHAIN_IDS.sepolia, timeoutMs: 1000 }),
    ).resolves.toEqual({ included: false });
  });

  it('refuses to verify on a chain it has no RPC for', () => {
    const verifier = new ReceiptVerifier({});
    expect(() => verifier.client(CHAIN_IDS.base)).toThrow(/No RPC URL configured/i);
  });
});
