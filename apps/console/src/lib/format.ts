/**
 * Display formatting.
 *
 * Every wei value the API sends is a decimal string larger than
 * Number.MAX_SAFE_INTEGER can hold, so all of it goes through BigInt and none
 * of it through parseInt or Number. The division below is integer division on
 * purpose — a float would round the last digits off a balance.
 */

const ETH_DECIMALS = 18;
const GWEI_DECIMALS = 9;

export const EM_DASH = '—';

/** Parse a wire wei value, returning null rather than throwing on nonsense. */
export function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Integer-only fixed-point rendering. `dp` caps the fraction; zeros are trimmed. */
function formatUnits(value: bigint, decimals: number, dp: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const fraction = magnitude % base;

  const fractionText = fraction
    .toString()
    .padStart(decimals, '0')
    .slice(0, dp)
    .replace(/0+$/, '');

  const sign = negative ? '-' : '';
  return fractionText ? `${sign}${whole}.${fractionText}` : `${sign}${whole}`;
}

export function formatEth(value: unknown, dp = 6): string {
  const wei = toBigInt(value);
  if (wei === null) return EM_DASH;
  return `${formatUnits(wei, ETH_DECIMALS, dp)} ETH`;
}

export function formatGwei(value: unknown, dp = 3): string {
  const wei = toBigInt(value);
  if (wei === null) return EM_DASH;
  return `${formatUnits(wei, GWEI_DECIMALS, dp)} gwei`;
}

/**
 * Pick the unit a human would use for this magnitude. A raw wei integer is
 * never shown without a unit attached, whichever branch is taken.
 */
export function formatWei(value: unknown): string {
  const wei = toBigInt(value);
  if (wei === null) return EM_DASH;

  const magnitude = wei < 0n ? -wei : wei;
  if (magnitude === 0n) return '0 ETH';
  // 0.001 ETH and up reads naturally in ETH; below that the digits vanish.
  if (magnitude >= 10n ** 15n) return formatEth(wei);
  if (magnitude >= 10n ** 6n) return formatGwei(wei);
  return `${wei} wei`;
}

/**
 * Durations read as `41s` or `1m 03s`, never as `41000ms`. Genuinely
 * sub-second values keep milliseconds, because `0s` would be a lie.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return EM_DASH;

  const negative = ms < 0;
  const total = Math.abs(ms);
  const sign = negative ? '-' : '';

  if (total < 1000) return `${sign}${Math.round(total)}ms`;

  const seconds = Math.floor(total / 1000);
  if (seconds < 60) return `${sign}${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${sign}${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${sign}${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  }

  return `${sign}${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, '0')}h`;
}

/**
 * A mean of null means nothing qualified, which is not the same as zero —
 * "0ms to detection" would read as instant detection.
 */
export function formatMean(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? EM_DASH : formatDuration(ms);
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return EM_DASH;

  const delta = now - then;
  const ahead = delta < 0;
  const total = Math.abs(delta);

  const say = (text: string): string => (ahead ? `in ${text}` : `${text} ago`);

  if (total < 10_000) return ahead ? 'shortly' : 'just now';

  const seconds = Math.floor(total / 1000);
  if (seconds < 60) return say(`${seconds}s`);

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return say(`${minutes}m`);

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return say(`${hours}h`);

  return say(`${Math.floor(hours / 24)}d`);
}

/** The exact value, for the title attribute behind every relative time. */
export function absoluteTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`;
}

/**
 * `0xb9c58185d09D0aCf3b237cD45C67345E32e628BA` becomes `0xb9c5…28BA`.
 * Display only — every caller keeps the full value for copying.
 */
export function truncateAddress(value: string, lead = 6, tail = 4): string {
  if (!value) return EM_DASH;
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function truncateHash(value: string): string {
  return truncateAddress(value, 10, 6);
}

/** Confidence is a 0–1 ratio; two decimals is how the evidence states it. */
export function formatConfidence(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : EM_DASH;
}

/**
 * A fact value straight out of `evidence.facts`, where the type varies by key
 * and by class. Arrays are the common case for `missingNonces`.
 */
export function formatFactValue(value: unknown): string {
  if (value === null || value === undefined) return EM_DASH;
  if (Array.isArray(value)) return value.length ? `[${value.join(', ')}]` : '[]';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
