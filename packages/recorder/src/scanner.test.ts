import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  getCursor,
  ingestCursors,
  watchSigner,
  watchedSigners,
  watchedTransactions,
  type Database,
} from '@blackbox/store';
import { BlockScanner, type BlockReader } from './scanner.js';

const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const CHAIN = 11155111;
const WATCHED = '0xb9c58185d09d0acf3b237cd45c67345e32e628ba' as `0x${string}`;
const STRANGER = '0x00000000000000000000000000000000000000ff' as `0x${string}`;
const T0 = new Date('2026-08-10T14:00:00.000Z');

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
  await db.delete(watchedSigners);
  await db.delete(ingestCursors);
});

const tx = (hash: string, from: string, to?: string | null) => ({
  hash: `0x${hash.padEnd(64, '0')}` as `0x${string}`,
  from: from as `0x${string}`,
  to: (to ?? null) as `0x${string}` | null,
});

const reader = (head: bigint, blocks: Record<string, ReturnType<typeof tx>[]>): BlockReader => ({
  getBlockNumber: async () => head,
  getBlockWithTransactions: async (_chainId, n) => ({ transactions: blocks[n.toString()] ?? [] }),
});

const scanner = (r: BlockReader, over = {}) =>
  new BlockScanner({ db, reader: r, chainId: CHAIN, now: () => T0, ...over });

describe('BlockScanner', () => {
  it('does nothing at all when no address is registered', async () => {
    const getBlockNumber = vi.fn(async () => 100n);
    const result = await scanner({ getBlockNumber, getBlockWithTransactions: async () => null }).tick();

    expect(result.watching).toBe(0);
    expect(result.blocksScanned).toBe(0);
    // Not even a head query: nothing to look for.
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it('starts at the safe head rather than backfilling all of history', async () => {
    await watchSigner(db, { signer: WATCHED, chainId: CHAIN, agentId: 'judge', at: T0 });
    const result = await scanner(reader(100n, {})).tick();

    // 100 minus two confirmations, and it does not reach back to genesis.
    expect(result.fromBlock).toBe(98);
    expect(result.toBlock).toBe(98);
    expect(await getCursor(db, `blockscan:${CHAIN}`)).toBe('98');
  });

  it('discovers a transaction sent by a watched address', async () => {
    await watchSigner(db, { signer: WATCHED, chainId: CHAIN, agentId: 'judge', at: T0 });
    await scanner(reader(100n, {})).tick(); // establish the cursor at 98

    const result = await scanner(
      reader(102n, { '99': [tx('aa', WATCHED, STRANGER)], '100': [tx('bb', STRANGER, STRANGER)] }),
    ).tick();

    expect(result.matched).toBe(1);
    const rows = await db.select().from(watchedTransactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signer).toBe(WATCHED);
    expect(rows[0]?.agentId).toBe('judge');
  });

  it('discovers a transaction sent to a watched contract', async () => {
    await watchSigner(db, { signer: WATCHED, chainId: CHAIN, agentId: 'judge', at: T0 });
    await scanner(reader(100n, {})).tick();

    const result = await scanner(reader(101n, { '99': [tx('cc', STRANGER, WATCHED)] })).tick();
    expect(result.matched).toBe(1);
  });

  it('attributes the transaction to the watched address, not to tx.from', async () => {
    // The rules reason about the watched address's nonce and balance, so a
    // transaction discovered because it was *sent to* a watched contract must
    // not be filed under the stranger who sent it.
    await watchSigner(db, { signer: WATCHED, chainId: CHAIN, agentId: 'judge', at: T0 });
    await scanner(reader(100n, {})).tick();
    await scanner(reader(101n, { '99': [tx('dd', STRANGER, WATCHED)] })).tick();

    const rows = await db.select().from(watchedTransactions);
    expect(rows[0]?.signer).toBe(WATCHED);
  });

  it('stays behind head by the confirmation depth, so a reorg cannot invent an incident', async () => {
    await watchSigner(db, { signer: WATCHED, chainId: CHAIN, agentId: 'judge', at: T0 });
    const result = await scanner(reader(100n, {}), { confirmations: 5 }).tick();
    expect(result.fromBlock).toBe(95);
  });

  it('caps how many blocks one tick may read', async () => {
    await watchSigner(db, { signer: WATCHED, chainId: CHAIN, agentId: 'judge', at: T0 });
    await scanner(reader(100n, {})).tick();

    const result = await scanner(reader(1000n, {}), { maxBlocksPerTick: 10 }).tick();
    expect(result.blocksScanned).toBe(10);
    expect(result.toBlock).toBe(108);
  });

  it('never advances the cursor past a block it could not read', async () => {
    await watchSigner(db, { signer: WATCHED, chainId: CHAIN, agentId: 'judge', at: T0 });
    await scanner(reader(100n, {})).tick();

    const failing: BlockReader = {
      getBlockNumber: async () => 105n,
      getBlockWithTransactions: async (_c, n) => {
        if (n === 101n) throw new Error('node blipped');
        return { transactions: [] };
      },
    };
    const result = await scanner(failing).tick();

    expect(result.errors).toBe(1);
    expect(result.toBlock).toBe(100);
    expect(await getCursor(db, `blockscan:${CHAIN}`)).toBe('100');
  });

  it('reports a head failure rather than throwing', async () => {
    await watchSigner(db, { signer: WATCHED, chainId: CHAIN, agentId: 'judge', at: T0 });
    const failing: BlockReader = {
      getBlockNumber: async () => {
        throw new Error('rpc down');
      },
      getBlockWithTransactions: async () => null,
    };
    await expect(scanner(failing).tick()).resolves.toMatchObject({ errors: 1, matched: 0 });
  });

  it('does not rescan blocks it has already seen', async () => {
    await watchSigner(db, { signer: WATCHED, chainId: CHAIN, agentId: 'judge', at: T0 });
    await scanner(reader(100n, {})).tick();

    const getBlockWithTransactions = vi.fn(async () => ({ transactions: [] }));
    await scanner({ getBlockNumber: async () => 100n, getBlockWithTransactions }).tick();
    expect(getBlockWithTransactions).not.toHaveBeenCalled();
  });

  it('registering the same address twice reactivates rather than failing', async () => {
    await watchSigner(db, { signer: WATCHED, chainId: CHAIN, agentId: 'judge', at: T0 });
    await expect(
      watchSigner(db, { signer: WATCHED.toUpperCase(), chainId: CHAIN, agentId: 'judge2', at: T0 }),
    ).resolves.toBeUndefined();

    const rows = await db.select().from(watchedSigners);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe('judge2');
  });
});
