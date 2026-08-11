import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createWebhookSecret,
  revokeWebhookSecret,
  useWebhookSecret,
  type Database,
} from '@blackbox/store';

/**
 * Inbound webhooks — how something outside asks Blackbox to look now rather
 * than at the next tick.
 *
 * KeeperHub has no outbound webhook of its own. Its action types are contract
 * calls, transfers, Discord, SendGrid, AI text and `code/run-code`, so a
 * workflow that notifies us does it from a code node writing an HTTP request by
 * hand. Whoever configures that node controls the body entirely.
 *
 * Which is why the body is not read at all. The webhook is a *nudge*: it
 * authenticates the caller and then Blackbox reads the runs from KeeperHub
 * itself. Nothing a caller sends can become an event, so a stolen secret buys
 * an attacker nothing except making us poll.
 */

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export type Sweeper = {
  sweepKeeperHub(): Promise<{ runsIngested: number; eventsInserted: number } | null>;
};

export class Webhooks {
  constructor(
    private readonly db: Database,
    private readonly sweeper: Sweeper,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Mint a secret for an organisation. Returned once, stored as a hash. */
  async mint(orgId: string, label?: string): Promise<string> {
    const secret = `whsec_${randomBytes(32).toString('hex')}`;
    await createWebhookSecret(this.db, {
      secretHash: sha256(secret),
      orgId,
      ...(label !== undefined ? { label } : {}),
      at: this.now(),
    });
    return secret;
  }

  /**
   * Resolve a presented secret to its organisation.
   *
   * The hash comparison is constant-time. A database lookup on the hash is
   * already not a timing oracle for the secret itself, but the explicit compare
   * keeps that property true if this ever moves to a list scan.
   */
  async verify(secret: string): Promise<{ orgId: string } | null> {
    if (!secret.startsWith('whsec_')) return null;
    const hash = sha256(secret);
    const found = await useWebhookSecret(this.db, hash, this.now());
    if (!found) return null;
    const a = Buffer.from(hash);
    const b = Buffer.from(sha256(secret));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return found;
  }

  async revoke(secret: string): Promise<void> {
    await revokeWebhookSecret(this.db, sha256(secret), this.now());
  }

  /** What a nudge actually causes: the same sweep the loop does, sooner. */
  async sweep(): Promise<{ runsIngested: number; eventsInserted: number } | null> {
    return this.sweeper.sweepKeeperHub();
  }
}

/**
 * The code a `code/run-code` node needs, so an operator does not have to write
 * it.
 *
 * Returned by the API rather than kept in documentation that drifts: it names
 * this deployment's own URL, which the operator would otherwise have to know.
 */
export function codeNodeSnippet(baseUrl: string): string {
  return [
    '// Blackbox: tell it to read this run now rather than at its next poll.',
    '// The body is ignored by design — Blackbox reads the run from KeeperHub',
    '// itself, so nothing here can fabricate an incident.',
    `await fetch(${JSON.stringify(`${baseUrl.replace(/\/$/, '')}/api/webhooks/keeperhub`)}, {`,
    "  method: 'POST',",
    "  headers: { Authorization: 'Bearer ' + process.env.BLACKBOX_WEBHOOK_SECRET },",
    '});',
  ].join('\n');
}
