import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { challengeMessage, WalletAuth } from './wallet-auth.js';

// A throwaway key, used only to produce real signatures in these tests.
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const auth = (over: { now?: () => Date; ttlMs?: number; maxOutstanding?: number } = {}) =>
  new WalletAuth({ domain: 'blackbox.test', ...over });

describe('proving ownership with a key', () => {
  it('accepts a signature over the challenge it issued', async () => {
    const a = auth();
    const { message, nonce } = a.issue(account.address);
    const signature = await account.signMessage({ message });

    expect(await a.verify({ nonce, signature })).toEqual({
      ok: true,
      address: account.address.toLowerCase(),
    });
  });

  /** The message a wallet shows should be readable and specific. */
  it('names the deployment and says what signing does not do', () => {
    const message = challengeMessage('blackbox.test', {
      address: account.address.toLowerCase() as `0x${string}`,
      nonce: 'abc',
      issuedAt: new Date('2026-08-11T12:00:00.000Z'),
      expiresAt: new Date('2026-08-11T12:05:00.000Z'),
    });
    expect(message).toContain('blackbox.test');
    expect(message).toContain('authorises no transaction');
    expect(message).toContain('Nonce: abc');
  });

  // A signature for one deployment must be useless at another.
  it('rejects a signature made for a different deployment', async () => {
    const theirs = new WalletAuth({ domain: 'somewhere-else.test' });
    const mine = auth();
    const issued = mine.issue(account.address);
    const theirIssued = theirs.issue(account.address);
    const signature = await account.signMessage({ message: theirIssued.message });

    expect(await mine.verify({ nonce: issued.nonce, signature })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('consumes the nonce, so a captured signature cannot be replayed', async () => {
    const a = auth();
    const { message, nonce } = a.issue(account.address);
    const signature = await account.signMessage({ message });

    expect((await a.verify({ nonce, signature })).ok).toBe(true);
    expect(await a.verify({ nonce, signature })).toEqual({ ok: false, reason: 'unknown_nonce' });
  });

  it('rejects an expired challenge', async () => {
    let now = new Date('2026-08-11T12:00:00.000Z');
    const a = auth({ now: () => now, ttlMs: 60_000 });
    const { message, nonce } = a.issue(account.address);
    const signature = await account.signMessage({ message });

    now = new Date('2026-08-11T12:01:01.000Z');
    expect(await a.verify({ nonce, signature })).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a signature from a different key', async () => {
    const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const a = auth();
    const { message, nonce } = a.issue(account.address);
    const signature = await other.signMessage({ message });

    expect(await a.verify({ nonce, signature })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses when the caller names an address other than the one challenged', async () => {
    const a = auth();
    const { message, nonce } = a.issue(account.address);
    const signature = await account.signMessage({ message });

    expect(
      await a.verify({ nonce, signature, address: '0x0000000000000000000000000000000000000001' }),
    ).toEqual({ ok: false, reason: 'wrong_address' });
  });

  it('treats a malformed signature as a failed proof rather than an error', async () => {
    const a = auth();
    const { nonce } = a.issue(account.address);
    expect(await a.verify({ nonce, signature: '0xnotasignature' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  /**
   * An unauthenticated route that stores something per call needs a ceiling,
   * and dropping the oldest beats refusing — otherwise one caller hoarding
   * nonces locks everybody else out.
   */
  it('bounds outstanding challenges, dropping the oldest', () => {
    const a = auth({ maxOutstanding: 3 });
    for (let i = 0; i < 10; i++) a.issue(account.address);
    expect(a.outstanding).toBeLessThanOrEqual(3);
  });

  it('forgets expired challenges without being asked twice', () => {
    let now = new Date('2026-08-11T12:00:00.000Z');
    const a = auth({ now: () => now, ttlMs: 1_000 });
    a.issue(account.address);
    a.issue(account.address);
    expect(a.outstanding).toBe(2);
    now = new Date('2026-08-11T12:00:05.000Z');
    a.issue(account.address);
    expect(a.outstanding).toBe(1);
  });
});
