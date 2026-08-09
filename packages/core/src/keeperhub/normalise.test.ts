import { describe, expect, it } from 'vitest';
import { keeperHubExecutionSchema, extractRevertReason, failureStage } from './types.js';
import { normaliseExecution } from './normalise.js';
import success from './fixtures/direct-execution-success.json' with { type: 'json' };
import preflight from './fixtures/direct-execution-preflight-failure.json' with { type: 'json' };
import retried from './fixtures/direct-execution-retried.json' with { type: 'json' };

const opts = (overrides = {}) => {
  let n = 0;
  return {
    agentId: 'chaos',
    signer: '0x01cc313321eb09c51f5b649f2bbd578ee32750a5' as `0x${string}`,
    chainId: 11155111,
    now: new Date('2026-08-09T18:30:00.000Z'),
    makeId: () => `evt-${n++}`,
    ...overrides,
  };
};

describe('golden fixtures parse', () => {
  it('accepts every captured record shape', () => {
    for (const fixture of [success, preflight, retried]) {
      expect(keeperHubExecutionSchema.safeParse(fixture).success).toBe(true);
    }
  });

  it('tolerates fields the docs never mentioned going missing', () => {
    const stripped = { ...success } as Record<string, unknown>;
    for (const k of ['sponsored', 'receipts', 'retryCount', 'gasPriceWei', 'estimatedCostUsd']) {
      delete stripped[k];
    }
    expect(keeperHubExecutionSchema.safeParse(stripped).success).toBe(true);
  });
});

describe('failureStage', () => {
  it('is null when the execution did not fail', () => {
    expect(failureStage(keeperHubExecutionSchema.parse(success))).toBeNull();
  });

  it('reads no hash and no receipt as a pre-flight rejection', () => {
    expect(failureStage(keeperHubExecutionSchema.parse(preflight))).toBe('preflight');
  });

  it('reads a failure that produced a receipt as onchain', () => {
    const onchain = keeperHubExecutionSchema.parse({ ...retried, status: 'failed' });
    expect(failureStage(onchain)).toBe('onchain');
  });
});

describe('extractRevertReason', () => {
  it('unwraps the Error(...) form KeeperHub returns', () => {
    expect(extractRevertReason('Contract call failed: Error(ERC20: transfer amount exceeds balance)'))
      .toBe('ERC20: transfer amount exceeds balance');
  });

  it('falls back to the prose when the wrapper is absent', () => {
    expect(extractRevertReason('Contract call failed: something odd')).toBe('something odd');
  });

  it('returns the original string when nothing matches', () => {
    expect(extractRevertReason('nonsense')).toBe('nonsense');
  });

  it('is undefined for no error', () => {
    expect(extractRevertReason(null)).toBeUndefined();
    expect(extractRevertReason(undefined)).toBeUndefined();
  });
});

describe('normalise: successful single-attempt execution', () => {
  const events = normaliseExecution(keeperHubExecutionSchema.parse(success), opts());

  it('produces exactly one event', () => {
    expect(events).toHaveLength(1);
  });

  it('maps the receipt to an included outcome with gas and block', () => {
    const e = events[0]!;
    expect(e.outcome.status).toBe('included');
    expect(e.outcome.blockNumber).toBe(11453642);
    expect(e.outcome.gasUsed).toBe(68021n);
    expect(e.outcome.effectiveGasPrice).toBe(1015327660n);
  });

  it('records the simulation as performed and passing', () => {
    expect(events[0]!.simulation).toEqual({ performed: true, success: true });
  });

  it('keeps the raw payload intact', () => {
    expect(events[0]!.raw).toMatchObject({ executionId: success.executionId });
  });

  it('reports route as unknown when the wrapper supplied nothing', () => {
    expect(events[0]!.submission.route).toBe('unknown');
  });

  it('carries wrapper-supplied fee data through when present', () => {
    const withFees = normaliseExecution(
      keeperHubExecutionSchema.parse(success),
      opts({ submitted: { maxFeePerGas: 5n, maxPriorityFeePerGas: 2n, nonce: 7, route: 'private' } }),
    );
    expect(withFees[0]!.submission.maxFeePerGas).toBe(5n);
    expect(withFees[0]!.submission.maxPriorityFeePerGas).toBe(2n);
    expect(withFees[0]!.submission.nonce).toBe(7);
    expect(withFees[0]!.submission.route).toBe('private');
  });
});

describe('normalise: pre-flight rejection', () => {
  const events = normaliseExecution(keeperHubExecutionSchema.parse(preflight), opts());

  it('still yields one event even with no receipt', () => {
    expect(events).toHaveLength(1);
  });

  it('marks the outcome rejected rather than reverted', () => {
    expect(events[0]!.outcome.status).toBe('rejected');
  });

  it('puts the decoded reason on the simulation, not the outcome', () => {
    // R4 keys off simulation.success === true, so a pre-flight failure must
    // never look like a passing simulation.
    expect(events[0]!.simulation.success).toBe(false);
    expect(events[0]!.simulation.revertReason).toBe('ERC20: transfer amount exceeds balance');
    expect(events[0]!.outcome.revertReason).toBeUndefined();
  });

  it('records no transaction hash', () => {
    expect(events[0]!.submission.txHash).toBeUndefined();
  });
});

describe('normalise: retried execution', () => {
  const events = normaliseExecution(keeperHubExecutionSchema.parse(retried), opts());

  it('fans one record out into one event per receipt', () => {
    expect(events).toHaveLength(2);
  });

  it('shares a logicalActionId across attempts', () => {
    expect(new Set(events.map((e) => e.logicalActionId)).size).toBe(1);
  });

  it('numbers attempts and keeps sourceIds distinct for dedupe', () => {
    expect(events.map((e) => e.attemptIndex)).toEqual([0, 1]);
    expect(new Set(events.map((e) => e.sourceId)).size).toBe(2);
  });

  it('treats a superseded earlier attempt as replaced', () => {
    expect(events[0]!.outcome.status).toBe('replaced');
    expect(events[1]!.outcome.status).toBe('included');
  });

  it('attributes the effective gas price only to the final attempt', () => {
    expect(events[0]!.outcome.effectiveGasPrice).toBeUndefined();
    expect(events[1]!.outcome.effectiveGasPrice).toBe(2000000000n);
  });
});

describe('normalise: in-flight execution', () => {
  it('maps a running execution with no receipt to pending', () => {
    const running = keeperHubExecutionSchema.parse({
      ...success,
      status: 'running',
      receipts: [],
      completedAt: null,
    });
    expect(normaliseExecution(running, opts())[0]!.outcome.status).toBe('pending');
  });
});
