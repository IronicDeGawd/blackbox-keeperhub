import { getChain } from '@blackbox/core';

/**
 * Chaos someone else signs.
 *
 * The harness induces failures with a key Blackbox holds, which is right for
 * our own demo and useless for anyone evaluating the product: they would be
 * watching our wallet break, on our funds, and taking our word for what
 * happened.
 *
 * This builds the same failures as unsigned transactions for *their* address.
 * They sign in their own wallet, the block scanner discovers the result
 * because the address is registered at plan time, and the rules reason over it
 * exactly as they would over ours. Blackbox needs no key, and nothing here can
 * spend anything of ours.
 *
 * Ordering matters for some scenarios and cannot be expressed as a bag of
 * transactions, so each step says whether it must wait for the previous one to
 * be mined. C3 is the clearest case: the trap has to be armed in an earlier
 * block than the call it springs on, which is the whole mechanism.
 */

export type ChaosStep = {
  order: number;
  label: string;
  /** Why this step exists, shown next to the wallet prompt. */
  explanation: string;
  transaction: {
    to: string;
    value: string;
    data: string | null;
    /** Set only where the scenario depends on a specific nonce. */
    nonce: number | null;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    /** Supplied where estimation would fail — a call that is meant to revert. */
    gas: string | null;
    chainId: number;
  };
  /** The next step is only valid once this one has been mined. */
  waitForInclusion: boolean;
};

export type ChaosPlan = {
  scenario: string;
  chainId: number;
  signer: string;
  induces: string;
  expectedDetectionSeconds: number;
  /** What the operator should see, so the page can set expectations. */
  expect: string;
  steps: ChaosStep[];
  /**
   * Where to send the hashes once signed.
   *
   * Not a nicety. A transaction above an unused nonce is queued rather than
   * mined, so it appears in no block and block scanning cannot find it — the
   * wallet that sent it is the only party that knows it exists. A console that
   * skips this step will sit watching for an incident that never arrives.
   */
  reportTo: { method: 'POST'; path: '/api/chaos/observe'; field: 'txHashes' };
  /** Present when the scenario cannot be planned for this caller. */
  declined?: string;
};

export type ChainState = {
  nextNonce: number;
  baseFeePerGas: bigint;
};

export type PlanContext = {
  chainId: number;
  signer: string;
  state: ChainState;
  /** Deployed ChaosTarget, required by the contract-level scenarios. */
  chaosTarget?: string;
};

/** `armTrap()`, `work()`, `alwaysRevert()` — verified with `cast sig`. */
const SELECTORS = {
  armTrap: '0x27eab502',
  work: '0x322e9f04',
  alwaysRevert: '0x9fb37853',
} as const;

const SELF_SEND_GAS = '30000';

export const PLANNABLE_SCENARIOS = ['C1', 'C2', 'C3', 'C4'] as const;
export type PlannableScenario = (typeof PLANNABLE_SCENARIOS)[number];

