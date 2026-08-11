import type { ExecutionEvent } from '@blackbox/core';

export const SIGNER = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5' as `0x${string}`;
export const T0 = new Date('2026-08-09T18:00:00.000Z');

export const at = (msFromT0: number): Date => new Date(T0.getTime() + msFromT0);

let seq = 0;
export const resetSeq = (): void => {
  seq = 0;
};

/**
 * Synthetic `ExecutionEvent` builder for rule tests. Defaults describe a plain
 * successful inclusion; each test overrides only the fields its rule reads,
 * which keeps it obvious what actually drives the assertion.
 */
export function evt(overrides: {
  id?: string;
  logicalActionId?: string;
  submittedAt?: Date;
  nonce?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  route?: 'public' | 'private' | 'unknown';
  status?: ExecutionEvent['outcome']['status'];
  blockNumber?: number;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  revertReason?: string;
  simPerformed?: boolean;
  simSuccess?: boolean;
  simRevertReason?: string;
  simulatedAtBlock?: number;
  gasEstimate?: bigint;
  observedAt?: Date;
  /** For the KeeperHub rules: a run belongs to a workflow and reaches a step. */
  workflowId?: string;
  workflowName?: string;
  completedSteps?: number;
  errorType?: string;
  agentKind?: 'keeperhub' | 'signer';
  noTxHash?: boolean;
} = {}): ExecutionEvent {
  const id = overrides.id ?? `e${seq++}`;
  return {
    id,
    sourceId: id,
    logicalActionId: overrides.logicalActionId ?? id,
    attemptIndex: 0,
    agentId: 'chaos',
    signer: SIGNER,
    chainId: 11155111,
    ...(overrides.agentKind ? { agentKind: overrides.agentKind } : {}),
    ...(overrides.workflowId ? { workflowId: overrides.workflowId } : {}),
    trigger: {
      kind: 'api',
      detail: {
        ...(overrides.workflowId ? { workflowId: overrides.workflowId } : {}),
        ...(overrides.workflowName ? { workflowName: overrides.workflowName } : {}),
        ...(overrides.completedSteps !== undefined
          ? { completedSteps: overrides.completedSteps }
          : {}),
        ...(overrides.errorType ? { errorType: overrides.errorType } : {}),
      },
    },
    simulation: {
      performed: overrides.simPerformed ?? true,
      ...(overrides.simSuccess !== undefined ? { success: overrides.simSuccess } : { success: true }),
      ...(overrides.simRevertReason ? { revertReason: overrides.simRevertReason } : {}),
      ...(overrides.simulatedAtBlock !== undefined
        ? { simulatedAtBlock: overrides.simulatedAtBlock }
        : {}),
      ...(overrides.gasEstimate !== undefined ? { gasEstimate: overrides.gasEstimate } : {}),
    },
    submission: {
      // A run rejected in pre-flight never produced one.
      ...(overrides.noTxHash
        ? {}
        : { txHash: `0x${id.replace(/\W/g, '').padEnd(64, '0')}` as `0x${string}` }),
      ...(overrides.nonce !== undefined ? { nonce: overrides.nonce } : {}),
      ...(overrides.maxFeePerGas !== undefined ? { maxFeePerGas: overrides.maxFeePerGas } : {}),
      ...(overrides.maxPriorityFeePerGas !== undefined
        ? { maxPriorityFeePerGas: overrides.maxPriorityFeePerGas }
        : {}),
      submittedAt: overrides.submittedAt ?? T0,
      route: overrides.route ?? 'unknown',
    },
    outcome: {
      status: overrides.status ?? 'included',
      ...(overrides.blockNumber !== undefined ? { blockNumber: overrides.blockNumber } : {}),
      ...(overrides.gasUsed !== undefined ? { gasUsed: overrides.gasUsed } : {}),
      ...(overrides.effectiveGasPrice !== undefined
        ? { effectiveGasPrice: overrides.effectiveGasPrice }
        : {}),
      ...(overrides.revertReason ? { revertReason: overrides.revertReason } : {}),
      ...(overrides.observedAt ? { observedAt: overrides.observedAt } : {}),
    },
    raw: null,
    ingestedAt: T0,
  };
}
