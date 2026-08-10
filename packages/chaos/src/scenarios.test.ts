import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN_IDS } from '@blackbox/core';
import { createDb, watchedTransactions, type Database } from '@blackbox/store';
import { toFunctionSelector } from 'viem';
import { ChaosHarness, SELECTORS } from './scenarios.js';

const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const T0 = new Date('2026-08-10T10:00:00.000Z');

// A throwaway key. Never funded, and every test stubs the transport.
const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);

let db: Database;
let close: () => Promise<void>;

beforeAll(() => {
  ({ db, close } = createDb(URL));
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await db.delete(watchedTransactions);
});

const BASE_FEE = 1_000_000_000n;

const stubClients = (over: { latest?: number; pending?: number } = {}) => {
  const sent: Record<string, unknown>[] = [];
  const publicClient = {
    getBlock: async () => ({ baseFeePerGas: BASE_FEE }),
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      blockTag === 'pending' ? (over.pending ?? over.latest ?? 4) : (over.latest ?? 4),
  } as never;
  const walletClient = {
    sendTransaction: async (tx: Record<string, unknown>) => {
      sent.push(tx);
      return `0x${String(sent.length).repeat(64)}` as `0x${string}`;
    },
  } as never;
  return { publicClient, walletClient, sent };
};

const harness = (chainId: number, over: { latest?: number; pending?: number } = {}) => {
  const stubs = stubClients(over);
  return {
    stubs,
    h: new ChaosHarness({
      db,
      account,
      chainId,
      rpcUrl: 'http://unused.invalid',
      now: () => T0,
      publicClient: stubs.publicClient,
      walletClient: stubs.walletClient,
    }),
  };
};

describe('testnet restriction', () => {
  it('refuses Ethereum mainnet at construction', () => {
    expect(
      () =>
        new ChaosHarness({
          db,
          account,
          chainId: CHAIN_IDS.ethereum,
          rpcUrl: 'http://unused.invalid',
        }),
    ).toThrow(/refused/);
  });

  it('refuses Base mainnet at construction', () => {
    expect(
      () =>
        new ChaosHarness({
          db,
          account,
          chainId: CHAIN_IDS.base,
          rpcUrl: 'http://unused.invalid',
        }),
    ).toThrow(/refused/);
  });

  it('refuses a chain it has never heard of', () => {
    expect(
      () => new ChaosHarness({ db, account, chainId: 999_999, rpcUrl: 'http://unused.invalid' }),
    ).toThrow(/refused/);
  });

  it('allows both configured testnets', () => {
    expect(() => harness(CHAIN_IDS.sepolia)).not.toThrow();
    expect(() => harness(CHAIN_IDS.baseSepolia)).not.toThrow();
  });

  it('guards again at call time, not only at construction', async () => {
    const { h } = harness(CHAIN_IDS.sepolia);
    // Reaching past the constructor must not get past the guard.
    (h as unknown as { options: { chainId: number } }).options.chainId = CHAIN_IDS.ethereum;
    await expect(h.c1UnderpricedStuck()).rejects.toThrow(/refused/);
  });
});

