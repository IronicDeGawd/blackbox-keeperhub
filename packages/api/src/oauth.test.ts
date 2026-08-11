import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  oauthAuthRequests,
  oauthClients,
  takeAuthRequest,
  type Database,
} from '@blackbox/store';
import { KeeperHubOAuth, readJwtClaims } from './oauth.js';

const URL_ = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';

const metadata = {
  issuer: 'https://provider.test',
  authorization_endpoint: 'https://provider.test/oauth/authorize',
  token_endpoint: 'https://provider.test/api/oauth/token',
  registration_endpoint: 'https://provider.test/api/oauth/register',
};

/** A JWT is three dot-separated parts; only the middle one is read here. */
const jwt = (claims: Record<string, unknown>): string =>
  ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

type Call = { url: string; body?: string };

const provider = (over: { token?: unknown; tokenStatus?: number } = {}) => {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return new Response(JSON.stringify(metadata), { status: 200 });
    }
    if (url === metadata.registration_endpoint) {
      return new Response(JSON.stringify({ client_id: 'client-1' }), { status: 201 });
    }
    if (url === metadata.token_endpoint) {
      return new Response(
        JSON.stringify(
          over.token ?? { access_token: jwt({ sub: 'user-1', org: 'org-9', scope: 'mcp:read' }) },
        ),
        { status: over.tokenStatus ?? 200 },
      );
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, impl };
};

describe('connect with KeeperHub', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    ({ db, close } = createDb(URL_));
  });
  afterAll(async () => {
    await close();
  });
  beforeEach(async () => {
    await db.delete(oauthAuthRequests);
    await db.delete(oauthClients);
  });

  const make = (impl: typeof fetch): KeeperHubOAuth =>
    new KeeperHubOAuth({
      db,
      baseUrl: 'https://blackbox.test',
      issuer: 'https://provider.test',
      fetchImpl: impl,
    });

  it('registers itself once and reuses the client id', async () => {
    const { calls, impl } = provider();
    await make(impl).start();
    await make(impl).start();
    const registrations = calls.filter((c) => c.url === metadata.registration_endpoint);
    expect(registrations).toHaveLength(1);
  });

  it('sends the operator to the provider with PKCE, and keeps the verifier here', async () => {
    const { impl } = provider();
    const { url, state } = await make(impl).start('/incidents');
    const params = new URL(url).searchParams;

    expect(url.startsWith(metadata.authorization_endpoint)).toBe(true);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('response_type')).toBe('code');
    // Reading is all identity needs, so reading is all that is requested.
    expect(params.get('scope')).toBe('mcp:read');
    expect(params.get('redirect_uri')).toBe('https://blackbox.test/api/auth/keeperhub/callback');
    // The verifier is what makes an intercepted code useless; it must not be
    // anywhere in the URL the browser follows.
    const [stored] = await db.select().from(oauthAuthRequests);
    expect(stored?.codeVerifier).toBeTruthy();
    expect(url).not.toContain(stored!.codeVerifier);
    expect(params.get('code_challenge')).not.toBe(stored!.codeVerifier);
    expect(stored?.state).toBe(state);
  });

  it('exchanges the code and reads the organisation from the token', async () => {
    const { calls, impl } = provider();
    const oauth = make(impl);
    const { state } = await oauth.start('/incidents');
    const result = await oauth.complete({ state, code: 'auth-code' });

    expect(result).toMatchObject({ ok: true, orgId: 'org-9', returnTo: '/incidents' });
    const exchange = calls.find((c) => c.url === metadata.token_endpoint);
    expect(exchange?.body).toContain('grant_type=authorization_code');
    expect(exchange?.body).toContain('code_verifier=');
  });

  /** A replayed callback must find nothing — the state is consumed on use. */
  it('refuses a sign-in that was already completed', async () => {
    const { impl } = provider();
    const oauth = make(impl);
    const { state } = await oauth.start();
    expect((await oauth.complete({ state, code: 'c' })).ok).toBe(true);
    expect(await oauth.complete({ state, code: 'c' })).toEqual({
      ok: false,
      reason: 'unknown_state',
    });
  });

  it('refuses a state it never issued', async () => {
    const { impl } = provider();
    expect(await make(impl).complete({ state: 'invented', code: 'c' })).toEqual({
      ok: false,
      reason: 'unknown_state',
    });
  });

  it('treats an expired sign-in as absent, and consumes it either way', async () => {
    const { impl } = provider();
    const oauth = make(impl);
    const { state } = await oauth.start();
    await db.update(oauthAuthRequests).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await takeAuthRequest(db, state, new Date())).toBeNull();
    expect(await db.select().from(oauthAuthRequests)).toHaveLength(0);
  });

  it('reports a refused exchange rather than inventing a session', async () => {
    const { impl } = provider({ tokenStatus: 400 });
    const oauth = make(impl);
    const { state } = await oauth.start();
    expect(await oauth.complete({ state, code: 'c' })).toEqual({
      ok: false,
      reason: 'exchange_failed',
    });
  });

  // A token with no organisation cannot be filed under one, and guessing would
  // put an operator's agents in somebody else's tenant.
  it('refuses a token that names no organisation', async () => {
    const { impl } = provider({ token: { access_token: jwt({ sub: 'user-1' }) } });
    const oauth = make(impl);
    const { state } = await oauth.start();
    expect(await oauth.complete({ state, code: 'c' })).toEqual({ ok: false, reason: 'no_org' });
  });

  it('re-registers when the deployment URL changes, rather than failing later', async () => {
    const { calls, impl } = provider();
    await make(impl).start();
    const moved = new KeeperHubOAuth({
      db,
      baseUrl: 'https://blackbox-two.test',
      issuer: 'https://provider.test',
      fetchImpl: impl,
    });
    await moved.start();
    expect(calls.filter((c) => c.url === metadata.registration_endpoint)).toHaveLength(2);
  });

  it('returns nothing for a malformed token instead of throwing', () => {
    expect(readJwtClaims('not-a-jwt')).toBeNull();
    expect(readJwtClaims('a.!!!.c')).toBeNull();
  });

  it('hands back the refresh token and the scope actually granted', async () => {
    const { impl } = provider({
      token: {
        access_token: jwt({ sub: 'user-1', org: 'org-9' }),
        refresh_token: 'refresh-1',
        scope: 'mcp:read',
      },
    });
    const oauth = make(impl);
    const { state } = await oauth.start();
    expect(await oauth.complete({ state, code: 'c' })).toMatchObject({
      ok: true,
      refreshToken: 'refresh-1',
      scope: 'mcp:read',
    });
  });

  /** Signing in is not connecting: no refresh token means nothing to store. */
  it('says plainly when no refresh token came back', async () => {
    const { impl } = provider();
    const oauth = make(impl);
    const { state } = await oauth.start();
    expect(await oauth.complete({ state, code: 'c' })).toMatchObject({
      ok: true,
      refreshToken: null,
    });
  });

  it('falls back to the scope inside the token when the reply omits it', async () => {
    const { impl } = provider({
      token: { access_token: jwt({ sub: 'u', org: 'org-9', scope: 'mcp:read' }) },
    });
    const oauth = make(impl);
    const { state } = await oauth.start();
    expect(await oauth.complete({ state, code: 'c' })).toMatchObject({ scope: 'mcp:read' });
  });
});

