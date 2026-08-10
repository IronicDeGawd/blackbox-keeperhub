import { describe, expect, it } from 'vitest';
import { CHAIN_IDS } from '@blackbox/core';
import { planChaos, PLANNABLE_SCENARIOS, type PlanContext } from './chaos-plans.js';

const SIGNER = '0x00000000000000000000000000000000000000aa';
const TARGET = '0x00000000000000000000000000000000000000bb';

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  chainId: CHAIN_IDS.sepolia,
  signer: SIGNER,
  state: { nextNonce: 12, baseFeePerGas: 2_000_000_000n },
  chaosTarget: TARGET,
  ...over,
});

describe('planChaos', () => {
  it('leaves a hole at the nonce the wallet would otherwise use next', () => {
    const plan = planChaos('C2', ctx());
    expect(plan.induces).toBe('NONCE_GAP');
    // 13, not 12: sending at 12 would simply succeed and induce nothing.
    expect(plan.steps[0]?.transaction.nonce).toBe(13);
  });

  it('prices C1 at the base fee with no tip, so there is no reason to include it', () => {
    const plan = planChaos('C1', ctx());
    const tx = plan.steps[0]!.transaction;
    expect(tx.maxFeePerGas).toBe('2000000000');
    expect(tx.maxPriorityFeePerGas).toBe('0');
  });

  it('never names a nonce except where the scenario is about the nonce', () => {
    for (const id of PLANNABLE_SCENARIOS) {
      if (id === 'C2') continue;
      const plan = planChaos(id, ctx());
      for (const step of plan.steps) expect(step.transaction.nonce).toBeNull();
    }
  });

  it('makes C3 wait for the arming transaction, since the trap springs a block later', () => {
    const plan = planChaos('C3', ctx());
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.waitForInclusion).toBe(true);
    expect(plan.steps[0]?.transaction.data).toBe('0x27eab502'); // armTrap()
    expect(plan.steps[1]?.transaction.data).toBe('0x322e9f04'); // work()
  });

  it('sends every contract-level step to the target rather than to the caller', () => {
    for (const id of ['C3', 'C4'] as const) {
      for (const step of planChaos(id, ctx()).steps) {
        expect(step.transaction.to).toBe(TARGET);
      }
    }
  });

  it('sets gas explicitly on calls that are meant to revert, because estimation would throw', () => {
    for (const step of planChaos('C4', ctx()).steps) {
      expect(step.transaction.gas).not.toBeNull();
      expect(step.waitForInclusion).toBe(true);
    }
  });

  it('declines the contract scenarios when no target is deployed', () => {
    for (const id of ['C3', 'C4'] as const) {
      const plan = planChaos(id, ctx({ chaosTarget: undefined }));
      expect(plan.declined).toMatch(/no ChaosTarget/i);
      expect(plan.steps).toEqual([]);
    }
  });

  it('declines a scenario no wallet can sign, and says what it can', () => {
    const plan = planChaos('C5', ctx());
    expect(plan.declined).toMatch(/starves a signer/i);
    expect(plan.declined).toContain('C2');
    expect(plan.steps).toEqual([]);
  });

  it('tells the caller to report the hashes, since a queued tx is in no block', () => {
    expect(planChaos('C2', ctx()).reportTo.path).toBe('/api/chaos/observe');
  });

  it('plans nothing that could spend more than gas', () => {
    for (const id of PLANNABLE_SCENARIOS) {
      for (const step of planChaos(id, ctx()).steps) expect(step.transaction.value).toBe('0');
    }
  });
});
