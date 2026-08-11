import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHAIN_IDS, type KeeperHubRun, type KeeperHubRunPage } from '@blackbox/core';
import {
  createDb,
  executionEvents,
  getCursor,
  ingestCursors,
  setCursor,
  type Database,
} from '@blackbox/store';
import { KeeperHubSource, nextHighWater, type RunLister } from './keeperhub-source.js';

const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const SIGNER = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5' as `0x${string}`;

const run = (over: Partial<KeeperHubRun> & { id: string; startedAt: string }): KeeperHubRun => ({
  source: 'workflow',
  status: 'success',
  completedAt: null,
  durationMs: null,
  workflowId: 'wf-1',
  workflowName: 'blackbox/demo',
  directType: null,
  network: '11155111',
  networks: ['11155111'],
  gasCostWei: null,
  gasUsedWei: null,
  transactionHashes: [
    { hash: `0x${over.id.padEnd(64, '0').slice(0, 64)}`, chainId: 11155111, receiptStatus: 'success' },
  ],
  totalSteps: null,
  completedSteps: null,
  error: null,
  errorCode: null,
  errorType: null,
  errorCategory: null,
  ...over,
});

/** Serves runs newest-first and pages backwards, exactly as the API does. */
const lister = (runs: KeeperHubRun[], pageSize = 2): RunLister & { calls: unknown[] } => {
  const calls: unknown[] = [];
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return {
    calls,
    async listRuns(params): Promise<KeeperHubRunPage> {
      calls.push(params);
      const limit = params.limit ?? pageSize;
      const after = params.cursor
        ? sorted.filter((r) => Date.parse(r.startedAt) < Date.parse(params.cursor!))
        : sorted;
      const page = after.slice(0, limit);
      const hasMore = after.length > page.length;
      return {
        runs: page,
        nextCursor: hasMore ? (page.at(-1)?.startedAt ?? null) : null,
        total: sorted.length,
        page: 1,
        pageSize: limit,
      };
    },
  };
};

describe('nextHighWater', () => {
  it('advances to the newest run when everything settled', () => {
    expect(
      nextHighWater(
        [run({ id: 'a', startedAt: '2026-08-10T10:00:00.000Z' }), run({ id: 'b', startedAt: '2026-08-10T12:00:00.000Z' })],
        null,
      ),
    ).toBe('2026-08-10T12:00:00.000Z');
  });

  // Moving past a running run would mean never reading its outcome — and the
  // outcome is the only part detection cares about.
  it('stops just short of the earliest unfinished run', () => {
    const marked = nextHighWater(
      [
        run({ id: 'a', startedAt: '2026-08-10T10:00:00.000Z' }),
        run({ id: 'b', startedAt: '2026-08-10T11:00:00.000Z', status: 'running' }),
        run({ id: 'c', startedAt: '2026-08-10T12:00:00.000Z' }),
      ],
      null,
    );
    expect(marked).toBe('2026-08-10T10:59:59.999Z');
  });

  it('never moves the mark backwards', () => {
    const current = '2026-08-10T12:00:00.000Z';
    expect(
      nextHighWater([run({ id: 'b', startedAt: '2026-08-10T11:00:00.000Z', status: 'running' })], current),
    ).toBe(current);
  });

  it('leaves the mark alone when a sweep found nothing new', () => {
    expect(nextHighWater([], '2026-08-10T12:00:00.000Z')).toBeNull();
  });
});