describe('trading a refresh token', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    ({ db, close } = createDb(URL_));
  });
  afterAll(async () => {
    await close();
  });
  beforeEach(async () => {
    await db.delete(oauthClients);
  });

  const make = (impl: typeof fetch): KeeperHubOAuth =>
    new KeeperHubOAuth({
      db,
      baseUrl: 'https://blackbox.test',
      issuer: 'https://provider.test',
      fetchImpl: impl,
    });

  it('sends the refresh grant and returns the new pair', async () => {
    const { calls, impl } = provider({
      token: { access_token: jwt({ org: 'org-9' }), refresh_token: 'refresh-2', scope: 'mcp:read' },
    });
    const result = await make(impl).refresh('refresh-1');

    expect(result).toMatchObject({ ok: true, refreshToken: 'refresh-2', scope: 'mcp:read' });
    const exchange = calls.find((c) => c.url === metadata.token_endpoint);
    expect(exchange?.body).toContain('grant_type=refresh_token');
    expect(exchange?.body).toContain('refresh_token=refresh-1');
  });

  /**
   * The distinction that matters: a dead grant must not be retried, and a
   * transient fault must not cost somebody their connection.
   */
  it('separates a dead grant from a provider having a bad day', async () => {
    const dead = provider({
      tokenStatus: 400,
      token: { error: 'invalid_grant', error_description: 'Refresh token not found' },
    });
    expect(await make(dead.impl).refresh('stale')).toMatchObject({
      ok: false,
      reason: 'invalid_grant',
      detail: 'Refresh token not found',
    });

    const down = provider({ tokenStatus: 503, token: { error: 'unavailable' } });
    expect(await make(down.impl).refresh('refresh-1')).toMatchObject({
      ok: false,
      reason: 'exchange_failed',
    });
  });

  it('treats a 401 as a dead grant, since that is what it means here', async () => {
    const { impl } = provider({ tokenStatus: 401, token: {} });
    expect(await make(impl).refresh('stale')).toMatchObject({ reason: 'invalid_grant' });
  });

  it('refuses a 200 that carries no access token', async () => {
    const { impl } = provider({ token: { refresh_token: 'refresh-2' } });
    expect(await make(impl).refresh('refresh-1')).toMatchObject({ ok: false });
  });

  it('does not choke on a reply that is not JSON', async () => {
    const impl = (async (url: string) => {
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify(metadata), { status: 200 });
      }
      if (url === metadata.registration_endpoint) {
        return new Response(JSON.stringify({ client_id: 'client-1' }), { status: 201 });
      }
      return new Response('<html>gateway timeout</html>', { status: 504 });
    }) as unknown as typeof fetch;

    expect(await make(impl).refresh('refresh-1')).toMatchObject({
      ok: false,
      reason: 'exchange_failed',
      detail: 'HTTP 504',
    });
  });
});
