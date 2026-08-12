/**
 * Where an organisation stands against its daily execution budget.
 *
 * R8 already detects an exhausted cap, which means Blackbox reads this number
 * and only ever mentions it once it has become a problem. Showing it
 * continuously turns a late alarm into something an operator can watch coming.
 *
 * The arithmetic is here rather than in the route because wei does not fit in
 * a double and a ratio computed the obvious way would be wrong long before it
 * mattered.
 */

export type SpendPosition = {
  capWei: string | null;
  usedWei: string;
  /** 0–1, or null when there is no cap to be a fraction of. */
  ratio: number | null;
  /**
   * True when the organisation has no daily limit at all. Not the same as a
   * cap of zero, and an alert about reaching a limit that does not exist would
   * be nonsense.
   */
  uncapped: boolean;
};

const toBigInt = (value: string | null): bigint | null => {
  if (value === null || value.trim() === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

export function spendPosition(limits: {
  dailyCapWei: string | null;
  dailyUsedWei: string | null;
}): SpendPosition {
  const cap = toBigInt(limits.dailyCapWei);
  const used = toBigInt(limits.dailyUsedWei) ?? 0n;

  if (cap === null || cap === 0n) {
    return {
      capWei: cap === null ? null : '0',
      usedWei: used.toString(),
      // A cap of zero is a real cap that is already full; no cap is neither.
      ratio: cap === 0n ? 1 : null,
      uncapped: cap === null,
    };
  }

  /**
   * Divided in fixed point rather than by converting to a double: a wei cap is
   * routinely larger than 2^53, and Number(cap) would start rounding before
   * the ratio ever got interesting.
   */
  const permille = (used * 1000n) / cap;
  const ratio = Number(permille) / 1000;

  return {
    capWei: cap.toString(),
    usedWei: used.toString(),
    // Spending past the cap is possible in the record; the bar stops at full.
    ratio: Math.min(1, ratio),
    uncapped: false,
  };
}
