import { describe, expect, it } from 'vitest';
import { sameAddress, toQuantity } from './wallet';

describe('EIP-1193 quantities', () => {
  it('encodes without leading zeros, and zero as 0x0', () => {
    expect(toQuantity(0)).toBe('0x0');
    expect(toQuantity(47)).toBe('0x2f');
    expect(toQuantity('0')).toBe('0x0');
  });

  it('carries a fee no float could hold', () => {
    expect(toQuantity('4191302983')).toBe('0xf9d23547');
    expect(toQuantity('1000000000000000001')).toBe('0xde0b6b3a7640001');
  });

  it('accepts the decimal strings the plan is made of', () => {
    expect(toQuantity('2000000000')).toBe('0x77359400');
  });
});

describe('address comparison', () => {
  it('treats a checksummed address as the same account as its lowercase form', () => {
    expect(
      sameAddress(
        '0xb9c58185d09D0aCf3b237cD45C67345E32e628BA',
        '0xb9c58185d09d0acf3b237cd45c67345e32e628ba',
      ),
    ).toBe(true);
  });

  it('does not confuse two different accounts', () => {
    expect(
      sameAddress(
        '0xb9c58185d09D0aCf3b237cD45C67345E32e628BA',
        '0xa17cb6adb58277e5b4a44b8c1ecb449bb6614e87',
      ),
    ).toBe(false);
  });
});
