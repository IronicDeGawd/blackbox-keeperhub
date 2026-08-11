import { getCursor, setCursor, type Database } from '@blackbox/store';

/**
 * One button a visitor can press to make something actually happen.
 *
 * Reading a finished incident is not the same as watching one appear, and a
 * judge with no account should be able to see the whole arc: a run fails, the
 * sweep reads it, a rule fires, an incident opens. So this induces a *real*
 * failure on **our own** organisation — a genuine KeeperHub run in the real
 * audit trail, not a fixture written into the database.
 *
 * What it does not do:
 *
 * - It never touches anyone else's organisation. The only thing it can break
 *   is ours.
 * - It spends no gas. The transfer asks for more than the wallet holds, so
 *   KeeperHub refuses it in pre-flight — which is itself one of the failure
 *   modes Blackbox exists to explain.
 * - It cannot be pressed in a loop. One call every thirty minutes, for
 *   everybody, because the limit exists to bound our execution quota and a
 *   per-caller limit would not do that.
 */

/** Recorded in `ingest_cursors`, which is where this deployment keeps "when did we last…". */
const LAST_RUN_KEY = 'demo:last-run';

export const DEMO_COOLDOWN_MS = 30 * 60_000;

/** A hole nothing can fall into, and a recipient nobody can mistake for real. */
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';

/** Far more than any testnet wallet holds, so the estimate always refuses. */
const UNAFFORDABLE_WEI = '1000000000000000000000';

export const DEMO_WORKFLOW_NAME = 'blackbox/demo/insufficient-funds';

export type DemoClient = {
  listWorkflows(): Promise<{ id: string; name: string }[]>;
  createWorkflow(definition: {
    name: string;
    description?: string;
    nodes: unknown[];
    edges: unknown[];
    enabled?: boolean;
  }): Promise<{ id: string }>;
  executeWorkflow(id: string, input?: Record<string, unknown>): Promise<{ executionId: string; status: string }>;
};

export type DemoOptions = {
  db: Database;
  client: DemoClient;
  chainId: number;
  now?: () => Date;
  /** Asks the runtime to read the run we just caused, rather than waiting a tick. */
  sweep?: () => Promise<unknown>;
};

export type DemoResult =
  | { ran: true; executionId: string; workflowId: string; nextAllowedAt: string }
  | { ran: false; reason: 'cooling_down'; retryAfterSeconds: number; nextAllowedAt: string };

function definition(chainId: number) {
  return {
    name: DEMO_WORKFLOW_NAME,
    description:
      'Blackbox demo: a transfer larger than the wallet holds, so it is refused before submission.',
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 0, y: 0 },
        // Manual: Blackbox drives this through POST /{id}/execute, and a webhook
        // trigger would advertise an inbound URL nothing ever calls.
        data: { type: 'trigger', label: 'Manual', config: { triggerType: 'Manual' } },
      },
      {
        id: 'step-1',
        type: 'action',
        position: { x: 0, y: 150 },
        data: {
          type: 'action',
          label: 'Transfer more than we have',
          config: {
            actionType: 'web3/transfer-funds',
            network: String(chainId),
            recipientAddress: BURN_ADDRESS,
            amount: UNAFFORDABLE_WEI,
          },
        },
      },
    ],
    edges: [{ id: 'e-trigger-1-step-1', source: 'trigger-1', target: 'step-1' }],
    enabled: true,
  };
}

export class Demo {
  private readonly now: () => Date;
  private workflowId: string | undefined;

  constructor(private readonly options: DemoOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** When the button may next be pressed, by anyone. */
  async nextAllowedAt(): Promise<Date> {
    const last = await getCursor(this.options.db, LAST_RUN_KEY);
    if (!last) return new Date(0);
    return new Date(Date.parse(last) + DEMO_COOLDOWN_MS);
  }

  async run(): Promise<DemoResult> {
    const at = this.now();
    const nextAllowed = await this.nextAllowedAt();
    if (nextAllowed.getTime() > at.getTime()) {
      return {
        ran: false,
        reason: 'cooling_down',
        retryAfterSeconds: Math.ceil((nextAllowed.getTime() - at.getTime()) / 1000),
        nextAllowedAt: nextAllowed.toISOString(),
      };
    }

    /**
     * Claim the slot *before* running.
     *
     * Two visitors pressing together would otherwise both pass the check and
     * both spend an execution. Writing first costs at most one wasted slot if
     * the run then fails to start, which is the cheaper mistake.
     */
    await setCursor(this.options.db, LAST_RUN_KEY, at.toISOString());

    const workflowId = await this.ensureWorkflow();
    const execution = await this.options.client.executeWorkflow(workflowId);

    // Read it now rather than at the next tick, so the incident appears while
    // whoever pressed the button is still looking at the page.
    await this.options.sweep?.().catch(() => undefined);

    return {
      ran: true,
      executionId: execution.executionId,
      workflowId,
      nextAllowedAt: new Date(at.getTime() + DEMO_COOLDOWN_MS).toISOString(),
    };
  }

  /** Named rather than counted, so pressing the button never accumulates workflows. */
  private async ensureWorkflow(): Promise<string> {
    if (this.workflowId) return this.workflowId;
    const existing = (await this.options.client.listWorkflows()).find(
      (w) => w.name === DEMO_WORKFLOW_NAME,
    );
    if (existing) {
      this.workflowId = existing.id;
      return existing.id;
    }
    const created = await this.options.client.createWorkflow(definition(this.options.chainId));
    this.workflowId = created.id;
    return created.id;
  }
}
