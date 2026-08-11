import { createHash, randomBytes } from 'node:crypto';
import {
  getOAuthClient,
  saveAuthRequest,
  saveOAuthClient,
  takeAuthRequest,
  type Database,
} from '@blackbox/store';

/**
 * "Connect KeeperHub" — the sign-in a person actually uses.
 *
 * The alternative Blackbox already supports is pasting an organisation key,
 * which is fine for a script and wrong for a human: that key can execute
 * transactions, and asking someone to hand it to a third-party website is
 * asking them to trust us more than they should have to. Here the operator
 * authenticates on KeeperHub's own page and we never see a credential of
 * theirs at all — only a token they consented to issue, scoped to reading.
 *
 * Authorization code with PKCE, and a public client: there is no client secret
 * to leak because the flow does not use one. The verifier stays on this server,
 * so a code intercepted in the browser is worthless.
 */

const DEFAULT_ISSUER = 'https://app.keeperhub.com';
/** Reading is all identity needs. Asking for more would be asking for more. */
const DEFAULT_SCOPE = 'mcp:read';
const REQUEST_TTL_MS = 10 * 60_000;

const base64url = (buffer: Buffer): string =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export type ProviderMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
};

export type OAuthOptions = {
  db: Database;
  /** Public base URL of this deployment; the callback is derived from it. */
  baseUrl: string;
  issuer?: string;
  scope?: string;
  /** Skips dynamic registration when a client id is already known. */
  clientId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/**
 * What the provider handed back, beyond identity.
 *
 * `refreshToken` is present only when the operator asked to connect their
 * account rather than merely sign in. It is returned rather than stored here so
 * that the caller decides — this module knows about OAuth, not about what
 * Blackbox chooses to keep.
 */
export type Grant = {
  refreshToken: string | null;
  /** What was actually granted, which may be less than was asked for. */
  scope: string;
};

export type CompleteResult =
  | ({
      ok: true;
      orgId: string;
      subject: string;
      returnTo: string | null;
      /** Non-null when the operator asked to connect, with their chosen days. */
      connectDays: number | null;
    } & Grant)
  | { ok: false; reason: 'unknown_state' | 'exchange_failed' | 'no_org' };

export type RefreshResult =
  | { ok: true; accessToken: string; refreshToken: string | null; scope: string }
  /** `invalid_grant`: the token is dead and asking again will not revive it. */
  | { ok: false; reason: 'invalid_grant' | 'exchange_failed'; detail: string };

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

export class KeeperHubOAuth {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private metadata: ProviderMetadata | undefined;

  constructor(private readonly options: OAuthOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  get issuer(): string {
    return this.options.issuer ?? DEFAULT_ISSUER;
  }

  get redirectUri(): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/api/auth/keeperhub/callback`;
  }

  /**
   * Endpoints come from the provider's own discovery document rather than being
   * hardcoded, so a change on their side is followed rather than broken.
   */
  async discover(): Promise<ProviderMetadata> {
    if (this.metadata) return this.metadata;
    const res = await this.fetchImpl(`${this.issuer}/.well-known/oauth-authorization-server`);
    if (!res.ok) throw new Error(`OAuth discovery failed (${res.status})`);
    const body = (await res.json()) as ProviderMetadata;
    if (!body.authorization_endpoint || !body.token_endpoint) {
      throw new Error('OAuth discovery document is missing its endpoints');
    }
    this.metadata = body;
    return body;
  }

  /**
   * Our client id, registered once and reused.
   *
   * Re-registering per restart would leave a trail of clients on their side and
   * show the operator a different application each time they consent.
   */
  async clientId(): Promise<string> {
    if (this.options.clientId) return this.options.clientId;

    const stored = await getOAuthClient(this.options.db, this.issuer);
    // A changed public URL invalidates the registration: the provider will
    // refuse a redirect it never saw, and silently reusing the old id would
    // fail at the least debuggable moment.
    if (stored && stored.redirectUri === this.redirectUri) return stored.clientId;

    const metadata = await this.discover();
    if (!metadata.registration_endpoint) {
      throw new Error('This provider does not support dynamic registration; set a client id');
    }
    const res = await this.fetchImpl(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Blackbox',
        redirect_uris: [this.redirectUri],
        // No secret to store, and none to leak.
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: this.options.scope ?? DEFAULT_SCOPE,
      }),
    });
    if (!res.ok) throw new Error(`OAuth registration failed (${res.status})`);
    const body = (await res.json()) as { client_id?: string };
    if (!body.client_id) throw new Error('OAuth registration returned no client id');

    await saveOAuthClient(this.options.db, {
      issuer: this.issuer,
      clientId: body.client_id,
      redirectUri: this.redirectUri,
      at: this.now(),
    });
    return body.client_id;
  }

  /**
   * Begin a sign-in: returns the URL to send the operator to.
   *
   * `connectDays` marks this as a request to *connect* the account rather than
   * only sign in, and carries the lifetime the operator chose. It is remembered
   * on this server rather than round-tripped through the browser, so nobody can
   * turn a sign-in into a connection by editing a link.
   */
  async start(returnTo?: string, connectDays?: number): Promise<{ url: string; state: string }> {
    const metadata = await this.discover();
    const clientId = await this.clientId();

    const state = base64url(randomBytes(24));
    const codeVerifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(codeVerifier).digest());

    const at = this.now();
    await saveAuthRequest(this.options.db, {
      state,
      // Never sent to the browser; this is what makes an intercepted code useless.
      codeVerifier,
      redirectUri: this.redirectUri,
      ...(returnTo ? { returnTo } : {}),
      ...(connectDays === undefined ? {} : { connectDays }),
      at,
      expiresAt: new Date(at.getTime() + REQUEST_TTL_MS),
    });

    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', this.options.scope ?? DEFAULT_SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state };
  }

  /**
   * Finish a sign-in: exchange the code and read who it belongs to.
   *
   * The access token is a JWT carrying the organisation, and it is read rather
   * than verified — we cannot check a signature made with their secret. That is
   * sound only because of where it came from: this process asked their token
   * endpoint directly over TLS and read the reply. A token handed to us by
   * anyone else would have to be treated as a claim rather than a fact, which
   * is exactly why one is never accepted from a caller.
   *
   * The access token is not kept — it is short-lived and identity is all a
   * sign-in asked for. The refresh token is returned to the caller, which keeps
   * it only when the operator asked to connect their account so that Blackbox
   * can go on reading their runs.
   */
  async complete(params: { state: string; code: string }): Promise<CompleteResult> {
    const request = await takeAuthRequest(this.options.db, params.state, this.now());
    if (!request) return { ok: false, reason: 'unknown_state' };

    const metadata = await this.discover();
    const clientId = await this.clientId();

    const res = await this.fetchImpl(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: request.redirectUri,
        client_id: clientId,
        code_verifier: request.codeVerifier,
      }).toString(),
    });
    if (!res.ok) return { ok: false, reason: 'exchange_failed' };

    const body = (await res.json()) as TokenResponse;
    const claims = body.access_token ? readJwtClaims(body.access_token) : null;
    const orgId = typeof claims?.['org'] === 'string' ? claims['org'] : null;
    const subject = typeof claims?.['sub'] === 'string' ? claims['sub'] : '';
    if (!orgId) return { ok: false, reason: 'no_org' };

    return {
      ok: true,
      orgId,
      subject,
      returnTo: request.returnTo,
      connectDays: request.connectDays,
      refreshToken: body.refresh_token ?? null,
      scope: body.scope ?? claimedScope(claims) ?? this.options.scope ?? DEFAULT_SCOPE,
    };
  }

  /**
   * Trade a refresh token for a fresh access token.
   *
   * KeeperHub rotates: the token sent here is deleted on their side and a new
   * one issued, so the reply is not optional to persist — losing it loses the
   * connection. The caller writes the new token before using the access token,
   * which is why this returns rather than stores.
   *
   * `invalid_grant` is separated from every other failure because the two
   * deserve opposite treatment. A network error is worth retrying; a dead grant
   * is not, and retrying it only delays telling the operator to reconnect.
   */
  async refresh(refreshToken: string): Promise<RefreshResult> {
    const metadata = await this.discover();
    const clientId = await this.clientId();

    const res = await this.fetchImpl(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });

    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !body.access_token) {
      const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
      // Their 401 on an unknown token means the same thing as invalid_grant.
      const dead = body.error === 'invalid_grant' || res.status === 400 || res.status === 401;
      return { ok: false, reason: dead ? 'invalid_grant' : 'exchange_failed', detail };
    }

    return {
      ok: true,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      scope: body.scope ?? claimedScope(readJwtClaims(body.access_token)) ?? '',
    };
  }
}

/** Some providers state the scope only inside the token. Read it if so. */
function claimedScope(claims: Record<string, unknown> | null): string | null {
  const scope = claims?.['scope'];
  if (typeof scope === 'string') return scope;
  if (Array.isArray(scope)) return scope.filter((s) => typeof s === 'string').join(' ');
  return null;
}

/**
 * Read a JWT payload without verifying it.
 *
 * Named to be honest about what it does. Safe only for a token this process
 * fetched itself from the issuer; never for one a caller supplied.
 */
export function readJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
