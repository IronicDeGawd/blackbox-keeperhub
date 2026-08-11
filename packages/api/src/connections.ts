import {
  disconnectKeeperhub,
  expireDueConnections,
  getKeeperhubConnection,
  markConnectionNeedsReauth,
  recordConnectionFailure,
  recordConnectionRefresh,
  saveKeeperhubConnection,
  type Database,
  type KeeperhubConnection,
} from '@blackbox/store';
import { decrypt, encrypt } from './secrets.js';
import { readJwtClaims, type KeeperHubOAuth } from './oauth.js';

/**
 * A connected KeeperHub account, kept alive.
 *
 * The credential Blackbox holds is a refresh token scoped to reading, and their
 * refresh tokens rotate: every use kills the one we sent. So the order of
 * operations here is the whole design. Write the new token, then use the access
 * token it came with. Do it the other way round and a crash in between leaves a
 * connection whose only credential is one KeeperHub has already deleted.
 *
 * Two clocks can end a connection, and only one is ours. Theirs is a rolling
 * 30-day idle timeout that every refresh resets, so a connection we keep using
 * never expires on their side. Ours is an absolute date the operator chose at
 * connect time, which is the only thing that bounds how long we hold somebody
 * else's credential.
 */

export const MIN_LIFETIME_DAYS = 7;
export const MAX_LIFETIME_DAYS = 60;
export const DEFAULT_LIFETIME_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Refresh a little early, so a token does not expire mid-request. */
const EXPIRY_SKEW_MS = 60_000;

/** Out-of-range choices are clamped rather than refused; a slider can slip. */
export function lifetimeDays(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_LIFETIME_DAYS;
  return Math.min(MAX_LIFETIME_DAYS, Math.max(MIN_LIFETIME_DAYS, Math.round(requested)));
}

export type ConnectionsOptions = {
  db: Database;
  oauth: KeeperHubOAuth;
  /** From `BLACKBOX_ENCRYPTION_KEY`; see `secrets.ts` for why it is not a hash. */
  key: Buffer;
  now?: () => Date;
  /** Told when a connection dies, so somebody can be asked to reconnect. */
  onNeedsReauth?: (orgId: string, reason: string) => void;
};

export type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'not_connected' | 'needs_reauth' | 'unavailable'; detail: string };

export class Connections {
  private readonly now: () => Date;
  /** Access tokens are short-lived, so they live in memory and never on disk. */
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  /** One refresh in flight per organisation: two would race to rotate. */
  private readonly inFlight = new Map<string, Promise<TokenResult>>();

