import { createHash, randomBytes } from 'node:crypto';
import {
  agentsOwnedByOrg,
  claimAgentForOrg,
  createOrgSession,
  findOrgSession,
  ownerOfAgent,
  revokeOrgSession,
  touchOrgSession,
  type Database,
} from '@blackbox/store';

/**
 * Who is calling, and what they may act on.
 *
 * An operator proves themselves with their KeeperHub organisation key. That is
 * a bearer credential for someone else's account, so it is verified once and
 * then thrown away: what persists is a hash of a session token we minted, and a
 * hash of the key used only so the same key resolves to the same session
 * instead of minting a new one every sign-in. Losing this database must not
 * hand anyone control of a KeeperHub organisation.
 */

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export type Caller = { orgId: string; tokenHash: string };

export type KeyVerifier = {
  /**
   * Answer the organisation's own key list, which requires a valid key.
   *
   * KeeperHub names no organisation anywhere in its API — `/api/organizations`
   * answers 401, `/api/organization` and `/api/me` do not exist — so identity
   * is derived from this list instead: every key belonging to one organisation
   * sees the same set, and the lowest id in it is therefore stable across keys.
   */
  listKeys(orgKey: string): Promise<{ id: string }[]>;
};

/** Verifier backed by the live API. */
export function httpKeyVerifier(
  baseUrl = 'https://app.keeperhub.com/api',
  fetchImpl: typeof fetch = fetch,
): KeyVerifier {
  return {
    async listKeys(orgKey) {
      const res = await fetchImpl(`${baseUrl}/keys`, {
        headers: { Authorization: `Bearer ${orgKey}` },
      });
      if (!res.ok) throw new Error(`key rejected (${res.status})`);
      const body = (await res.json()) as { items?: { id?: unknown }[] };
      return (body.items ?? [])
        .map((i) => ({ id: String(i.id ?? '') }))
        .filter((i) => i.id.length > 0);
    },
  };
}

/**
 * The lowest key id an organisation can see.
 *
 * Stable while that key exists, and identical for every key in the same
 * organisation — which is what makes two of an operator's keys one tenant
 * rather than two. If the oldest key is deleted the identity changes, and the
 * operator signs in again; that is a known limitation of deriving an identity
 * their API declines to state.
 */
export function orgIdFrom(keys: { id: string }[]): string | null {
  const ids = keys.map((k) => k.id).sort();
  return ids[0] ?? null;
}

export type SignInResult =
  | { ok: true; token: string; orgId: string }
  | { ok: false; reason: 'rejected' | 'no_keys' };

export class Identity {
  constructor(
    private readonly db: Database,
    private readonly verifier: KeyVerifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Exchange an organisation key for a session token.
   *
   * The key is used for exactly one request and never written anywhere. The
   * token that comes back is the only thing the caller should keep, and only
   * its hash is stored, so a leaked database yields neither.
   */
  async signIn(orgKey: string, label?: string): Promise<SignInResult> {
    let keys: { id: string }[];
    try {
      keys = await this.verifier.listKeys(orgKey);
    } catch {
      return { ok: false, reason: 'rejected' };
    }
    const orgId = orgIdFrom(keys);
    // A valid key that can see no keys at all cannot be pinned to an
    // organisation, and guessing one would put an operator's agents in a tenant
    // that might not be theirs.
    if (!orgId) return { ok: false, reason: 'no_keys' };

    const token = `bb_${randomBytes(32).toString('hex')}`;
    await createOrgSession(this.db, {
      tokenHash: sha256(token),
      orgId,
      // Hashed here, so the key never crosses into the storage layer at all.
      keyHash: sha256(orgKey),
      ...(label !== undefined ? { label } : {}),
      at: this.now(),
    });
    return { ok: true, token, orgId };
  }

  /** Resolve a bearer token to a caller, or nothing. Touches `lastSeenAt`. */
  async caller(token: string | undefined): Promise<Caller | null> {
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = await findOrgSession(this.db, tokenHash);
    if (!session) return null;
    await touchOrgSession(this.db, tokenHash, this.now());
    return { orgId: session.orgId, tokenHash };
  }

  /** Revocation is one call, by design. */
  async revoke(token: string): Promise<void> {
    await revokeOrgSession(this.db, sha256(token), this.now());
  }
}

export type ClaimResult = 'claimed' | 'already_yours' | 'owned_by_another';

/**
 * Claim an agent for an organisation. First registration wins.
 *
 * This is not a claim over the address — anyone may watch a public address, and
 * pretending otherwise would be theatre. It is a claim over *acting*: who may
 * remediate it, relabel it, or spend a budget on it.
 */
export async function claimAgent(
  db: Database,
  params: { agentId: string; orgId: string; now?: Date },
): Promise<ClaimResult> {
  return claimAgentForOrg(db, {
    agentId: params.agentId,
    orgId: params.orgId,
    at: params.now ?? new Date(),
  });
}

export async function agentsOwnedBy(db: Database, orgId: string): Promise<string[]> {
  return agentsOwnedByOrg(db, orgId);
}

export async function ownerOf(db: Database, agentId: string): Promise<string | null> {
  return ownerOfAgent(db, agentId);
}

/**
 * May this caller act on this agent?
 *
 * An unclaimed agent is actionable by anyone, which is what keeps the public
 * demo working and lets a first-time operator use the thing before signing in.
 * A claimed agent is actionable only by its owner.
 */
export async function mayAct(
  db: Database,
  agentId: string,
  caller: Caller | null,
): Promise<boolean> {
  const owner = await ownerOf(db, agentId);
  if (!owner) return true;
  return caller?.orgId === owner;
}
