import { describe, expect, it } from 'vitest';
import {
  EM_DASH,
  absoluteTime,
  formatConfidence,
  formatDuration,
  formatEth,
  formatFactValue,
  formatGwei,
  formatMean,
  formatWei,
  relativeTime,
  toBigInt,
  truncateAddress,
  truncateHash,
} from './format';

describe('wei', () => {
  it('keeps every digit of a value a float would round away', () => {
    // 1.000000000000000001 ETH. As a Number this is exactly 1.
    expect(formatEth('1000000000000000001', 18)).toBe('1.000000000000000001 ETH');
    expect(Number('1000000000000000001')).toBe(1000000000000000000);
  });

  it('formats a real signer balance', () => {
    expect(formatEth('61318595487686304')).toBe('0.061318 ETH');
  });

  it('trims the fraction away entirely when it is zero', () => {
    expect(formatEth('2000000000000000000')).toBe('2 ETH');
  });

  it('formats gwei', () => {
    expect(formatGwei('2000000000')).toBe('2 gwei');
    expect(formatGwei('4191302983')).toBe('4.191 gwei');
  });

  it('picks a unit by magnitude and always states it', () => {
    expect(formatWei('0')).toBe('0 ETH');
    expect(formatWei('21000')).toBe('21000 wei');
    expect(formatWei('4191302983')).toBe('4.191 gwei');
    expect(formatWei('63813361787234000')).toBe('0.063813 ETH');
  });

  it('reports nonsense as unknown rather than as zero', () => {
    expect(formatWei('not a number')).toBe(EM_DASH);
    expect(formatWei(null)).toBe(EM_DASH);
    expect(formatWei(undefined)).toBe(EM_DASH);
    expect(toBigInt('1.5')).toBeNull();
  });

  it('accepts the bigint and integer forms as well as the wire string', () => {
    expect(toBigInt(42n)).toBe(42n);
    expect(toBigInt(42)).toBe(42n);
    expect(toBigInt('')).toBeNull();
  });
});

describe('durations', () => {
  it('never renders a duration in raw milliseconds', () => {
    expect(formatDuration(41_000)).toBe('41s');
    expect(formatDuration(63_000)).toBe('1m 03s');
    expect(formatDuration(252_000)).toBe('4m 12s');
  });

  it('keeps milliseconds only below a second, where seconds would read as zero', () => {
    expect(formatDuration(412)).toBe('412ms');
  });

  it('steps up to hours and days', () => {
    expect(formatDuration(3_900_000)).toBe('1h 05m');
    expect(formatDuration(273_600_000)).toBe('3d 04h');
  });

  it('distinguishes no data from instant', () => {
    expect(formatMean(null)).toBe(EM_DASH);
    expect(formatMean(undefined)).toBe(EM_DASH);
    expect(formatMean(0)).toBe('0ms');
    expect(formatMean(59_000)).toBe('59s');
  });
});

describe('relative time', () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z');

  it('reads as an operator would say it', () => {
    expect(relativeTime('2026-08-10T11:58:00.000Z', now)).toBe('2m ago');
    expect(relativeTime('2026-08-10T11:59:15.000Z', now)).toBe('45s ago');
    expect(relativeTime('2026-08-10T09:00:00.000Z', now)).toBe('3h ago');
    expect(relativeTime('2026-08-07T12:00:00.000Z', now)).toBe('3d ago');
  });

  it('collapses the last few seconds', () => {
    expect(relativeTime('2026-08-10T11:59:57.000Z', now)).toBe('just now');
  });

  it('keeps the exact value available for a title attribute', () => {
    expect(absoluteTime('2026-08-10T06:29:26.557Z')).toBe('2026-08-10 06:29:26 UTC');
  });

  it('does not invent a time from an unparseable one', () => {
    expect(relativeTime('nonsense')).toBe(EM_DASH);
  });
});

describe('addresses', () => {
  const signer = '0xb9c58185d09D0aCf3b237cD45C67345E32e628BA';

  it('truncates for display in the form the spec shows', () => {
    expect(truncateAddress(signer)).toBe('0xb9c5…28BA');
  });

  it('leaves a value too short to truncate alone', () => {
    expect(truncateAddress('0x1234')).toBe('0x1234');
  });

  it('shows more of a transaction hash, since more of it is distinguishing', () => {
    expect(truncateHash('0x68a38ff18521775f812e27e5dd678d7ba6659b2ae3e086325c85a9d1fd88d925')).toBe(
      '0x68a38ff1…88d925',
    );
  });
});

describe('fact values', () => {
  it('renders the shapes the rules actually emit', () => {
    expect(formatFactValue([47])).toBe('[47]');
    expect(formatFactValue([])).toBe('[]');
    expect(formatFactValue(true)).toBe('true');
    expect(formatFactValue('0.90')).toBe('0.90');
    expect(formatFactValue(0)).toBe('0');
  });

  it('distinguishes a missing fact from a false one', () => {
    expect(formatFactValue(undefined)).toBe(EM_DASH);
    expect(formatFactValue(null)).toBe(EM_DASH);
    expect(formatFactValue(false)).toBe('false');
  });

  it('states confidence to two decimals, as the evidence does', () => {
    expect(formatConfidence(0.9)).toBe('0.90');
  });
});
