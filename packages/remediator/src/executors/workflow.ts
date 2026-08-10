import { getChain } from '@blackbox/core';
import type { RemediationExecutor } from '../remediator.js';
import type { ReceiptVerifier } from './verify.js';

/**
 * Remediation as a KeeperHub workflow.
 *
 * The strongest form of the integration: Blackbox does not merely call an
 * execution endpoint, it authors and drives KeeperHub workflows. A remediation
 * becomes a workflow run in the operator's own dashboard, with per-node logs,
 * sponsorship and spend controls that they already trust — rather than a side
 * channel they cannot see.
 *
 * Workflows are provisioned on demand and reused. The name encodes exactly what
 * the workflow does, so the same playbook against the same contract on the same
 * chain finds its workflow instead of creating a duplicate on every incident.
 *
 * Field names here differ from Direct Execution for the same concepts —
 * `abiFunction` and `args` rather than `functionName` and `functionArgs` — which
 * is undocumented and was established by reading validation errors.
 *
 * The same structural limit as Direct Execution applies: workflow actions
 * execute through the sponsored relayer at the sponsor's nonce, so a plan that
 * names a nonce cannot be served here either.
 */

export type WorkflowClient = {
  listWorkflows(): Promise<{ id: string; name: string; enabled?: boolean }[]>;
  createWorkflow(definition: {
    name: string;
    description?: string;
    nodes: unknown[];
    edges: unknown[];
  }): Promise<{ id: string }>;
  patchWorkflow(id: string, definition: Record<string, unknown>): Promise<void>;
  executeWorkflow(id: string, input?: Record<string, unknown>): Promise<{ executionId: string }>;
  getWorkflowExecution(executionId: string): Promise<{
    status: string;
    error: string | null;
    logs: { nodeType: string; status: string; output?: { transactionHash?: string } | null }[];
  }>;
};

