import { beforeEach, describe, expect, it } from 'vitest';
import { blackboxConfigSchema, detectionFor, CHAIN_IDS } from '@blackbox/core';
import { R1, R2, R3, R4, R5, R6, R7 } from './rules.js';
import { evaluateRules } from './index.js';
import { at, evt, resetSeq, SIGNER, T0 } from './fixtures.js';
import type { RuleContext } from './types.js';

const config = blackboxConfigSchema.parse({
  keeperHub: { orgKey: 'kh_test' },
  databaseUrl: 'postgres://localhost/blackbox',
});
const detection = detectionFor(config, CHAIN_IDS.sepolia); // stuckThresholdMs 90_000

const ctx = (overrides: Partial<RuleContext> = {}): RuleContext => ({
  now: at(200_000),
  detection,
  agentId: 'chaos',
  signer: SIGNER,
  chainId: CHAIN_IDS.sepolia,
  ...overrides,
});

beforeEach(resetSeq);

describe('R1 STUCK_TRANSACTION', () => {
  it('fires for a pending event older than the threshold', () => {
    const e = evt({ status: 'pending', nonce: 5, submittedAt: T0 });
    const r = R1.evaluate([e], ctx());
    expect(r?.class).toBe('STUCK_TRANSACTION');
    expect(r?.facts['pendingDurationMs']).toBe(200_000);
  });

  it('near miss: pending but not yet past the threshold', () => {
    const e = evt({ status: 'pending', nonce: 5, submittedAt: T0 });
    expect(R1.evaluate([e], ctx({ now: at(89_999) }))).toBeNull();
  });

  it('does not fire once the nonce has a terminal event', () => {
    const stuck = evt({ status: 'pending', nonce: 5, submittedAt: T0 });
    const landed = evt({ status: 'included', nonce: 5, submittedAt: at(1_000) });
    expect(R1.evaluate([stuck, landed], ctx())).toBeNull();
  });

  it('is more confident when RPC corroborates the nonce has not advanced', () => {
    const e = evt({ status: 'pending', nonce: 5, submittedAt: T0 });
    expect(R1.evaluate([e], ctx())?.confidence).toBe(0.6);
    expect(
      R1.evaluate([e], ctx({ corroboration: { latestNonce: 5 } }))?.confidence,
    ).toBe(0.95);
  });

  it('respects a tighter per-chain threshold', () => {
    const baseDetection = detectionFor(config, CHAIN_IDS.baseSepolia); // 30_000
    const e = evt({ status: 'pending', nonce: 5, submittedAt: T0 });
    expect(R1.evaluate([e], ctx({ now: at(45_000), detection: baseDetection }))).not.toBeNull();
    expect(R1.evaluate([e], ctx({ now: at(45_000) }))).toBeNull();
  });
});

describe('R2 NONCE_GAP', () => {
  const pending = () => evt({ status: 'pending', nonce: 7, submittedAt: T0 });

  it('fires once the gap has persisted for the configured number of polls', () => {
    const r = R2.evaluate(
      [pending()],
      ctx({ corroboration: { latestNonce: 6, pendingNonce: 8, consecutiveGapPolls: 2 } }),
    );
    expect(r?.class).toBe('NONCE_GAP');
    expect(r?.severity).toBe('critical');
  });

  it('near miss: gap seen only once', () => {
    expect(
      R2.evaluate(
        [pending()],
        ctx({ corroboration: { latestNonce: 6, pendingNonce: 8, consecutiveGapPolls: 1 } }),
      ),
    ).toBeNull();
  });

  it('does not fire when there is no gap', () => {
    expect(
      R2.evaluate(
        [pending()],
        ctx({ corroboration: { latestNonce: 8, pendingNonce: 8, consecutiveGapPolls: 5 } }),
      ),
    ).toBeNull();
  });

  it('does not fire without corroboration, since the gap is an RPC fact', () => {
    expect(R2.evaluate([pending()], ctx())).toBeNull();
  });

  it('does not fire when every nonce above the confirmed one has resolved', () => {
    const resolved = evt({ status: 'included', nonce: 7, submittedAt: T0 });
    expect(
      R2.evaluate(
        [resolved],
        ctx({ corroboration: { latestNonce: 6, pendingNonce: 8, consecutiveGapPolls: 3 } }),
      ),
    ).toBeNull();
  });
});

