import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  getKeeperhubConnection,
  keeperhubConnections,
  oauthAuthRequests,
  oauthClients,
  type Database,
} from '@blackbox/store';
import { KeeperHubOAuth } from './oauth.js';
import { Connections, lifetimeDays, MAX_LIFETIME_DAYS, MIN_LIFETIME_DAYS } from './connections.js';
import { decrypt, keyFrom } from './secrets.js';

const URL_ = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const KEY = keyFrom('c'.repeat(64));

const metadata = {
  issuer: 'https://provider.test',
  authorization_endpoint: 'https://provider.test/oauth/authorize',
  token_endpoint: 'https://provider.test/api/oauth/token',
  registration_endpoint: 'https://provider.test/api/oauth/register',
};

const jwt = (claims: Record<string, unknown>): string =>
  ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

const T0 = new Date('2026-08-11T12:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

/**
 * A provider that rotates, the way KeeperHub does: each refresh token is good
 * once, and using it issues a new one. That behaviour is the point of most of
 * what follows, so it is modelled rather than assumed away.
 */
function rotatingProvider(opts: { start?: string; failWith?: { status: number; body: unknown } } = {}) {
  const live = new Set<string>([opts.start ?? 'refresh-1']);
  const issued: string[] = [];
  let counter = 1;
  const calls: { grant: string; token: string | null }[] = [];

  const impl = (async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return new Response(JSON.stringify(metadata), { status: 200 });
    }
    if (url === metadata.registration_endpoint) {
      return new Response(JSON.stringify({ client_id: 'client-1' }), { status: 201 });
    }
    if (url !== metadata.token_endpoint) return new Response('', { status: 404 });

    const form = new URLSearchParams(String(init?.body ?? ''));
    const grant = form.get('grant_type') ?? '';
    const sent = form.get('refresh_token');
    calls.push({ grant, token: sent });

    if (opts.failWith) {
      return new Response(JSON.stringify(opts.failWith.body), { status: opts.failWith.status });
    }
    if (grant === 'refresh_token') {
      if (!sent || !live.has(sent)) {
        return new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token not found' }),
          { status: 400 },
        );
      }
      live.delete(sent);
    }
    counter += 1;
    const next = `refresh-${counter}`;
    live.add(next);
    issued.push(next);
    return new Response(
      JSON.stringify({
        access_token: jwt({ sub: 'user-1', org: 'org-9', exp: Math.floor(T0.getTime() / 1000) + 900 }),
        refresh_token: next,
        scope: 'mcp:read',
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  return { impl, calls, issued, live };
}

describe('the lifetime the operator chooses', () => {
  it('defaults to thirty days when nobody says', () => {
    expect(lifetimeDays(undefined)).toBe(30);
  });

  it('takes what was asked for, inside the range', () => {
    expect(lifetimeDays(7)).toBe(7);
    expect(lifetimeDays(45)).toBe(45);
    expect(lifetimeDays(60)).toBe(60);
  });

  it('clamps rather than refusing, since a slider can slip', () => {
    expect(lifetimeDays(1)).toBe(MIN_LIFETIME_DAYS);
    expect(lifetimeDays(365)).toBe(MAX_LIFETIME_DAYS);
    expect(lifetimeDays(-5)).toBe(MIN_LIFETIME_DAYS);
  });

  it('ignores a number that is not one', () => {
    expect(lifetimeDays(Number.NaN)).toBe(30);
    expect(lifetimeDays(Number.POSITIVE_INFINITY)).toBe(30);
  });
});

describe('a connection, kept alive', () => {
  let db: Database;
  let close: () => Promise<void>;
  let now = T0;

  beforeAll(() => {
    ({ db, close } = createDb(URL_));
  });
  afterAll(async () => {
    await close();
  });
  beforeEach(async () => {
    now = T0;
    await db.delete(keeperhubConnections);
    await db.delete(oauthAuthRequests);
    await db.delete(oauthClients);
  });

  const make = (
    impl: typeof fetch,
    onNeedsReauth?: (orgId: string, reason: string) => void,
  ): Connections =>
    new Connections({
      db,
      oauth: new KeeperHubOAuth({
        db,
        baseUrl: 'https://blackbox.test',
        issuer: 'https://provider.test',
        fetchImpl: impl,
      }),
      key: KEY,
      now: () => now,
      ...(onNeedsReauth ? { onNeedsReauth } : {}),
    });

  it('stores the credential encrypted, not in the clear', async () => {
    const connections = make(rotatingProvider().impl);
    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-1', scope: 'mcp:read' });

    const row = await getKeeperhubConnection(db, 'org-9');
    expect(row?.refreshTokenEnc).not.toContain('refresh-1');
    expect(decrypt(row?.refreshTokenEnc ?? '', KEY)).toBe('refresh-1');
  });

  it('stamps our own expiry from the chosen lifetime', async () => {
    const connections = make(rotatingProvider().impl);
    const { expiresAt } = await connections.connect({
      orgId: 'org-9',
      refreshToken: 'refresh-1',
      scope: 'mcp:read',
      days: 7,
    });
    expect(expiresAt.getTime()).toBe(T0.getTime() + 7 * day);
  });

  it('gets an access token by spending the refresh token', async () => {
    const provider = rotatingProvider();
    const connections = make(provider.impl);
    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-1', scope: 'mcp:read' });

    const result = await connections.accessTokenFor('org-9');
    expect(result.ok).toBe(true);
    expect(provider.calls.filter((c) => c.grant === 'refresh_token')).toHaveLength(1);
  });

  /** The reason all of this exists: the token we just sent is already dead. */
  it('survives rotation, twice', async () => {
    const provider = rotatingProvider();
    const connections = make(provider.impl);
    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-1', scope: 'mcp:read' });

    expect((await connections.accessTokenFor('org-9')).ok).toBe(true);
    const stored = await getKeeperhubConnection(db, 'org-9');
    expect(decrypt(stored?.refreshTokenEnc ?? '', KEY)).toBe('refresh-2');

    // Past the cached token's life, so this genuinely refreshes again.
    now = new Date(T0.getTime() + 3600_000);
    expect((await connections.accessTokenFor('org-9')).ok).toBe(true);

    const after = await getKeeperhubConnection(db, 'org-9');
    expect(decrypt(after?.refreshTokenEnc ?? '', KEY)).toBe('refresh-3');
    expect(provider.calls.filter((c) => c.grant === 'refresh_token').map((c) => c.token)).toEqual([
      'refresh-1',
      'refresh-2',
    ]);
  });

  it('reuses the access token it already has rather than rotating again', async () => {
    const provider = rotatingProvider();
    const connections = make(provider.impl);
    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-1', scope: 'mcp:read' });

    await connections.accessTokenFor('org-9');
    await connections.accessTokenFor('org-9');
    expect(provider.calls.filter((c) => c.grant === 'refresh_token')).toHaveLength(1);
  });

  it('refreshes again once the access token is close to expiring', async () => {
    const provider = rotatingProvider();
    const connections = make(provider.impl);
    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-1', scope: 'mcp:read' });

    await connections.accessTokenFor('org-9');
    now = new Date(T0.getTime() + 890_000); // inside the skew of a 900s token
    await connections.accessTokenFor('org-9');
    expect(provider.calls.filter((c) => c.grant === 'refresh_token')).toHaveLength(2);
  });

  /**
   * Two sweeps starting together must not each spend the rotating token: the
   * second would present one KeeperHub had already deleted, killing a
   * connection that was perfectly healthy a moment earlier.
   */
  it('lets only one refresh run at a time per organisation', async () => {
    const provider = rotatingProvider();
    const connections = make(provider.impl);
    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-1', scope: 'mcp:read' });

    const results = await Promise.all([
      connections.accessTokenFor('org-9'),
      connections.accessTokenFor('org-9'),
      connections.accessTokenFor('org-9'),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(provider.calls.filter((c) => c.grant === 'refresh_token')).toHaveLength(1);
  });

  it('does not serve a token for an organisation nobody connected', async () => {
    const connections = make(rotatingProvider().impl);
    const result = await connections.accessTokenFor('org-nobody');
    expect(result).toMatchObject({ ok: false, reason: 'not_connected' });
  });

  it('stops after a disconnect', async () => {
    const connections = make(rotatingProvider().impl);
    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-1', scope: 'mcp:read' });
    await connections.accessTokenFor('org-9');
    await connections.disconnect('org-9');

    expect(await connections.accessTokenFor('org-9')).toMatchObject({
      ok: false,
      reason: 'not_connected',
    });
  });
});

describe('when a connection dies', () => {
  let db: Database;
  let close: () => Promise<void>;
  let now = T0;

  beforeAll(() => {
    ({ db, close } = createDb(URL_));
  });
  afterAll(async () => {
    await close();
  });
  beforeEach(async () => {
    now = T0;
    await db.delete(keeperhubConnections);
    await db.delete(oauthClients);
  });

  const make = (
    impl: typeof fetch,
    told: (orgId: string, reason: string) => void = () => {},
  ): Connections =>
    new Connections({
      db,
      oauth: new KeeperHubOAuth({
        db,
        baseUrl: 'https://blackbox.test',
        issuer: 'https://provider.test',
        fetchImpl: impl,
      }),
      key: KEY,
      now: () => now,
      onNeedsReauth: told,
    });

  it('asks for re-authorisation on a dead grant, and does not ask again', async () => {
    const provider = rotatingProvider({ start: 'someone-elses-token' });
    const told: string[] = [];
    const connections = make(provider.impl, (orgId) => told.push(orgId));
    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-stale', scope: 'mcp:read' });

    expect(await connections.accessTokenFor('org-9')).toMatchObject({
      ok: false,
      reason: 'needs_reauth',
    });
    expect((await getKeeperhubConnection(db, 'org-9'))?.status).toBe('needs_reauth');
    expect(told).toEqual(['org-9']);

    // A second call must not spend another request on a grant that is dead.
    const before = provider.calls.length;
    await connections.accessTokenFor('org-9');
    expect(provider.calls.length).toBe(before);
  });

  it('treats a network fault as transient, keeping the connection alive', async () => {
    const flaky = rotatingProvider({ failWith: { status: 503, body: { error: 'unavailable' } } });
    const connections = make(flaky.impl);
    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-1', scope: 'mcp:read' });

    expect(await connections.accessTokenFor('org-9')).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    const row = await getKeeperhubConnection(db, 'org-9');
    expect(row?.status).toBe('active');
    expect(row?.failureCount).toBe(1);
  });

  it('stops at our own expiry even though their clock would keep rolling', async () => {
    const provider = rotatingProvider();
    const told: [string, string][] = [];
    const connections = make(provider.impl, (orgId, reason) => told.push([orgId, reason]));
    await connections.connect({
      orgId: 'org-9',
      refreshToken: 'refresh-1',
      scope: 'mcp:read',
      days: 7,
    });

    now = new Date(T0.getTime() + 8 * day);
    expect(await connections.accessTokenFor('org-9')).toMatchObject({
      ok: false,
      reason: 'needs_reauth',
    });
    expect(provider.calls.filter((c) => c.grant === 'refresh_token')).toHaveLength(0);
    expect(told).toEqual([['org-9', 'lifetime_reached']]);
  });

  it('expires the due connections in a sweep, and names them', async () => {
    const connections = make(rotatingProvider().impl);
    await connections.connect({ orgId: 'org-short', refreshToken: 'r', scope: 'mcp:read', days: 7 });
    await connections.connect({ orgId: 'org-long', refreshToken: 'r', scope: 'mcp:read', days: 60 });

    now = new Date(T0.getTime() + 8 * day);
    expect(await connections.expireDue()).toEqual(['org-short']);
    expect((await getKeeperhubConnection(db, 'org-long'))?.status).toBe('active');
  });

  it('asks for re-authorisation when the key no longer reads what it wrote', async () => {
    const connections = make(rotatingProvider().impl);
    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-1', scope: 'mcp:read' });

    const wrongKey = new Connections({
      db,
      oauth: new KeeperHubOAuth({
        db,
        baseUrl: 'https://blackbox.test',
        issuer: 'https://provider.test',
        fetchImpl: rotatingProvider().impl,
      }),
      key: keyFrom('d'.repeat(64)),
      now: () => now,
    });

    expect(await wrongKey.accessTokenFor('org-9')).toMatchObject({
      ok: false,
      reason: 'needs_reauth',
    });
  });

  it('reconnecting brings a dead connection back', async () => {
    const provider = rotatingProvider();
    const connections = make(provider.impl);
    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-stale', scope: 'mcp:read' });
    await connections.accessTokenFor('org-9');
    expect((await getKeeperhubConnection(db, 'org-9'))?.status).toBe('needs_reauth');

    await connections.connect({ orgId: 'org-9', refreshToken: 'refresh-1', scope: 'mcp:read' });
    const row = await getKeeperhubConnection(db, 'org-9');
    expect(row?.status).toBe('active');
    expect(row?.failureCount).toBe(0);
    expect((await connections.accessTokenFor('org-9')).ok).toBe(true);
  });
});