export type WorkflowExecutorOptions = {
  /** How long to wait for a run to produce a transaction hash. */
  pollAttempts?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class WorkflowExecutor implements RemediationExecutor {
  /** Workflow ids by name, so one process provisions each at most once. */
  private readonly known = new Map<string, string>();

  constructor(
    private readonly client: WorkflowClient,
    private readonly verifier: ReceiptVerifier,
    private readonly options: WorkflowExecutorOptions = {},
  ) {}

  /**
   * A name that identifies the work, not the incident.
   *
   * Incident-specific names would leave a workflow per incident cluttering the
   * operator's dashboard forever. This way "pause the breaker at 0x69C7 on
   * Sepolia" is one workflow that every matching incident reuses.
   */
  static workflowName(params: {
    playbookId: string;
    chainId: number;
    to: string;
    functionName?: string;
  }): string {
    const what = params.functionName ?? 'transfer';
    return `blackbox/${params.playbookId}/${params.chainId}/${what}/${params.to.toLowerCase()}`;
  }

  private async ensureWorkflow(params: {
    name: string;
    description: string;
    nodes: unknown[];
  }): Promise<string> {
    const cached = this.known.get(params.name);
    if (cached) return cached;

    const existing = (await this.client.listWorkflows()).find((w) => w.name === params.name);
    if (existing) {
      this.known.set(params.name, existing.id);
      return existing.id;
    }

    const created = await this.client.createWorkflow({
      name: params.name,
      description: params.description,
      nodes: params.nodes,
      edges: [{ id: 'e1', source: 'trigger-1', target: 'step-1' }],
    });
    // Creation leaves a workflow disabled, and only PATCH persists node config
    // and the enabled flag — `go-live` returns 200 and drops node changes.
    await this.client.patchWorkflow(created.id, {
      name: params.name,
      description: params.description,
      nodes: params.nodes,
      edges: [{ id: 'e1', source: 'trigger-1', target: 'step-1' }],
      enabled: true,
    });
    this.known.set(params.name, created.id);
    return created.id;
  }

  async submit(params: Parameters<RemediationExecutor['submit']>[0]): ReturnType<
    RemediationExecutor['submit']
  > {
    const { plan, incident } = params;
    if (plan.nonce !== undefined) {
      throw new Error(
        `A KeeperHub workflow cannot submit at a chosen nonce: its actions execute through the ` +
          `sponsored relayer at the sponsor's nonce, never as ${incident.signer}. ` +
          `"${plan.description}" needs nonce ${plan.nonce} and must be signed by that account.`,
      );
    }

    const chain = getChain(incident.chainId);
    const name = WorkflowExecutor.workflowName({
      playbookId: 'remediation',
      chainId: incident.chainId,
      to: plan.to,
      ...(plan.call ? { functionName: plan.call.functionName } : {}),
    });

    const trigger = {
      id: 'trigger-1',
      type: 'trigger',
      position: { x: 0, y: 0 },
      data: { type: 'trigger', label: 'Trigger', config: { triggerType: 'Webhook' } },
    };

    const step = plan.call
      ? {
          id: 'step-1',
          type: 'action',
          position: { x: 0, y: 150 },
          data: {
            type: 'action',
            label: plan.description,
            config: {
              actionType: 'web3/write-contract',
              network: String(incident.chainId),
              contractAddress: plan.to,
              abiFunction: plan.call.functionName,
              args: JSON.stringify(plan.call.args),
              abi:
                plan.call.abi ??
                JSON.stringify([
                  {
                    name: plan.call.functionName,
                    type: 'function',
                    stateMutability: 'nonpayable',
                    inputs: [],
                    outputs: [],
                  },
                ]),
            },
          },
        }
      : {
          id: 'step-1',
          type: 'action',
          position: { x: 0, y: 150 },
          data: {
            type: 'action',
            label: plan.description,
            config: {
              actionType: 'web3/transfer-funds',
              network: String(incident.chainId),
              recipientAddress: plan.to,
              amount: plan.value.toString(),
            },
          },
        };

    const workflowId = await this.ensureWorkflow({
      name,
      description: `Blackbox remediation on ${chain.name}: ${plan.description}`,
      nodes: [trigger, step],
    });

    const { executionId } = await this.client.executeWorkflow(workflowId, {
      incidentId: incident.id,
      incidentClass: incident.class,
      signer: incident.signer,
    });

    const txHash = await this.awaitHash(executionId);
    if (!txHash) {
      throw new Error(
        `KeeperHub workflow run ${executionId} produced no transaction hash, so the remediation ` +
          'cannot be verified and must not be reported as performed',
      );
    }
    return { txHash, keeperHubActionId: executionId, executor: 'keeperhub-workflow' };
  }

  /**
   * Wait for the run to produce a hash.
   *
   * The execute call answers with `running` and nothing else, so the hash only
   * appears in the per-node logs once the action has executed. A run that ends
   * in `error` fails immediately rather than waiting out the timeout — its
   * message is the useful part.
   */
  private async awaitHash(executionId: string): Promise<`0x${string}` | null> {
    const attempts = this.options.pollAttempts ?? 15;
    const interval = this.options.pollIntervalMs ?? 3_000;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    for (let i = 0; i < attempts; i++) {
      const run = await this.client.getWorkflowExecution(executionId);
      const hash = run.logs
        .map((l) => l.output?.transactionHash)
        .find((h): h is string => Boolean(h));
      if (hash) return hash as `0x${string}`;
      if (run.status === 'error') {
        throw new Error(`KeeperHub workflow run ${executionId} failed: ${run.error ?? 'no reason given'}`);
      }
      if (i < attempts - 1) await sleep(interval);
    }
    return null;
  }

  async verify(params: Parameters<RemediationExecutor['verify']>[0]): ReturnType<
    RemediationExecutor['verify']
  > {
    return this.verifier.waitForReceipt({
      txHash: params.txHash,
      chainId: params.incident.chainId,
      timeoutMs: params.timeoutMs,
    });
  }
}