describe('C1 marginal bid', () => {
  it('bids exactly the base fee, never below it', async () => {
    const { h, stubs } = harness(CHAIN_IDS.sepolia);
    const result = await h.c1UnderpricedStuck();

    const tx = stubs.sent[0]!;
    // Nodes reject a bid below the base fee outright (-32000, "max fee per gas
    // less than block base fee"), so it would never reach the pool and there
    // would be nothing to detect. The lowest acceptable bid is the base fee.
    expect(tx['maxFeePerGas']).toBe(BASE_FEE);
    expect(tx['maxFeePerGas'] as bigint).not.toBeLessThan(BASE_FEE);
    expect(result.scenario).toBe('C1');
    expect(result.txHashes).toHaveLength(1);
  });

  it('offers no priority fee, so there is no incentive to include it', async () => {
    const { h, stubs } = harness(CHAIN_IDS.sepolia);
    await h.c1UnderpricedStuck();
    expect(stubs.sent[0]!['maxPriorityFeePerGas']).toBe(0n);
  });

  it('registers the transaction for observation', async () => {
    const { h } = harness(CHAIN_IDS.sepolia);
    const result = await h.c1UnderpricedStuck();

    const [row] = await db.select().from(watchedTransactions);
    expect(row!.txHash).toBe(result.txHashes[0]);
    expect(row!.label).toBe('C1');
    expect(row!.settledAt).toBeNull();
    expect(row!.signer).toBe(account.address.toLowerCase());
  });

  it('sends zero value, so a stuck transaction costs nothing but gas', async () => {
    const { h, stubs } = harness(CHAIN_IDS.sepolia);
    await h.c1UnderpricedStuck();
    expect(stubs.sent[0]!['value']).toBe(0n);
    expect(stubs.sent[0]!['to']).toBe(account.address);
  });
});

describe('C2 nonce gap', () => {
  it('submits one above the latest nonce, leaving a hole', async () => {
    const { h, stubs } = harness(CHAIN_IDS.sepolia, { latest: 4, pending: 4 });
    const result = await h.c2NonceGap();

    expect(stubs.sent[0]!['nonce']).toBe(5);
    expect(result.detail['missingNonce']).toBe(4);
  });

  it('prices the gap transaction normally, so R3 does not also fire', async () => {
    const { h, stubs } = harness(CHAIN_IDS.sepolia, { latest: 4, pending: 4 });
    await h.c2NonceGap();
    // The scenario demonstrates R2; an underpriced bid would muddy which rule
    // the incident is showing.
    expect(stubs.sent[0]!['maxFeePerGas'] as bigint).toBeGreaterThan(BASE_FEE);
  });

  it('refuses to run when the signer already has transactions in flight', async () => {
    const { h } = harness(CHAIN_IDS.sepolia, { latest: 4, pending: 6 });
    // Inducing a gap on top of an existing one produces an incident nobody can
    // reason about.
    await expect(h.c2NonceGap()).rejects.toThrow(/clean nonce sequence/);
  });

  it('heals the gap by filling the missing nonce at a higher fee', async () => {
    const { h, stubs } = harness(CHAIN_IDS.sepolia, { latest: 4, pending: 4 });
    await h.healNonceGap();
    expect(stubs.sent[0]!['nonce']).toBe(4);
    expect(stubs.sent[0]!['maxFeePerGas'] as bigint).toBeGreaterThan(BASE_FEE * 2n);
  });

  it('registers the heal so the resolution is observed too', async () => {
    const { h } = harness(CHAIN_IDS.sepolia, { latest: 4, pending: 4 });
    await h.healNonceGap();
    const [row] = await db.select().from(watchedTransactions);
    expect(row!.label).toBe('heal');
  });
});

describe('naming', () => {
  it('reports the chain it is pointed at, for the console warning banner', () => {
    expect(harness(CHAIN_IDS.sepolia).h.chainName).toBe('Ethereum Sepolia');
    expect(harness(CHAIN_IDS.baseSepolia).h.chainName).toBe('Base Sepolia');
  });
});

describe('ChaosTarget selectors', () => {
  it('match the deployed contract', () => {
    // Computed with `cast sig`. A wrong selector is not a compile error and not
    // a revert either — it hits the fallback and silently does nothing, so the
    // scenario would appear to run and induce no incident at all.
    expect(SELECTORS.armTrap).toBe(toFunctionSelector('armTrap()'));
    expect(SELECTORS.disarm).toBe(toFunctionSelector('disarm()'));
    expect(SELECTORS.work).toBe(toFunctionSelector('work()'));
    expect(SELECTORS.alwaysRevert).toBe(toFunctionSelector('alwaysRevert()'));
  });
});