describe('R3 GAS_UNDERPRICED', () => {
  const baseFee = 1_000_000_000n;

  it('fires when the bid is below the current base fee', () => {
    const e = evt({ status: 'pending', nonce: 3, maxFeePerGas: 500_000_000n });
    const r = R3.evaluate([e], ctx({ corroboration: { baseFeeAtDetection: baseFee } }));
    expect(r?.class).toBe('GAS_UNDERPRICED');
    expect(r?.facts['feeDeficitPct']).toBe(50);
  });

  it('near miss: bid exactly at the base fee', () => {
    const e = evt({ status: 'pending', nonce: 3, maxFeePerGas: baseFee });
    expect(R3.evaluate([e], ctx({ corroboration: { baseFeeAtDetection: baseFee } }))).toBeNull();
  });

  it('ignores events that already landed', () => {
    const e = evt({ status: 'included', nonce: 3, maxFeePerGas: 1n });
    expect(R3.evaluate([e], ctx({ corroboration: { baseFeeAtDetection: baseFee } }))).toBeNull();
  });

  it('does not fire without a base fee to compare against', () => {
    const e = evt({ status: 'pending', nonce: 3, maxFeePerGas: 1n });
    expect(R3.evaluate([e], ctx())).toBeNull();
  });
});

describe('R4 SIM_PASS_EXEC_REVERT', () => {
  it('fires when a passing simulation reverted onchain', () => {
    const e = evt({
      status: 'reverted',
      simSuccess: true,
      simulatedAtBlock: 100,
      blockNumber: 104,
      revertReason: 'insufficient output amount',
      observedAt: at(30_000),
    });
    const r = R4.evaluate([e], ctx());
    expect(r?.class).toBe('SIM_PASS_EXEC_REVERT');
    expect(r?.facts['blockDrift']).toBe(4);
    expect(r?.severity).toBe('critical');
  });

  it('near miss: reverted but the simulation had already failed', () => {
    // A pre-flight rejection must never look like state drift.
    const e = evt({ status: 'rejected', simSuccess: false, simRevertReason: 'ERC20: balance' });
    expect(R4.evaluate([e], ctx())).toBeNull();
  });

  it('does not fire when simulation success is unknown', () => {
    const e = evt({ status: 'reverted' });
    e.simulation = { performed: true };
    expect(R4.evaluate([e], ctx())).toBeNull();
  });

  it('does not fire when the transaction succeeded', () => {
    expect(R4.evaluate([evt({ status: 'included', simSuccess: true })], ctx())).toBeNull();
  });
});

describe('R5 RETRY_STORM', () => {
  const attempts = (n: number, status: 'reverted' | 'rejected' = 'reverted') =>
    Array.from({ length: n }, (_, i) =>
      evt({
        logicalActionId: 'action-1',
        status,
        submittedAt: at(i * 1_000),
        gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n,
        revertReason: 'always reverts',
      }),
    );

  it('fires at the configured attempt count', () => {
    const r = R5.evaluate(attempts(4), ctx({ now: at(10_000) }));
    expect(r?.class).toBe('RETRY_STORM');
    expect(r?.facts['attemptCount']).toBe(4);
    expect(r?.facts['totalGasBurned']).toBe((21_000n * 1_000_000_000n * 4n).toString());
  });

  it('near miss: one attempt short', () => {
    expect(R5.evaluate(attempts(3), ctx({ now: at(10_000) }))).toBeNull();
  });

  it('does not count attempts that fell outside the window', () => {
    const old = attempts(4).map((e) => ({
      ...e,
      submission: { ...e.submission, submittedAt: at(-400_000) },
    }));
    expect(R5.evaluate(old, ctx({ now: at(10_000) }))).toBeNull();
  });

  it('does not group attempts belonging to different logical actions', () => {
    const mixed = attempts(4).map((e, i) => ({ ...e, logicalActionId: `action-${i}` }));
    expect(R5.evaluate(mixed, ctx({ now: at(10_000) }))).toBeNull();
  });

  it('flags a storm of pre-flight rejections, which burns no gas', () => {
    const r = R5.evaluate(attempts(4, 'rejected'), ctx({ now: at(10_000) }));
    expect(r?.facts['allRejectedPreflight']).toBe(true);
  });

  it('does not treat replacements as failures', () => {
    const replaced = attempts(4).map((e) => ({
      ...e,
      outcome: { ...e.outcome, status: 'replaced' as const },
    }));
    expect(R5.evaluate(replaced, ctx({ now: at(10_000) }))).toBeNull();
  });
});

