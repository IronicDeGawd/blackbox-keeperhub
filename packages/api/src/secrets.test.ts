import { describe, expect, it } from 'vitest';
import { MissingEncryptionKey, decrypt, encrypt, keyFrom } from './secrets.js';

const KEY = keyFrom('a'.repeat(64));

describe('the key', () => {
  it('takes 64 hex characters as the key itself', () => {
    expect(keyFrom('a'.repeat(64))).toEqual(Buffer.from('a'.repeat(64), 'hex'));
  });

  it('derives 32 bytes from anything else, so a passphrase also works', () => {
    expect(keyFrom('not hex, just a long deployment secret')).toHaveLength(32);
  });

  it('derives the same key twice, or nothing would ever decrypt', () => {
    expect(keyFrom('deployment secret')).toEqual(keyFrom('deployment secret'));
  });

  /**
   * Fail closed. A missing key must stop a connection being stored, not fall
   * back to storing the token in the clear or to some fixed default.
   */
  it('refuses to invent a key when none is configured', () => {
    expect(() => keyFrom(undefined)).toThrow(MissingEncryptionKey);
    expect(() => keyFrom('')).toThrow(MissingEncryptionKey);
    expect(() => keyFrom('   ')).toThrow(MissingEncryptionKey);
  });

  it('says what to do about it', () => {
    expect(() => keyFrom(undefined)).toThrow(/BLACKBOX_ENCRYPTION_KEY/);
  });
});

describe('a stored refresh token', () => {
  it('comes back exactly as it went in', () => {
    const token = 'kh_refresh_9f3a.aBcD-_1234';
    expect(decrypt(encrypt(token, KEY), KEY)).toBe(token);
  });

  it('does not appear in its own ciphertext', () => {
    expect(encrypt('kh_refresh_secret', KEY)).not.toContain('kh_refresh_secret');
  });

  it('encrypts differently every time, so equal tokens do not look equal', () => {
    expect(encrypt('same', KEY)).not.toBe(encrypt('same', KEY));
  });

  it('is versioned, so the scheme can change without stranding old rows', () => {
    expect(encrypt('x', KEY).startsWith('v1.')).toBe(true);
  });

  it('survives the characters a real token contains', () => {
    const token = 'a'.repeat(512) + '.+/=_-~';
    expect(decrypt(encrypt(token, KEY), KEY)).toBe(token);
  });
});

describe('when the ciphertext cannot be trusted', () => {
  it('refuses a wrong key rather than returning rubbish', () => {
    const other = keyFrom('b'.repeat(64));
    expect(() => decrypt(encrypt('token', KEY), other)).toThrow();
  });

  /**
   * The point of GCM over plain CBC: a tampered body fails to decrypt instead
   * of decrypting to something an attacker chose.
   */
  it('refuses a tampered body', () => {
    const [v, iv, tag, body] = encrypt('token', KEY).split('.');
    const flipped = (body?.startsWith('A') ? 'B' : 'A') + (body as string).slice(1);
    expect(() => decrypt([v, iv, tag, flipped].join('.'), KEY)).toThrow();
  });

  /**
   * Tampered at the *front*, not the end: the final base64url character of a
   * 16-byte tag carries spare bits that the decoder discards, so changing it
   * decodes to the same bytes and proves nothing.
   */
  it('refuses a tampered auth tag', () => {
    const [v, iv, tag, body] = encrypt('token', KEY).split('.');
    const flipped = (tag?.startsWith('A') ? 'B' : 'A') + (tag as string).slice(1);
    expect(() => decrypt([v, iv, flipped, body].join('.'), KEY)).toThrow();
  });

  it('refuses a payload from a scheme it does not know', () => {
    expect(() => decrypt('v2.a.b.c', KEY)).toThrow(/not written by this version/);
  });

  it('refuses a truncated payload', () => {
    expect(() => decrypt('v1.onlyonepart', KEY)).toThrow(/not written by this version/);
    expect(() => decrypt('', KEY)).toThrow(/not written by this version/);
  });
});
