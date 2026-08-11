import { createHash, randomBytes } from 'node:crypto';
import {
  agentsOwnedByOrg,
  claimAgentForOrg,
  remapOrganisation,
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
   * Still how a key is *verified* — an invalid one cannot read this — and the
   * fallback identity when nothing better is available.
   */
  listKeys(orgKey: string): Promise<{ id: string }[]>;
  /**
   * KeeperHub's own organisation id, if it can be read.
   *
   * `/api/organizations` refuses an organisation key and `/api/keys` names no
   * organisation, but a workflow record carries `organizationId` — and it is
   * the same value an OAuth access token puts in its `org` claim, checked
   * against both live. That matters because it is the difference between one
   * operator being one tenant and being two: signing in with a key and
   * connecting through OAuth used to produce different ids for the same
   * organisation, so an agent claimed through one door was invisible from the
   * other.
   *
   * Optional, and null when the organisation has no workflows yet or their
   * side cannot be reached. The caller falls back to the derived id rather
   * than failing.
   */
  organizationId?(orgKey: string): Promise<string | null>;
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

    async organizationId(orgKey) {
      try {
        const res = await fetchImpl(`${baseUrl}/workflows`, {
          headers: { Authorization: `Bearer ${orgKey}` },
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { organizationId?: unknown }[] | { items?: unknown };
        const rows = Array.isArray(body) ? body : [];
        for (const row of rows) {
          const id = (row as { organizationId?: unknown }).organizationId;
          if (typeof id === 'string' && id.length > 0) return id;
        }
        return null;
      } catch {
        return null;
      }
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
    /** Told when an organisation's things were moved to its real id. */
    private readonly onRemap?: (
      from: string,
      to: string,
      moved: { agents: number; sessions: number; connections: number; workflows: number },
    ) => void,
  ) {}

  /**
   * Which organisation a key belongs to, without minting a session.
   *
   * The deployment needs this for its own key: an agent nobody has claimed
   * cannot be acted on, and its own demo agents are exactly that until it
   * claims them for itself.
   */
  async orgIdForKey(orgKey: string): Promise<string | null> {
    try {
      return (await this.resolve(orgKey)).orgId;
    } catch {
      return null;
    }
  }

  /**
   * The organisation a key belongs to, preferring KeeperHub's own id.
   *
   * The key list is still what proves the key is real. The organisation id
   * comes from a workflow record when there is one, because that is the same
   * value OAuth puts in its `org` claim — so both ways of signing in land on
   * one tenant. An organisation with no workflows falls back to the derived
   * id, and is moved across the first time a workflow exists.
   */
  private async resolve(orgKey: string): Promise<{ orgId: string | null; derived: string | null }> {
    const keys = await this.verifier.listKeys(orgKey);
    const derived = orgIdFrom(keys);
    const real = (await this.verifier.organizationId?.(orgKey)) ?? null;
    return { orgId: real ?? derived, derived };
  }

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
    const derived = orgIdFrom(keys);
    const real = (await this.verifier.organizationId?.(orgKey)) ?? null;
    const orgId = real ?? derived;
    // A valid key that can see no keys at all cannot be pinned to an
    // organisation, and guessing one would put an operator's agents in a tenant
    // that might not be theirs.
    if (!orgId) return { ok: false, reason: 'no_keys' };

    /**
     * Everything filed under the old derived id moves across, once.
     *
     * Sign-in is where it happens because that is the moment both ids are
     * known for certain, and it is idempotent: the second sign-in finds
     * nothing left to move.
     */
    if (real && derived && real !== derived) {
      const moved = await remapOrganisation(this.db, { from: derived, to: real });
      if (moved.agents + moved.sessions + moved.connections + moved.workflows > 0) {
        this.onRemap?.(derived, real, moved);
      }
    }

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

  /**
   * Start a session for an operator who signed in through OAuth.
   *
   * No credential of theirs is involved, so there is none to hash: the
   * `keyHash` column instead holds a marker derived from the organisation and
   * the user, which keeps the column meaningful — one row per person per org —
   * without pretending a secret was stored.
   */
  async signInWithOrg(params: {
    orgId: string;
    subject?: string;
    label?: string;
  }): Promise<{ token: string; orgId: string }> {
    const token = `bb_${randomBytes(32).toString('hex')}`;
    await createOrgSession(this.db, {
      tokenHash: sha256(token),
      orgId: params.orgId,
      keyHash: `oauth:${sha256(`${params.orgId}:${params.subject ?? ''}`)}`,
      label: params.label ?? 'keeperhub-oauth',
      at: this.now(),
    });
    return { token, orgId: params.orgId };
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
 * May this caller take this agent, or add to it?
 *
 * An unowned agent is claimable — otherwise no agent could ever come into
 * existence. Registration requires a session, so in practice the first caller
 * to name an agent also becomes its owner, and there is no window in which one
 * exists with nobody responsible for it.
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

/**
 * May this caller *spend* on this agent?
 *
 * A different question from `mayAct`, and it used to share the same answer.
 * Remediation sends a real transaction: through KeeperHub it consumes the
 * organisation's execution quota, its gas credits and its daily spending cap;
 * from a held key it spends that key's balance. None of that is something an
 * unidentified caller should be able to trigger against somebody else's agent.
 *
 * So **unowned means nobody**, not everybody. Reading stays open to all —
 * incidents, the ledger, the diagnosis — because reading costs nothing and
 * showing the work is the point. Acting needs an account.
 */
export async function mayRemediate(
  db: Database,
  agentId: string,
  caller: Caller | null,
): Promise<boolean> {
  if (!caller) return false;
  return (await ownerOf(db, agentId)) === caller.orgId;
}
