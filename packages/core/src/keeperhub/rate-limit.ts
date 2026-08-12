/**
 * How long a rate limiter wants us to wait.
 *
 * Blackbox sweeps somebody else's organisation on a tick, so it is a guest on
 * their quota. When the limiter says when to come back, saying it twice as
 * fast is not persistence — it is the thing that gets the credential throttled
 * for everybody.
 *
 * Three headers, in the order they should be trusted:
 *
 * - `Retry-After`, which is the answer to this exact question and is either
 *   delta-seconds or an HTTP-date;
 * - `X-RateLimit-Reset`, which is when the window rolls over — epoch seconds
 *   in most implementations, but small values are plainly seconds-from-now
 *   rather than a moment in 1970, so both readings are accepted;
 * - nothing at all, which is what KeeperHub's own step-up limiter does, and
 *   for which the caller picks its own delay.
 */

/** Beyond this, waiting is worse than failing and letting the next tick try. */
export const MAX_RETRY_WAIT_MS = 30_000;

/**
 * A `X-RateLimit-Reset` below this is read as seconds-from-now rather than as
 * an epoch. An epoch that small is 1970, which no limiter means.
 */
const EPOCH_THRESHOLD_SECONDS = 1_000_000_000;

type HeaderBag = { get(name: string): string | null };

/**
 * Milliseconds to wait before retrying, or null when the response says
 * nothing about it. Never negative: a window that has already rolled over
 * means retry now, not travel backwards.
 */
export function retryAfterMs(headers: HeaderBag, now: number = Date.now()): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }

  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null && reset.trim() !== '') {
    const value = Number(reset);
    if (Number.isFinite(value) && value > 0) {
      return value >= EPOCH_THRESHOLD_SECONDS
        ? Math.max(0, value * 1000 - now)
        : Math.round(value * 1000);
    }
  }

  return null;
}

/**
 * What is left of the quota, when the response says.
 *
 * Not used to decide anything yet — it is logged, so that a sweep which starts
 * getting throttled can be explained rather than guessed at.
 */
export function rateLimitRemaining(headers: HeaderBag): number | null {
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining === null || remaining.trim() === '') return null;
  const value = Number(remaining);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
