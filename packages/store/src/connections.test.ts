import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  disconnectKeeperhub,
  expireDueConnections,
  getKeeperhubConnection,
  keeperhubConnections,
  listSweepableConnections,
  listWatchedWorkflows,
  markConnectionNeedsReauth,
  recordConnectionFailure,
  recordConnectionRefresh,
  recordConnectionSweep,
  recordWorkflowRun,
  saveKeeperhubConnection,
  unwatchWorkflow,
  watchWorkflows,
  watchedWorkflows,
  type Database,
} from './index.js';

/**
 * Against the real Postgres, because the questions worth asking here are about
 * what the database does: does reconnecting keep the workflow choices, does the
 * expiry sweep pick exactly the connections whose date has passed, does a
 * failure counter actually increment rather than being read and rewritten.
 */
const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';

let db: Database;
let close: () => Promise<void>;

const T0 = new Date('2026-08-11T12:00:00.000Z');
const days = (n: number): Date => new Date(T0.getTime() + n * 24 * 60 * 60 * 1000);

const connect = (orgId: string, over: { expiresAt?: Date } = {}): Promise<void> =>
  saveKeeperhubConnection(db, {
    orgId,
    refreshTokenEnc: `v1.enc.${orgId}`,
    scope: 'mcp:read',
    subject: 'user-1',
    at: T0,
    expiresAt: over.expiresAt ?? days(30),
  });

beforeAll(() => {
  ({ db, close } = createDb(URL));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(watchedWorkflows);
  await db.delete(keeperhubConnections);
});

describe('a connected KeeperHub account', () => {
  it('stores the credential and starts active', async () => {
    await connect('org-a');
    const row = await getKeeperhubConnection(db, 'org-a');
    expect(row?.status).toBe('active');
    expect(row?.scope).toBe('mcp:read');
    expect(row?.refreshTokenEnc).toBe('v1.enc.org-a');
    expect(row?.expiresAt.toISOString()).toBe(days(30).toISOString());
    expect(row?.failureCount).toBe(0);
  });

  it('is unknown before anyone connects it', async () => {
    expect(await getKeeperhubConnection(db, 'nobody')).toBeNull();
  });

  it('keeps the rotated token, since the one we sent is already dead', async () => {
    await connect('org-a');
    await recordConnectionRefresh(db, { orgId: 'org-a', refreshTokenEnc: 'v1.enc.second', at: days(1) });
    const row = await getKeeperhubConnection(db, 'org-a');
    expect(row?.refreshTokenEnc).toBe('v1.enc.second');
    expect(row?.lastRefreshedAt?.toISOString()).toBe(days(1).toISOString());
  });

  it('does not extend our expiry when their clock is reset by a refresh', async () => {
    await connect('org-a', { expiresAt: days(7) });
    await recordConnectionRefresh(db, { orgId: 'org-a', refreshTokenEnc: 'v1.enc.second', at: days(6) });
    const row = await getKeeperhubConnection(db, 'org-a');
    expect(row?.expiresAt.toISOString()).toBe(days(7).toISOString());
  });

  it('counts consecutive failures, and forgets them on a success', async () => {
    await connect('org-a');
    expect(await recordConnectionFailure(db, 'org-a', 'timeout')).toBe(1);
    expect(await recordConnectionFailure(db, 'org-a', 'timeout')).toBe(2);
    await recordConnectionRefresh(db, { orgId: 'org-a', refreshTokenEnc: 'v1.enc.third', at: days(1) });
    const row = await getKeeperhubConnection(db, 'org-a');
    expect(row?.failureCount).toBe(0);
    expect(row?.lastError).toBeNull();
  });

  it('records when it was last swept', async () => {
    await connect('org-a');
    await recordConnectionSweep(db, 'org-a', days(2));
    expect((await getKeeperhubConnection(db, 'org-a'))?.lastSweptAt?.toISOString()).toBe(
      days(2).toISOString(),
    );
  });
});

describe('which connections the sweep reads from', () => {
  it('takes the active ones and leaves the rest alone', async () => {
    await connect('org-active');
    await connect('org-dead');
    await connect('org-gone');
    await markConnectionNeedsReauth(db, 'org-dead', 'invalid_grant');
    await disconnectKeeperhub(db, 'org-gone');

    const sweepable = await listSweepableConnections(db, days(1));
    expect(sweepable.map((c) => c.orgId)).toEqual(['org-active']);
  });

  it('drops a connection the moment our own date passes', async () => {
    await connect('org-short', { expiresAt: days(7) });
    expect((await listSweepableConnections(db, days(6))).length).toBe(1);
    expect((await listSweepableConnections(db, days(8))).length).toBe(0);
  });
});

