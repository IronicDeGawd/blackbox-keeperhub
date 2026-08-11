import { describe, expect, it, vi } from 'vitest';
import type { ChainReader } from '@blackbox/recorder';
import { makeFallbackReader } from './runtime.js';

const TX = `0x${'a'.repeat(64)}` as `0x${string}`;

const transaction = (over: Record<string, unknown> = {}) =>
  ({
    hash: TX,
    from: '0x00000000000000000000000000000000000000aa',
    to: '0x00000000000000000000000000000000000000bb',
    input: '0x',
    nonce: 7,
    blockNumber: null,
    ...over,
  }) as never;

const reader = (over: Partial<ChainReader> = {}): ChainReader =>
  ({
    getTransaction: vi.fn(async () => null),
    getReceipt: vi.fn(async () => null),
    call: vi.fn(async () => ({ success: true })),
    ...over,
  }) as ChainReader;

describe('makeFallbackReader', () => {
  const params = { hash: TX, chainId: 11155111 };

  it('takes the answer from the first endpoint that has one', async () => {
    const second = reader({ getTransaction: vi.fn(async () => transaction()) });
    const composed = makeFallbackReader([reader(), second]);
    await expect(composed.getTransaction(params)).resolves.toMatchObject({ nonce: 7 });
  });

  it('keeps asking after an endpoint throws instead of abandoning the sweep', async () => {
    // The reason this matters: a lookup that throws propagates out of the
    // recorder poll and kills the whole tick, so one sick endpoint would stop
    // every observation rather than just its own.
    const angry = reader({
      getTransaction: vi.fn(async () => {
        throw new Error('429 Too Many Requests');
      }),
    });
    const healthy = reader({ getTransaction: vi.fn(async () => transaction()) });
    const composed = makeFallbackReader([angry, healthy]);

    await expect(composed.getTransaction(params)).resolves.toMatchObject({ nonce: 7 });
    expect(healthy.getTransaction).toHaveBeenCalled();
  });

  it('returns null when every endpoint throws, rather than throwing', async () => {
    const angry = () =>
      reader({
        getTransaction: vi.fn(async () => {
          throw new Error('down');
        }),
      });
    const composed = makeFallbackReader([angry(), angry()]);
    await expect(composed.getTransaction(params)).resolves.toBeNull();
  });

  it('does not consult a second endpoint once one has answered', async () => {
    const first = reader({ getTransaction: vi.fn(async () => transaction()) });
    const second = reader();
    await makeFallbackReader([first, second]).getTransaction(params);
    expect(second.getTransaction).not.toHaveBeenCalled();
  });

  it('falls back for receipts on the same terms', async () => {
    const healthy = reader({ getReceipt: vi.fn(async () => ({ status: 'success' }) as never) });
    const angry = reader({
      getReceipt: vi.fn(async () => {
        throw new Error('down');
      }),
    });
    await expect(makeFallbackReader([angry, healthy]).getReceipt(params)).resolves.toMatchObject({
      status: 'success',
    });
  });
});
