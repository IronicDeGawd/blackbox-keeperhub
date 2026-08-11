import { describe, expect, it } from 'vitest';
import { guardedPause, type CheckAndExecuteClient } from './guarded.js';

const client = (conditionMet: boolean) => {
  const calls: Record<string, unknown>[] = [];
  const impl: CheckAndExecuteClient = {
    checkAndExecute: async (params) => {
      calls.push(params as unknown as Record<string, unknown>);
      return {
        conditionMet,
        execution: conditionMet ? { executionId: 'exec-1' } : null,
        raw: {},
      };
    },
  };
  return { impl, calls };
};

describe('pausing only if it is not already paused', () => {
  it('acts when the breaker is still live', async () => {
    const c = client(true);
    const result = await guardedPause(c.impl, {
      breakerAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0',
      chainId: 11155111,
    });
    expect(result).toEqual({ acted: true, executionId: 'exec-1' });
    // The condition and the action are one call, so the state that was checked
    // is the state the action runs against.
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]).toMatchObject({
      functionName: 'paused',
      condition: { operator: 'eq', value: 'false' },
      action: { functionName: 'pause' },
      chainId: '11155111',
    });
  });

  /**
   * Pausing something already paused costs gas and writes a ledger entry
   * claiming a fix that changed nothing.
   */
  it('does nothing, and says so, when it is already paused', async () => {
    const c = client(false);
    const result = await guardedPause(c.impl, {
      breakerAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0',
      chainId: 11155111,
    });
    expect(result).toEqual({ acted: false, reason: 'already_paused' });
  });

  it('passes an idempotency key through, so a retry replays', async () => {
    const c = client(true);
    await guardedPause(c.impl, {
      breakerAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0',
      chainId: 11155111,
      idempotencyKey: 'incident-1-pause',
    });
    expect(c.calls[0]?.['idempotencyKey']).toBe('incident-1-pause');
  });

  it('allows a different flag for a contract that names it differently', async () => {
    const c = client(true);
    await guardedPause(c.impl, {
      breakerAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0',
      chainId: 11155111,
      readFunction: 'isHalted',
      pausedValue: 'false',
    });
    expect(c.calls[0]).toMatchObject({ functionName: 'isHalted' });
  });
});

describe('audit findings 4 and 11', () => {
  /** Their API cannot auto-fetch an ABI for an unverified contract. */
  it('always sends an ABI, on both the read and the action', async () => {
    const calls: Record<string, unknown>[] = [];
    await guardedPause(
      {
        checkAndExecute: async (params) => {
          calls.push(params as unknown as Record<string, unknown>);
          return { conditionMet: true, execution: { executionId: 'x' }, raw: {} };
        },
      },
      { breakerAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0', chainId: 11155111 },
    );
    expect(calls[0]?.['abi']).toContain('paused');
    expect((calls[0]?.['action'] as { abi?: string })?.abi).toContain('pause');
  });

  it('lets a caller override it for a breaker that differs', async () => {
    const calls: Record<string, unknown>[] = [];
    await guardedPause(
      {
        checkAndExecute: async (params) => {
          calls.push(params as unknown as Record<string, unknown>);
          return { conditionMet: false, execution: null, raw: {} };
        },
      },
      {
        breakerAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0',
        chainId: 11155111,
        abi: '[{"name":"halted"}]',
      },
    );
    expect(calls[0]?.['abi']).toBe('[{"name":"halted"}]');
  });
});