  constructor(private readonly options: ConnectionsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Store a newly authorised account.
   *
   * Reconnecting overwrites the credential and restarts both clocks. It leaves
   * the watched workflows alone, so somebody re-authorising is not asked to
   * choose all over again.
   */
  async connect(params: {
    orgId: string;
    refreshToken: string;
    scope: string;
    subject?: string | null;
    days?: number;
  }): Promise<{ expiresAt: Date }> {
    const at = this.now();
    const expiresAt = new Date(at.getTime() + lifetimeDays(params.days) * DAY_MS);
    await saveKeeperhubConnection(this.options.db, {
      orgId: params.orgId,
      refreshTokenEnc: encrypt(params.refreshToken, this.options.key),
      scope: params.scope,
      subject: params.subject ?? null,
      at,
      expiresAt,
    });
    this.cache.delete(params.orgId);
    return { expiresAt };
  }

  async get(orgId: string): Promise<KeeperhubConnection | null> {
    return getKeeperhubConnection(this.options.db, orgId);
  }

  /** Forget the credential. KeeperHub exposes no way to invalidate it there. */
  async disconnect(orgId: string): Promise<void> {
    this.cache.delete(orgId);
    await disconnectKeeperhub(this.options.db, orgId);
  }

  /** Our own clock running out. Returns who was expired, so they can be told. */
  async expireDue(): Promise<string[]> {
    const expired = await expireDueConnections(this.options.db, this.now());
    for (const orgId of expired) {
      this.cache.delete(orgId);
      this.options.onNeedsReauth?.(orgId, 'lifetime_reached');
    }
    return expired;
  }

  /**
   * An access token for this organisation, refreshing if there is not one.
   *
   * Concurrent callers share a single refresh rather than each spending the
   * rotating token — the second would present a credential the first had
   * already killed, and take the connection down with it.
   */
  async accessTokenFor(orgId: string): Promise<TokenResult> {
    const cached = this.cache.get(orgId);
    if (cached && cached.expiresAt > this.now().getTime() + EXPIRY_SKEW_MS) {
      return { ok: true, accessToken: cached.token };
    }

    const existing = this.inFlight.get(orgId);
    if (existing) return existing;

    const attempt = this.refresh(orgId).finally(() => this.inFlight.delete(orgId));
    this.inFlight.set(orgId, attempt);
    return attempt;
  }

  private async refresh(orgId: string): Promise<TokenResult> {
    const connection = await getKeeperhubConnection(this.options.db, orgId);
    if (!connection || connection.status === 'disconnected') {
      return { ok: false, reason: 'not_connected', detail: 'No KeeperHub account is connected.' };
    }
    if (connection.status === 'needs_reauth') {
      return {
        ok: false,
        reason: 'needs_reauth',
        detail: connection.lastError ?? 'The connection needs to be authorised again.',
      };
    }
    if (connection.expiresAt.getTime() <= this.now().getTime()) {
      await this.markDead(orgId, 'lifetime_reached');
      return {
        ok: false,
        reason: 'needs_reauth',
        detail: 'The connection reached the lifetime chosen when it was created.',
      };
    }

    let refreshToken: string;
    try {
      refreshToken = decrypt(connection.refreshTokenEnc, this.options.key);
    } catch {
      // A key that no longer decrypts what it wrote is not a transient fault.
      await this.markDead(orgId, 'unreadable_credential');
      return {
        ok: false,
        reason: 'needs_reauth',
        detail: 'The stored credential could not be read with the configured key.',
      };
    }

    const result = await this.options.oauth.refresh(refreshToken);
    if (!result.ok) {
      if (result.reason === 'invalid_grant') {
        await this.markDead(orgId, result.detail);
        return { ok: false, reason: 'needs_reauth', detail: result.detail };
      }
      // Transient: counted, but the connection stays live and is tried again.
      await recordConnectionFailure(this.options.db, orgId, result.detail);
      return { ok: false, reason: 'unavailable', detail: result.detail };
    }

    // Their side has already deleted the token we sent, so this write is what
    // keeps the connection alive. It happens before the access token is used.
    if (result.refreshToken) {
      await recordConnectionRefresh(this.options.db, {
        orgId,
        refreshTokenEnc: encrypt(result.refreshToken, this.options.key),
        at: this.now(),
      });
    } else {
      await recordConnectionRefresh(this.options.db, {
        orgId,
        refreshTokenEnc: connection.refreshTokenEnc,
        at: this.now(),
      });
    }

    this.cache.set(orgId, {
      token: result.accessToken,
      expiresAt: expiryOf(result.accessToken, this.now()),
    });
    return { ok: true, accessToken: result.accessToken };
  }

  private async markDead(orgId: string, reason: string): Promise<void> {
    this.cache.delete(orgId);
    await markConnectionNeedsReauth(this.options.db, orgId, reason);
    this.options.onNeedsReauth?.(orgId, reason);
  }
}

/**
 * When the access token stops working, from its own `exp` claim.
 *
 * Unreadable or absent, it is treated as good for five minutes: short enough
 * that a wrong guess costs one extra refresh, rather than a run of failed calls
 * with a token we believed in.
 */
function expiryOf(accessToken: string, now: Date): number {
  const exp = readJwtClaims(accessToken)?.['exp'];
  if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000;
  return now.getTime() + 5 * 60_000;
}
