import { describe, expect, it } from 'vitest';
import { spendPosition } from './spend.js';

describe('standing against a daily budget', () => {
  it('reports the fraction spent', () => {
    expect(spendPosition({ dailyCapWei: '100', dailyUsedWei: '25' })).toEqual({
      capWei: '100',
      usedWei: '25',
      ratio: 0.25,
      uncapped: false,
    });
  });

  it('stays accurate past 2^53, where a double would already be rounding', () => {
    // A realistic cap in wei is far larger than a double can count exactly.
    const cap = 10n ** 19n;
    const used = cap / 4n;
    expect(spendPosition({ dailyCapWei: cap.toString(), dailyUsedWei: used.toString() })).toMatchObject(
      { ratio: 0.25 },
    );
  });

  it('says uncapped rather than pretending a limit of zero', () => {
    // No cap and a full cap are opposite states; conflating them would make
    // an organisation with no limit look permanently exhausted.
    expect(spendPosition({ dailyCapWei: null, dailyUsedWei: '5' })).toEqual({
      capWei: null,
      usedWei: '5',
      ratio: null,
      uncapped: true,
    });
  });

  it('treats a cap of zero as a real cap that is already full', () => {
    expect(spendPosition({ dailyCapWei: '0', dailyUsedWei: '0' })).toMatchObject({
      ratio: 1,
      uncapped: false,
    });
  });

  it('does not report more than full, however the provider counts', () => {
    expect(spendPosition({ dailyCapWei: '100', dailyUsedWei: '250' })).toMatchObject({ ratio: 1 });
  });

  it('reads nothing spent as nothing spent', () => {
    expect(spendPosition({ dailyCapWei: '100', dailyUsedWei: null })).toMatchObject({
      usedWei: '0',
      ratio: 0,
    });
  });

  it('survives a provider that sends something that is not a number', () => {
    expect(spendPosition({ dailyCapWei: 'lots', dailyUsedWei: 'some' })).toEqual({
      capWei: null,
      usedWei: '0',
      ratio: null,
      uncapped: true,
    });
  });
});
