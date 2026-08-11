import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';

/**
 * Ownership proved by signature, for an agent that holds its own key.
 *
 * The organisation-key and OAuth paths answer "which KeeperHub organisation is
 * this?", which is the right question for an agent running there and the wrong
 * one for an agent that never touches KeeperHub at all. Such an agent has no
 * organisation and no account — but it does have a key, and using it is the
 * most direct proof of ownership there is.
 *
 * Both models coexist deliberately: they answer the same question about
 * different kinds of agent.
 */

export type Challenge = {
  address: `0x${string}`;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
};

export type WalletAuthOptions = {
  /** Named in the message so a signature for one deployment is useless at another. */
  domain: string;
  ttlMs?: number;
  now?: () => Date;
  /** Bounded, so an unauthenticated route cannot fill memory with challenges. */
  maxOutstanding?: number;
};

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX = 500;

/**
 * The exact text the wallet will sign.
 *
 * Readable on a hardware wallet screen, and specific: it names the deployment,
 * the address, and a nonce. Someone tricked into signing it can at least see
 * what it says, and it cannot be replayed anywhere else.
 */
export function challengeMessage(domain: string, challenge: Challenge): string {
  return [
    `${domain} wants you to prove you control this address:`,
    challenge.address,
    '',
    'Signing this proves ownership of the agent. It authorises no transaction',
    'and moves no funds.',
    '',
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt.toISOString()}`,
    `Expires At: ${challenge.expiresAt.toISOString()}`,
  ].join('\n');
}

export type VerifyResult =
  | { ok: true; address: `0x${string}` }
  | { ok: false; reason: 'unknown_nonce' | 'expired' | 'bad_signature' | 'wrong_address' };

export class WalletAuth {
  private readonly challenges = new Map<string, Challenge>();
  private readonly now: () => Date;

  constructor(private readonly options: WalletAuthOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Issue a challenge for an address to sign. */
  issue(address: `0x${string}`): { message: string; nonce: string; expiresAt: Date } {
    this.sweep();
    // Oldest out rather than refusing: a full table would otherwise let one
    // caller lock everybody else out by hoarding nonces.
    if (this.challenges.size >= (this.options.maxOutstanding ?? DEFAULT_MAX)) {
      const oldest = this.challenges.keys().next().value;
      if (oldest) this.challenges.delete(oldest);
    }

    const issuedAt = this.now();
    const challenge: Challenge = {
      address: address.toLowerCase() as `0x${string}`,
      nonce: randomBytes(16).toString('hex'),
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + (this.options.ttlMs ?? DEFAULT_TTL_MS)),
    };
    this.challenges.set(challenge.nonce, challenge);
    return {
      message: challengeMessage(this.options.domain, challenge),
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    };
  }

  /**
   * Check a signature against the challenge it claims to answer.
   *
   * The nonce is consumed whatever the outcome, so a signature cannot be tried
   * twice and a captured one cannot be replayed. The address is recovered from
   * the signature rather than taken from the request: a caller saying whose
   * signature it is proves nothing.
   */
  async verify(params: {
    nonce: string;
    signature: `0x${string}`;
    address?: string;
  }): Promise<VerifyResult> {
    const challenge = this.challenges.get(params.nonce);
    // Consumed on sight. A replay finds nothing, and a wrong guess costs the
    // attacker the nonce it guessed.
    this.challenges.delete(params.nonce);
    if (!challenge) return { ok: false, reason: 'unknown_nonce' };
    if (challenge.expiresAt.getTime() < this.now().getTime()) {
      return { ok: false, reason: 'expired' };
    }
    if (
      params.address &&
      params.address.toLowerCase() !== challenge.address.toLowerCase()
    ) {
      return { ok: false, reason: 'wrong_address' };
    }

    const message = challengeMessage(this.options.domain, challenge);
    try {
      const valid = await verifyMessage({
        address: challenge.address,
        message,
        signature: params.signature,
      });
      if (!valid) return { ok: false, reason: 'bad_signature' };
    } catch {
      // A malformed signature is a failed proof, not an error to propagate.
      return { ok: false, reason: 'bad_signature' };
    }
    return { ok: true, address: challenge.address };
  }

  private sweep(): void {
    const now = this.now().getTime();
    for (const [nonce, challenge] of this.challenges) {
      if (challenge.expiresAt.getTime() < now) this.challenges.delete(nonce);
    }
  }

  get outstanding(): number {
    return this.challenges.size;
  }
}
