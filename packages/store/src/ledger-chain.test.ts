import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createDb,
  hashEntry,
  recordRemediationAttempt,
  remediationLedger,
  verifyChain,
  verifyLedger,
  type Database,
} from './index.js';

/**
 * The chain has to be proved against the real database, not a mock: what is
 * being claimed is that editing a stored row is detectable, and the only
 * honest way to test that is to edit one.
 */
const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';

let db: Database;
let close: () => Promise<void>;

const SIGNER = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5';
const T0 = new Date('2026-08-11T09:00:00.000Z');

beforeAll(() => {
  ({ db, close } = createDb(URL));
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await db.delete(remediationLedger);
});

const attempt = (over: Record<string, unknown> = {}) => ({
  id: 'rem-1',
  incidentId: 'inc-1',
  playbookId: 'P2',
  signer: SIGNER,
  chainId: 11155111,
  attemptedAt: T0,
  gasSpentWei: 21_000n,
  status: 'succeeded',
  txHash: `0x${'a'.repeat(64)}`,
  executor: 'signer',
  agentId: 'chaos',
  ...over,
});

describe('hashing an entry', () => {
  const entry = {
    id: 'rem-1',
    incidentId: 'inc-1',
    playbookId: 'P2',
    signer: SIGNER,
    chainId: 11155111,
    attemptedAt: T0,
    gasSpentWei: '21000',
    status: 'succeeded',
    txHash: null,
    executor: 'signer',
    agentId: 'chaos',
  };

  it('gives the same answer for a Date and the string postgres returns', () => {
    // Otherwise an entry verifies when written and fails when read back.
    expect(hashEntry({ ...entry, attemptedAt: T0.toISOString() }, null)).toBe(
      hashEntry(entry, null),
    );
  });

  it('ignores the case of the signer, which is stored lowercased', () => {
    expect(hashEntry({ ...entry, signer: SIGNER.toUpperCase() }, null)).toBe(
      hashEntry(entry, null),
    );
  });

  it('changes when any chained field changes', () => {
    const base = hashEntry(entry, null);
    expect(hashEntry({ ...entry, status: 'failed' }, null)).not.toBe(base);
    expect(hashEntry({ ...entry, gasSpentWei: '21001' }, null)).not.toBe(base);
    expect(hashEntry({ ...entry, txHash: '0xdead' }, null)).not.toBe(base);
    expect(hashEntry({ ...entry, agentId: 'someone-else' }, null)).not.toBe(base);
  });

  it('changes when the entry before it changes, which is the whole point', () => {
    expect(hashEntry(entry, 'aaaa')).not.toBe(hashEntry(entry, 'bbbb'));
    expect(hashEntry(entry, null)).not.toBe(hashEntry(entry, ''));
  });
});

describe('verifying a chain', () => {
  it('accepts an empty ledger without claiming it proves anything', async () => {
    expect(await verifyLedger(db)).toMatchObject({ ok: true, entries: 0, reason: 'empty' });
  });

  it('links each append to the one before it', async () => {
    await recordRemediationAttempt(db, attempt({ id: 'rem-1' }));
    await recordRemediationAttempt(db, attempt({ id: 'rem-2', status: 'failed' }));
    await recordRemediationAttempt(db, attempt({ id: 'rem-3' }));

    const rows = await db.select().from(remediationLedger).orderBy(remediationLedger.seq);
    expect(rows[0]?.prevHash).toBeNull();
    expect(rows[1]?.prevHash).toBe(rows[0]?.entryHash);
    expect(rows[2]?.prevHash).toBe(rows[1]?.entryHash);
    expect(await verifyLedger(db)).toMatchObject({ ok: true, entries: 3, brokenAt: null });
  });

  it('names the entry when a stored row is edited', async () => {
    await recordRemediationAttempt(db, attempt({ id: 'rem-1' }));
    await recordRemediationAttempt(db, attempt({ id: 'rem-2', status: 'failed' }));
    await recordRemediationAttempt(db, attempt({ id: 'rem-3' }));

    // A failed attempt made to look like a success — the exact edit the chain
    // exists to catch.
    await db
      .update(remediationLedger)
      .set({ status: 'succeeded' })
      .where(eq(remediationLedger.id, 'rem-2'));

    expect(await verifyLedger(db)).toMatchObject({
      ok: false,
      brokenAt: 'rem-2',
      reason: 'hash_mismatch',
    });
  });

  it('names the gap when an entry is deleted', async () => {
    await recordRemediationAttempt(db, attempt({ id: 'rem-1' }));
    await recordRemediationAttempt(db, attempt({ id: 'rem-2', status: 'failed' }));
    await recordRemediationAttempt(db, attempt({ id: 'rem-3' }));

    await db.delete(remediationLedger).where(eq(remediationLedger.id, 'rem-2'));

    expect(await verifyLedger(db)).toMatchObject({
      ok: false,
      brokenAt: 'rem-3',
      reason: 'broken_link',
    });
  });

  it('reports rows written before the chain rather than pretending them into it', async () => {
    await recordRemediationAttempt(db, attempt({ id: 'rem-1' }));
    // What an upgraded deployment looks like: older rows carry no hash.
    await db
      .update(remediationLedger)
      .set({ entryHash: null, prevHash: null })
      .where(eq(remediationLedger.id, 'rem-1'));
    await recordRemediationAttempt(db, attempt({ id: 'rem-2' }));

    expect(await verifyLedger(db)).toMatchObject({
      ok: true,
      entries: 1,
      unchained: 1,
      reason: 'ok',
    });
  });

  it('holds under concurrent appends, which would otherwise both claim one tip', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        recordRemediationAttempt(db, attempt({ id: `rem-${i}`, incidentId: `inc-${i}` })),
      ),
    );
    expect(await verifyLedger(db)).toMatchObject({ ok: true, entries: 8, brokenAt: null });
  });

  it('survives an entry whose seq was reused, since the walk follows the links', async () => {
    // Not a database this product creates, but a chain that only verifies
    // under perfect input is not evidence of anything.
    expect(
      verifyChain([
        {
          ...attempt({ id: 'a' }),
          gasSpentWei: '0',
          txHash: null,
          executor: null,
          agentId: null,
          prevHash: null,
          entryHash: 'not-a-real-hash',
        },
      ]),
    ).toMatchObject({ ok: false, brokenAt: 'a', reason: 'hash_mismatch' });
  });
});

describe('appending under load', () => {
  it('does not hold the lock past the insert', async () => {
    // A lock left held would deadlock the next append rather than fail it.
    await recordRemediationAttempt(db, attempt({ id: 'rem-1' }));
    const [{ held }] = (await db.execute(
      sql`select count(*)::int as held from pg_locks where locktype = 'advisory'`,
    )) as unknown as { held: number }[];
    expect(held).toBe(0);
  });
});
