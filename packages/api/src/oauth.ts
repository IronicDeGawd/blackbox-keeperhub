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

export type CompleteResult =
  | { ok: true; orgId: string; subject: string; returnTo: string | null }
  | { ok: false; reason: 'unknown_state' | 'exchange_failed' | 'no_org' };

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

  /** Begin a sign-in: returns the URL to send the operator to. */
  async start(returnTo?: string): Promise<{ url: string; state: string }> {
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
   * The token itself is not kept. Identity is all that was asked for, and a
   * stored token is a credential to lose.
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

    const body = (await res.json()) as { access_token?: string };
    const claims = body.access_token ? readJwtClaims(body.access_token) : null;
    const orgId = typeof claims?.['org'] === 'string' ? claims['org'] : null;
    const subject = typeof claims?.['sub'] === 'string' ? claims['sub'] : '';
    if (!orgId) return { ok: false, reason: 'no_org' };

    return { ok: true, orgId, subject, returnTo: request.returnTo };
  }
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