describe('R6 SIGNER_GAS_STARVED', () => {
  const spent = () =>
    evt({ status: 'included', gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n });
  const cost = 21_000n * 1_000_000_000n; // 2.1e13 per action

  it('warns when the balance falls under the multiple of median cost', () => {
    const r = R6.evaluate([spent(), spent()], ctx({ corroboration: { signerBalance: cost * 2n } }));
    expect(r?.class).toBe('SIGNER_GAS_STARVED');
    expect(r?.severity).toBe('warning');
    expect(r?.facts['projectedActionsRemaining']).toBe(2);
  });

  it('near miss: balance exactly at the threshold', () => {
    expect(
      R6.evaluate([spent(), spent()], ctx({ corroboration: { signerBalance: cost * 3n } })),
    ).toBeNull();
  });

  it('escalates to critical once an action failed for want of funds', () => {
    const failed = evt({ status: 'rejected', simSuccess: false, simRevertReason: 'insufficient funds for gas' });
    const r = R6.evaluate([spent(), failed], ctx({ corroboration: { signerBalance: 1n } }));
    expect(r?.severity).toBe('critical');
    expect(r?.facts['observedFundingFailure']).toBe(true);
  });

  it('does not fire without any spend history to project from', () => {
    expect(R6.evaluate([evt({ status: 'pending' })], ctx({ corroboration: { signerBalance: 1n } })))
      .toBeNull();
  });
});

describe('R7 ADVERSE_INCLUSION', () => {
  const inclusion = {
    expectedOut: 1_000_000n,
    actualOut: 900_000n, // 1000 bps adverse
    blockNumber: 500,
    txIndexInBlock: 3,
    neighbouringTxHashes: ['0xaaa', '0xbbb'],
  };
  const publicEvt = () => evt({ status: 'included', route: 'public', blockNumber: 500 });

  it('fires on adverse movement with positional evidence', () => {
    const r = R7.evaluate([publicEvt()], ctx({ inclusion }));
    expect(r?.class).toBe('ADVERSE_INCLUSION');
    expect(r?.facts['deltaBps']).toBe(1000);
  });

  it('keeps confidence deliberately low — positional evidence is not proof', () => {
    expect(R7.evaluate([publicEvt()], ctx({ inclusion }))?.confidence).toBeLessThan(0.8);
  });

  it('near miss: movement within tolerance', () => {
    const withinTolerance = { ...inclusion, actualOut: 999_000n }; // 10 bps
    expect(R7.evaluate([publicEvt()], ctx({ inclusion: withinTolerance }))).toBeNull();
  });

  it('does not fire when the outcome was favourable', () => {
    const better = { ...inclusion, actualOut: 1_200_000n };
    expect(R7.evaluate([publicEvt()], ctx({ inclusion: better }))).toBeNull();
  });

  it('does not fire on a private-route submission', () => {
    const priv = evt({ status: 'included', route: 'private', blockNumber: 500 });
    expect(R7.evaluate([priv], ctx({ inclusion }))).toBeNull();
  });

  it('does not fire without neighbouring transactions to point at', () => {
    const alone = { ...inclusion, neighbouringTxHashes: [] };
    expect(R7.evaluate([publicEvt()], ctx({ inclusion: alone }))).toBeNull();
  });

  it('does not fire without an inclusion analysis, since rules cannot do I/O', () => {
    expect(R7.evaluate([publicEvt()], ctx())).toBeNull();
  });
});

describe('correlation and suppression', () => {
  it('suppresses R1 when R3 explains the same stuck transaction', () => {
    const e = evt({
      status: 'pending',
      nonce: 5,
      maxFeePerGas: 100n,
      submittedAt: T0,
    });
    const drafts = evaluateRules(
      [e],
      ctx({ corroboration: { baseFeeAtDetection: 1_000_000_000n } }),
    );
    const classes = drafts.map((d) => d.class);
    expect(classes).toContain('GAS_UNDERPRICED');
    expect(classes).not.toContain('STUCK_TRANSACTION');

    // Suppressed, not discarded: the timeline must still show both signals.
    const underpriced = drafts.find((d) => d.ruleId === 'R3');
    expect(underpriced?.suppressedRules).toEqual(['R1']);
  });

  it('still reports R1 alone when the fee is healthy', () => {
    const e = evt({
      status: 'pending',
      nonce: 5,
      maxFeePerGas: 5_000_000_000n,
      submittedAt: T0,
    });
    const drafts = evaluateRules(
      [e],
      ctx({ corroboration: { baseFeeAtDetection: 1_000_000_000n } }),
    );
    expect(drafts.map((d) => d.class)).toEqual(['STUCK_TRANSACTION']);
  });

  it('orders results most severe first, then most confident', () => {
    const reverted = evt({
      status: 'reverted',
      simSuccess: true,
      simulatedAtBlock: 1,
      blockNumber: 2,
    });
    const stuck = evt({ status: 'pending', nonce: 9, submittedAt: T0 });
    const drafts = evaluateRules([reverted, stuck], ctx());
    expect(drafts[0]?.severity).toBe('critical');
  });

  it('returns nothing for a healthy signer', () => {
    expect(evaluateRules([evt({ status: 'included' })], ctx())).toEqual([]);
  });
});
