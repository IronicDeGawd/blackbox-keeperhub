import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHAIN_IDS, type KeeperHubRun, type KeeperHubRunPage } from '@blackbox/core';
import {
  createDb,
  executionEvents,
  getKeeperhubConnection,
  ingestCursors,
  keeperhubConnections,
  listWatchedWorkflows,
  oauthClients,
  watchWorkflows,
  watchedWorkflows,
  type Database,
} from '@blackbox/store';
import { KeeperHubOAuth } from './oauth.js';
import { Connections } from './connections.js';
import { ConnectionSweeper, agentIdForRun } from './connection-sweeper.js';
import { keyFrom } from './secrets.js';

const URL_ = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const SIGNER = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5';
const T0 = new Date('2026-08-11T12:00:00.000Z');

const metadata = {
  issuer: 'https://provider.test',
  authorization_endpoint: 'https://provider.test/oauth/authorize',
  token_endpoint: 'https://provider.test/api/oauth/token',
  registration_endpoint: 'https://provider.test/api/oauth/register',
};
const jwt = (claims: Record<string, unknown>) =>
  ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');

const run = (over: Partial<KeeperHubRun> & { id: string; startedAt: string }): KeeperHubRun => ({
  source: 'workflow',
  status: 'success',
  completedAt: null,
  durationMs: null,
  workflowId: 'wf-1',
  workflowName: 'Rebalance',
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

describe('one workflow, one agent', () => {
  it('names a workflow run after its workflow', () => {
    expect(agentIdForRun('org-9', run({ id: 'a', startedAt: T0.toISOString() }))).toBe('kh:wf-1');
  });

  /** There is no workflow to name, so the organisation is the honest answer. */
  it('names a direct execution after the organisation', () => {
    expect(
      agentIdForRun('org-9', run({ id: 'a', startedAt: T0.toISOString(), workflowId: null })),
    ).toBe('kh:direct:org-9');
  });
});

describe('sweeping every connected account', () => {
  let db: Database;
  let close: () => Promise<void>;
  let counter = 0;
  let runs: KeeperHubRun[] = [];
  let walletAddress: string | null = SIGNER;
  let listCalls = 0;

  beforeAll(() => {
    ({ db, close } = createDb(URL_));
  });
  afterAll(async () => {
    await close();
  });
  beforeEach(async () => {
    counter = 0;
    listCalls = 0;
    runs = [];
    walletAddress = SIGNER;
    await db.delete(executionEvents);
    await db.delete(ingestCursors);
    await db.delete(watchedWorkflows);
    await db.delete(keeperhubConnections);
    await db.delete(oauthClients);
  });

  /** Their side: a token endpoint, a user record, and the run listing. */
  const impl = (async (url: string) => {
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return new Response(JSON.stringify(metadata), { status: 200 });
    }
    if (url === metadata.registration_endpoint) {
      return new Response(JSON.stringify({ client_id: 'client-1' }), { status: 201 });
    }
    if (url === metadata.token_endpoint) {
      return new Response(
        JSON.stringify({
          access_token: jwt({ org: 'org-9', exp: Math.floor(Date.now() / 1000) + 900 }),
          refresh_token: 'refresh-next',
          scope: 'mcp:read',
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/user')) {
      return new Response(JSON.stringify({ id: 'u1', walletAddress }), { status: 200 });
    }
    if (url.includes('/analytics/runs')) {
      listCalls += 1;
      const page: KeeperHubRunPage = { runs, nextCursor: null, total: runs.length };
      return new Response(JSON.stringify(page), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  const connections = () =>
    new Connections({
      db,
      oauth: new KeeperHubOAuth({
        db,
        baseUrl: 'https://blackbox.test',
        issuer: 'https://provider.test',
        fetchImpl: impl,
      }),
      key: keyFrom('a1'.repeat(32)),
      keeperHubApiUrl: 'https://provider.test/api',
      makeClient: (accessToken) =>
        new (class {
          async getUser() {
            const res = await impl(`https://provider.test/api/user`, {
              headers: { authorization: `Bearer ${accessToken}` },
            } as never);
            const body = (await res.json()) as { id: string; walletAddress: string | null };
            return {
              id: body.id,
              walletAddress: (body.walletAddress as `0x${string}` | null) ?? null,
            };
          }
        })(),
      now: () => T0,
    });

  const sweeper = (conns: Connections, over: Record<string, unknown> = {}) =>
    new ConnectionSweeper({
      db,
      connections: conns,
      fallbackChainId: CHAIN_IDS.sepolia,
      keeperHubApiUrl: 'https://provider.test/api',
      keeperHubFetch: impl,
      makeId: () => `evt-${++counter}`,
      now: () => T0,
      ...over,
    });

  const connect = async (conns: Connections, days = 30) =>
    conns.connect({ orgId: 'org-9', refreshToken: 'refresh-1', scope: 'mcp:read', days });

  it('reads the runs of a connected account, filed under its workflow', async () => {
    const conns = connections();
    await connect(conns);
    await watchWorkflows(db, { orgId: 'org-9', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    runs = [run({ id: 'a', startedAt: '2026-08-11T10:00:00.000Z' })];

    const result = await sweeper(conns).ingest();
    expect(result.eventsInserted).toBe(1);

    const stored = await db.select().from(executionEvents);
    expect(stored[0]?.agentId).toBe('kh:wf-1');
    expect(stored[0]?.signer).toBe(SIGNER);
  });

  /**
   * The choice is the point. An operator who connected and picked nothing has
   * said nothing is important yet, and reading everything anyway would be
   * watching more than they asked for.
   */
  it('reads nothing for a connection with no workflows chosen', async () => {
    const conns = connections();
    await connect(conns);
    runs = [run({ id: 'a', startedAt: '2026-08-11T10:00:00.000Z' })];

    expect((await sweeper(conns).ingest()).eventsInserted).toBe(0);
    expect(listCalls).toBe(0);
  });

  it('ignores runs of a workflow nobody picked', async () => {
    const conns = connections();
    await connect(conns);
    await watchWorkflows(db, { orgId: 'org-9', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    runs = [
      run({ id: 'a', startedAt: '2026-08-11T10:00:00.000Z', workflowId: 'wf-1' }),
      run({ id: 'b', startedAt: '2026-08-11T10:30:00.000Z', workflowId: 'wf-2' }),
    ];

    const result = await sweeper(conns).ingest();
    expect(result.eventsInserted).toBe(1);
    expect(result.runsFiltered).toBe(1);
  });

  it('looks up the address the organisation executes as, once, and remembers it', async () => {
    const conns = connections();
    await connect(conns);
    await watchWorkflows(db, { orgId: 'org-9', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    runs = [run({ id: 'a', startedAt: '2026-08-11T10:00:00.000Z' })];

    await sweeper(conns).ingest();
    expect((await getKeeperhubConnection(db, 'org-9'))?.signer).toBe(SIGNER);
  });

  /** Guessing an address would file one organisation's activity under another. */
  it('waits rather than guessing when the address cannot be read', async () => {
    walletAddress = null;
    const conns = connections();
    await connect(conns);
    await watchWorkflows(db, { orgId: 'org-9', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    runs = [run({ id: 'a', startedAt: '2026-08-11T10:00:00.000Z' })];

    const result = await sweeper(conns).ingest();
    expect(result.eventsInserted).toBe(0);
    expect(await db.select().from(executionEvents)).toEqual([]);
  });

  it('records when each connection and workflow was last read', async () => {
    const conns = connections();
    await connect(conns);
    await watchWorkflows(db, { orgId: 'org-9', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    runs = [run({ id: 'a', startedAt: '2026-08-11T10:00:00.000Z' })];

    await sweeper(conns).ingest();
    expect((await getKeeperhubConnection(db, 'org-9'))?.lastSweptAt?.toISOString()).toBe(
      T0.toISOString(),
    );
    expect((await listWatchedWorkflows(db, 'org-9'))[0]?.lastRunAt?.toISOString()).toBe(
      T0.toISOString(),
    );
  });

  it('leaves a disconnected account alone', async () => {
    const conns = connections();
    await connect(conns);
    await watchWorkflows(db, { orgId: 'org-9', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    await conns.disconnect('org-9');
    runs = [run({ id: 'a', startedAt: '2026-08-11T10:00:00.000Z' })];

    expect((await sweeper(conns).ingest()).eventsInserted).toBe(0);
    expect(listCalls).toBe(0);
  });

  it('sweeps this deployment\'s own organisation alongside the connected ones', async () => {
    const conns = connections();
    let ownSwept = 0;
    const own = {
      ingest: async () => {
        ownSwept += 1;
        return {
          runsSeen: 1,
          runsIngested: 1,
          eventsInserted: 2,
          pagesFetched: 1,
          truncated: false,
          skippedUnknownChain: 0,
          runsFiltered: 0,
          touched: [],
          errors: 0,
        };
      },
    };

    const result = await sweeper(conns, { ownSource: own }).ingest();
    expect(ownSwept).toBe(1);
    expect(result.eventsInserted).toBe(2);
  });

  /** One account failing must not stop the rest from being read. */
  it('keeps going when one connection fails, and counts the failure', async () => {
    const conns = connections();
    const own = {
      ingest: async () => {
        throw new Error('their side is down');
      },
    };
    const result = await sweeper(conns, { ownSource: own }).ingest();
    expect(result.errors).toBe(1);
  });

  it('stops sweeping a connection whose chosen lifetime has run out', async () => {
    await connect(connections(), 7);
    await watchWorkflows(db, { orgId: 'org-9', workflows: [{ workflowId: 'wf-1' }], at: T0 });
    runs = [run({ id: 'a', startedAt: '2026-08-11T10:00:00.000Z' })];

    // Same connection, read forty days later: their clock would still be
    // rolling, ours has run out.
    const later = new Date(T0.getTime() + 40 * 24 * 60 * 60 * 1000);
    const aged = new Connections({
      db,
      oauth: new KeeperHubOAuth({
        db,
        baseUrl: 'https://blackbox.test',
        issuer: 'https://provider.test',
        fetchImpl: impl,
      }),
      key: keyFrom('a1'.repeat(32)),
      now: () => later,
    });

    const result = await sweeper(aged, { now: () => later }).ingest();
    expect(result.eventsInserted).toBe(0);
    expect(listCalls).toBe(0);
    expect((await getKeeperhubConnection(db, 'org-9'))?.status).toBe('needs_reauth');
  });
});