export function planChaos(scenario: string, ctx: PlanContext): ChaosPlan {
  const chain = getChain(ctx.chainId);
  const base: Omit<ChaosPlan, 'induces' | 'expect' | 'steps'> = {
    scenario,
    chainId: ctx.chainId,
    signer: ctx.signer,
    expectedDetectionSeconds: 45,
    reportTo: { method: 'POST', path: '/api/chaos/observe', field: 'txHashes' },
  };

  const tip = 1_000_000_000n;
  const normalFee = ctx.state.baseFeePerGas * 2n + tip;

  const tx = (over: Partial<ChaosStep['transaction']>): ChaosStep['transaction'] => ({
    to: ctx.signer,
    value: '0',
    data: null,
    nonce: null,
    maxFeePerGas: normalFee.toString(),
    maxPriorityFeePerGas: tip.toString(),
    gas: SELF_SEND_GAS,
    chainId: ctx.chainId,
    ...over,
  });

  switch (scenario) {
    case 'C1':
      return {
        ...base,
        induces: 'GAS_UNDERPRICED',
        expect:
          'A transaction that is accepted but has no reason to be included. It may confirm ' +
          'anyway on a quiet chain, which is why this one is not deterministic.',
        steps: [
          {
            order: 1,
            label: 'Send a transaction with no inclusion incentive',
            explanation:
              'Priced at exactly the current base fee with no tip. A node accepts it — the bid ' +
              'is not below base — but nothing is paid to include it, so it falls behind as ' +
              'soon as the market moves.',
            transaction: tx({
              maxFeePerGas: ctx.state.baseFeePerGas.toString(),
              maxPriorityFeePerGas: '0',
            }),
            waitForInclusion: false,
          },
        ],
      };

    case 'C2':
      return {
        ...base,
        induces: 'NONCE_GAP',
        expect:
          `Nonce ${ctx.state.nextNonce} is left unused, so this transaction and everything ` +
          'after it is stuck until the hole is filled. Blackbox offers you the fix to sign.',
        steps: [
          {
            order: 1,
            label: `Send at nonce ${ctx.state.nextNonce + 1}, skipping ${ctx.state.nextNonce}`,
            explanation:
              'Ethereum runs an account\'s transactions in strict order, so a transaction above ' +
              'an unused nonce is queued rather than pending and can never be mined until the ' +
              'gap is filled. Your wallet may warn about the nonce; that is the point.',
            transaction: tx({ nonce: ctx.state.nextNonce + 1 }),
            waitForInclusion: false,
          },
        ],
      };

    case 'C3': {
      if (!ctx.chaosTarget) {
        return {
          ...base,
          induces: 'SIM_PASS_EXEC_REVERT',
          expect: '',
          steps: [],
          declined: 'This deployment has no ChaosTarget contract configured.',
        };
      }
      return {
        ...base,
        induces: 'SIM_PASS_EXEC_REVERT',
        expect:
          'The second transaction simulates cleanly in your wallet and then reverts on chain. ' +
          'Nothing about the call changes — the state underneath it does.',
        steps: [
          {
            order: 1,
            label: 'Arm the trap',
            explanation:
              'Records the current block on the target contract. Calls still succeed in this ' +
              'block, which is what makes the next step simulate clean.',
            transaction: tx({ to: ctx.chaosTarget, data: SELECTORS.armTrap, gas: '60000' }),
            // The trap deliberately does not spring in the block it was armed
            // in, so the next step must land in a later one.
            waitForInclusion: true,
          },
          {
            order: 2,
            label: 'Call the trapped function',
            explanation:
              'Your wallet simulates this against the current block, where it succeeds. By the ' +
              'time it is mined a block has passed and the same call reverts. Gas is set ' +
              'manually because estimation runs the simulation that passes.',
            transaction: tx({ to: ctx.chaosTarget, data: SELECTORS.work, gas: '100000' }),
            waitForInclusion: false,
          },
        ],
      };
    }

    case 'C4': {
      if (!ctx.chaosTarget) {
        return {
          ...base,
          induces: 'RETRY_STORM',
          expect: '',
          steps: [],
          declined: 'This deployment has no ChaosTarget contract configured.',
        };
      }
      const target = ctx.chaosTarget;
      const attempts = 4;
      return {
        ...base,
        induces: 'RETRY_STORM',
        expect:
          `${attempts} transactions that each revert and each cost gas. Retrying a call that ` +
          'fails deterministically cannot succeed, which is the point Blackbox will make.',
        steps: Array.from({ length: attempts }, (_, i) => ({
          order: i + 1,
          label: `Attempt ${i + 1} of ${attempts}`,
          explanation:
            'Calls a function that always reverts. Sent one at a time so they read as retries ' +
            'of one action rather than as a nonce gap.',
          transaction: tx({ to: target, data: SELECTORS.alwaysRevert, gas: '60000' }),
          waitForInclusion: true,
        })),
      };
    }

    default:
      return {
        ...base,
        induces: '',
        expect: '',
        steps: [],
        declined:
          `${scenario} cannot be signed from a wallet. C5 starves a signer, which would leave ` +
          `yours unable to transact, and C6 needs control over block ordering. ` +
          `Signable here: ${PLANNABLE_SCENARIOS.join(', ')} on ${chain.name}.`,
      };
  }
}