describe('our own expiry', () => {
  it('expires exactly the connections past their date, and names them', async () => {
    await connect('org-short', { expiresAt: days(7) });
    await connect('org-long', { expiresAt: days(60) });

    expect(await expireDueConnections(db, days(8))).toEqual(['org-short']);
    expect((await getKeeperhubConnection(db, 'org-short'))?.status).toBe('needs_reauth');
    expect((await getKeeperhubConnection(db, 'org-long'))?.status).toBe('active');
  });

  it('expires nobody twice', async () => {
    await connect('org-short', { expiresAt: days(7) });
    await expireDueConnections(db, days(8));
    expect(await expireDueConnections(db, days(9))).toEqual([]);
  });

  it('keeps the watched workflows, so reconnecting does not ask again', async () => {
    await connect('org-a', { expiresAt: days(7) });
    await watchWorkflows(db, {
      orgId: 'org-a',
      workflows: [{ workflowId: 'wf-1', name: 'Rebalance' }],
      at: T0,
    });
    await expireDueConnections(db, days(8));

    await connect('org-a');
    const watched = await listWatchedWorkflows(db, 'org-a');
    expect(watched.map((w) => w.workflowId)).toEqual(['wf-1']);
    expect((await getKeeperhubConnection(db, 'org-a'))?.status).toBe('active');
  });
});

describe('disconnecting', () => {
  it('forgets the credential rather than keeping it around unused', async () => {
    await connect('org-a');
    await disconnectKeeperhub(db, 'org-a');
    const row = await getKeeperhubConnection(db, 'org-a');
    expect(row?.status).toBe('disconnected');
    expect(row?.refreshTokenEnc).toBe('');
  });
});

describe('choosing what to watch', () => {
  it('watches nothing until somebody picks', async () => {
    await connect('org-a');
    expect(await listWatchedWorkflows(db, 'org-a')).toEqual([]);
  });

  it('records the picks with their names', async () => {
    await watchWorkflows(db, {
      orgId: 'org-a',
      workflows: [
        { workflowId: 'wf-2', name: 'Harvest' },
        { workflowId: 'wf-1', name: 'Rebalance' },
      ],
      at: T0,
    });
    const watched = await listWatchedWorkflows(db, 'org-a');
    expect(watched.map((w) => [w.workflowId, w.name])).toEqual([
      ['wf-1', 'Rebalance'],
      ['wf-2', 'Harvest'],
    ]);
    expect(watched.every((w) => w.active)).toBe(true);
  });

  it('stops watching one without forgetting it', async () => {
    await watchWorkflows(db, { orgId: 'org-a', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    expect(await unwatchWorkflow(db, 'org-a', 'wf-1')).toBe(true);

    expect(await listWatchedWorkflows(db, 'org-a', { activeOnly: true })).toEqual([]);
    expect((await listWatchedWorkflows(db, 'org-a'))[0]?.active).toBe(false);
  });

  it('says so when there was nothing to stop watching', async () => {
    expect(await unwatchWorkflow(db, 'org-a', 'never-picked')).toBe(false);
  });

  it('turns one back on when it is picked again, and refreshes the name', async () => {
    await watchWorkflows(db, {
      orgId: 'org-a',
      workflows: [{ workflowId: 'wf-1', name: 'Old name' }],
      at: T0,
    });
    await unwatchWorkflow(db, 'org-a', 'wf-1');
    await watchWorkflows(db, {
      orgId: 'org-a',
      workflows: [{ workflowId: 'wf-1', name: 'New name' }],
      at: days(1),
    });

    const [row] = await listWatchedWorkflows(db, 'org-a');
    expect(row?.active).toBe(true);
    expect(row?.name).toBe('New name');
  });

  it('is per organisation, so one operator cannot see another’s picks', async () => {
    await watchWorkflows(db, { orgId: 'org-a', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    await watchWorkflows(db, { orgId: 'org-b', workflows: [{ workflowId: 'wf-9' }], at: T0 });

    expect((await listWatchedWorkflows(db, 'org-a')).map((w) => w.workflowId)).toEqual(['wf-1']);
    expect((await listWatchedWorkflows(db, 'org-b')).map((w) => w.workflowId)).toEqual(['wf-9']);
  });

  it('lets the same workflow id be watched by two organisations', async () => {
    await watchWorkflows(db, { orgId: 'org-a', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    await watchWorkflows(db, { orgId: 'org-b', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    expect((await listWatchedWorkflows(db, 'org-b')).length).toBe(1);
  });

  it('accepts an empty pick as a no-op rather than an error', async () => {
    await watchWorkflows(db, { orgId: 'org-a', workflows: [], at: T0 });
    expect(await listWatchedWorkflows(db, 'org-a')).toEqual([]);
  });

  it('remembers when a run last landed', async () => {
    await watchWorkflows(db, { orgId: 'org-a', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    await recordWorkflowRun(db, { orgId: 'org-a', workflowId: 'wf-1', name: 'Rebalance', at: days(3) });

    const [row] = await listWatchedWorkflows(db, 'org-a');
    expect(row?.lastRunAt?.toISOString()).toBe(days(3).toISOString());
    expect(row?.name).toBe('Rebalance');
  });
});
