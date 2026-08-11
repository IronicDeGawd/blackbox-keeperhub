import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * Encryption for the one thing Blackbox keeps that belongs to somebody else.
 *
 * Everything else at rest is a hash — a session token, an organisation key, a
 * webhook secret — because a hash is enough to *check* a value and useless to
 * anyone who steals the database. A refresh token is different: it has to be
 * replayed to KeeperHub to get a new access token, so it must come back out
 * intact, and hashing is not an option.
 *
 * So it is encrypted rather than hashed, with a key that lives in the
 * environment and not in the database. Losing the database alone yields
 * ciphertext; losing both is the same as losing the key, which is why the key
 * belongs somewhere the database backups are not.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than decrypting to something else.
 */

const ALGORITHM = 'aes-256-gcm';

export class MissingEncryptionKey extends Error {
  constructor() {
    super(
      'BLACKBOX_ENCRYPTION_KEY is not set, so a KeeperHub connection cannot be stored. ' +
        'Set a 32-byte key (64 hex characters, or any passphrase) before connecting an account.',
    );
    this.name = 'MissingEncryptionKey';
  }
}

/**
 * Accepts 64 hex characters directly, or derives 32 bytes from any passphrase.
 *
 * The derivation is a plain SHA-256 rather than a slow KDF on purpose: this is
 * a machine-generated deployment secret, not a human password, so there is no
 * guessing attack for a slow hash to frustrate — and it must be cheap because
 * it runs on every read.
 */
export function keyFrom(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === '') throw new MissingEncryptionKey();
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  return createHash('sha256').update(trimmed).digest();
}

/** `v1.<iv>.<authTag>.<ciphertext>`, all base64url. Versioned so it can change. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enciphered = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    enciphered.toString('base64url'),
  ].join('.');
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, iv, tag, body] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !body) {
    throw new Error('Unrecognised ciphertext; it was not written by this version.');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