describe('KeeperHubSource', () => {
  let db: Database;
  let close: () => Promise<void>;
  let counter = 0;

  beforeAll(() => {
    ({ db, close } = createDb(URL));
  });
  afterAll(async () => {
    await close();
  });
  beforeEach(async () => {
    await db.delete(executionEvents);
    await db.delete(ingestCursors);
    counter = 0;
  });

  const source = (client: RunLister, over: Record<string, unknown> = {}): KeeperHubSource =>
    new KeeperHubSource({
      db,
      client,
      orgId: 'org-1',
      agentId: 'agent-1',
      signer: SIGNER,
      fallbackChainId: CHAIN_IDS.sepolia,
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      makeId: () => `id-${++counter}`,
      ...over,
    });

  it('ingests a page and records where it got to', async () => {
    const client = lister([
      run({ id: 'a', startedAt: '2026-08-10T10:00:00.000Z' }),
      run({ id: 'b', startedAt: '2026-08-10T12:00:00.000Z' }),
    ]);
    const result = await source(client).ingest();
    expect(result).toMatchObject({ runsSeen: 2, runsIngested: 2, eventsInserted: 2, errors: 0 });
    expect(await getCursor(db, 'keeperhub:org-1')).toBe('2026-08-10T12:00:00.000Z');
    expect(result.touched).toEqual([
      { signer: SIGNER, chainId: CHAIN_IDS.sepolia, agentId: 'agent-1' },
    ]);
  });

  it('stops paging once it reaches the mark instead of walking all of history', async () => {
    await setCursor(db, 'keeperhub:org-1', '2026-08-10T11:00:00.000Z');
    const client = lister(
      [
        run({ id: 'old', startedAt: '2026-08-10T09:00:00.000Z' }),
        run({ id: 'older', startedAt: '2026-08-10T08:00:00.000Z' }),
        run({ id: 'new', startedAt: '2026-08-10T12:00:00.000Z' }),
      ],
      2,
    );
    const result = await source(client).ingest();
    expect(result.runsIngested).toBe(1);
    // One page: it saw a run at or under the mark and stopped.
    expect(client.calls).toHaveLength(1);
  });

  it('re-reads an unfinished run on the next sweep and updates it in place', async () => {
    const pending = run({ id: 'p', startedAt: '2026-08-10T12:00:00.000Z', status: 'running' });
    pending.transactionHashes = [];
    const first = await source(lister([pending])).ingest();
    expect(first.eventsInserted).toBe(1);
    const mark = await getCursor(db, 'keeperhub:org-1');
    expect(mark).toBe('2026-08-10T11:59:59.999Z');

    const settled = { ...pending, status: 'success' as const, transactionHashes: pending.transactionHashes };
    const second = await source(lister([settled])).ingest();
    expect(second.runsIngested).toBe(1);
    // Same sourceId, so the row is updated rather than duplicated.
    const rows = await db.select().from(executionEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toMatchObject({ status: 'unknown' });
  });

  it('reports a truncated sweep rather than under-counting quietly', async () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      run({ id: `r${i}`, startedAt: `2026-08-10T1${i}:00:00.000Z` }),
    );
    const errors: unknown[] = [];
    const result = await source(lister(runs, 2), {
      maxPages: 2,
      pageSize: 2,
      logger: { info: () => {}, error: (m: string, d?: unknown) => errors.push([m, d]) },
    }).ingest();
    expect(result.truncated).toBe(true);
    expect(result.pagesFetched).toBe(2);
    expect(errors).toHaveLength(1);
  });

  // KeeperHub owns nonce management for a managed wallet, so events from a run
  // must say so — a rule that reads nonces has to be able to decline.
  it('marks what it stores as executing on a managed wallet', async () => {
    await source(lister([run({ id: 'a', startedAt: '2026-08-10T12:00:00.000Z' })])).ingest();
    const rows = await db.select().from(executionEvents);
    expect(rows[0]?.agentKind).toBe('keeperhub');
    expect(rows[0]?.workflowId).toBe('wf-1');
  });

  it('counts a run on an unreadable chain instead of dropping it silently', async () => {
    const unknown = run({ id: 'x', startedAt: '2026-08-10T12:00:00.000Z' });
    unknown.network = 'solana';
    unknown.networks = ['solana'];
    unknown.transactionHashes = [{ hash: `0x${'f'.repeat(64)}`, network: 'solana' }];
    const result = await source(lister([unknown]), { fallbackChainId: undefined }).ingest();
    expect(result).toMatchObject({ runsSeen: 1, runsIngested: 0, skippedUnknownChain: 1 });
  });

  // A transient store failure must not cost the run: the mark stays behind it
  // so the next sweep sees it again.
  it('does not advance the mark past a run it failed to store', async () => {
    const runs = [
      run({ id: 'lost', startedAt: '2026-08-10T11:00:00.000Z' }),
      run({ id: 'kept', startedAt: '2026-08-10T12:00:00.000Z' }),
    ];
    let fail = true;
    const client = lister(runs);
    const flaky = source(client, {
      makeId: () => {
        if (fail) {
          fail = false;
          throw new Error('store unavailable');
        }
        return 'id-ok';
      },
      logger: { info: () => {}, error: () => {} },
    });
    const result = await flaky.ingest();
    expect(result.errors).toBe(1);
    expect(result.runsIngested).toBe(1);
    // Just short of the run that failed, not past it.
    expect(await getCursor(db, 'keeperhub:org-1')).toBe('2026-08-10T10:59:59.999Z');
  });

  describe('watching only the workflows an operator picked', () => {
    it('keeps the chosen ones and counts the rest', async () => {
      const client = lister([
        run({ id: 'a', startedAt: '2026-08-10T10:00:00.000Z', workflowId: 'wf-1' }),
        run({ id: 'b', startedAt: '2026-08-10T11:00:00.000Z', workflowId: 'wf-2' }),
      ]);
      const result = await source(client, { workflowIds: ['wf-1'] }).ingest();

      expect(result.runsIngested).toBe(1);
      expect(result.runsFiltered).toBe(1);
      const stored = await db.select().from(executionEvents);
      expect(stored.map((e) => e.workflowId)).toEqual(['wf-1']);
    });

    /**
     * Picking three workflows is not picking "and everything anyone types into
     * the API", so a direct execution belongs to nobody's choice.
     */
    it('leaves direct executions alone once workflows are chosen', async () => {
      const client = lister([
        run({ id: 'a', startedAt: '2026-08-10T10:00:00.000Z', source: 'direct', workflowId: null }),
      ]);
      const result = await source(client, { workflowIds: ['wf-1'] }).ingest();
      expect(result.runsIngested).toBe(0);
      expect(result.runsFiltered).toBe(1);
    });

    it('watches everything when nobody has picked', async () => {
      const client = lister([
        run({ id: 'a', startedAt: '2026-08-10T10:00:00.000Z', workflowId: 'wf-1' }),
        run({ id: 'b', startedAt: '2026-08-10T11:00:00.000Z', workflowId: 'wf-2' }),
      ]);
      expect((await source(client).ingest()).runsIngested).toBe(2);
    });

    /**
     * The mark must follow what was *seen*, not what was kept: otherwise an
     * organisation whose newest runs are all unwatched re-reads the same
     * history on every sweep, for ever.
     */
    it('still moves the mark when everything on the page was filtered out', async () => {
      const client = lister([
        run({ id: 'a', startedAt: '2026-08-10T10:00:00.000Z', workflowId: 'wf-other' }),
        run({ id: 'b', startedAt: '2026-08-10T11:00:00.000Z', workflowId: 'wf-other' }),
      ]);
      const result = await source(client, { workflowIds: ['wf-1'] }).ingest();

      expect(result.runsIngested).toBe(0);
      expect(await getCursor(db, 'keeperhub:org-1')).toBe('2026-08-10T11:00:00.000Z');
    });

    it('does not let an unwatched pending run hold the mark back', async () => {
      const client = lister([
        run({ id: 'a', startedAt: '2026-08-10T10:00:00.000Z', workflowId: 'wf-1' }),
        run({
          id: 'b',
          startedAt: '2026-08-10T11:00:00.000Z',
          workflowId: 'wf-other',
          status: 'running',
        }),
      ]);
      await source(client, { workflowIds: ['wf-1'] }).ingest();
      expect(await getCursor(db, 'keeperhub:org-1')).toBe('2026-08-10T11:00:00.000Z');
    });
  });

  /**
   * The same organisation can be read twice — once by a deployment sweeping
   * its own, once by the operator who connected that account — and the two
   * keep different workflows. One shared position would let whichever swept
   * first move the mark past runs the other had never seen.
   */
  it('keeps a separate position when asked to', async () => {
    const client = lister([run({ id: 'a', startedAt: '2026-08-10T10:00:00.000Z' })]);
    await source(client, { cursorKey: 'keeperhub:conn:org-1' }).ingest();

    expect(await getCursor(db, 'keeperhub:conn:org-1')).toBe('2026-08-10T10:00:00.000Z');
    expect(await getCursor(db, 'keeperhub:org-1')).toBeNull();
  });

  it('files each workflow under its own agent when asked to', async () => {
    const client = lister([
      run({ id: 'a', startedAt: '2026-08-10T10:00:00.000Z', workflowId: 'wf-1' }),
      run({ id: 'b', startedAt: '2026-08-10T11:00:00.000Z', workflowId: 'wf-2' }),
    ]);
    await source(client, {
      agentId: (r: KeeperHubRun) => (r.workflowId ? `kh:${r.workflowId}` : 'kh:direct:org-1'),
    }).ingest();

    const stored = await db.select().from(executionEvents);
    expect(new Set(stored.map((e) => e.agentId))).toEqual(new Set(['kh:wf-1', 'kh:wf-2']));
  });
});
