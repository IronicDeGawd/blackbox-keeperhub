/**
 * Let KeeperHub drive the loop.
 *
 * Blackbox's own `setInterval` is a fine default and a poor integration: it
 * polls whether or not anything happened, it cannot know about a contract event
 * until it reads a block, and it stops when this process does. KeeperHub
 * already schedules work, already watches contracts, and already runs when we
 * are not — so where it can do the waiting, it should.
 *
 * Every trigger installed here ends the same way: a code node that calls
 * `/api/webhooks/keeperhub`. That endpoint reads runs from KeeperHub itself and
 * ignores its request body, so a workflow cannot tell Blackbox anything untrue
 * — it can only ask it to look. One ingress, one trust boundary, three reasons
 * to fire it.
 */

export type WorkflowClient = {
  listWorkflows(): Promise<{ id: string; name: string }[]>;
  createWorkflow(definition: {
    name: string;
    nodes: unknown[];
    edges: unknown[];
    enabled?: boolean;
  }): Promise<{ id: string }>;
  patchWorkflow(id: string, definition: Record<string, unknown>): Promise<void>;
};

export type TriggerInstallOptions = {
  client: WorkflowClient;
  /** This deployment's public address. The workflow calls it from KeeperHub. */
  baseUrl: string;
  /** Minted by `/api/webhooks/keeperhub/secret`. Grants only "go and look". */
  webhookSecret: string;
};

/**
 * KeeperHub refuses a schedule under a minute, and it is right to: our own tick
 * is fifteen seconds precisely because it is cheap and local, while a workflow
 * run is neither.
 */
export const MIN_SCHEDULE_SECONDS = 60;

export class ScheduleIntervalTooSmall extends Error {
  constructor(seconds: number) {
    super(
      `KeeperHub schedules cannot run more often than every ${MIN_SCHEDULE_SECONDS}s; ${seconds}s was requested.`,
    );
    this.name = 'ScheduleIntervalTooSmall';
  }
}

/**
 * The node that calls us.
 *
 * The secret is written into the workflow rather than read from an environment
 * variable, because a KeeperHub code node has no environment of ours to read.
 * It therefore sits in the operator's own workflow definition, visible to
 * whoever can already read their workflows — which is why the secret is scoped
 * to "make Blackbox poll" and can do nothing else.
 */
function nudgeNode(baseUrl: string, secret: string, yOffset: number): unknown {
  const url = `${baseUrl.replace(/\/$/, '')}/api/webhooks/keeperhub`;
  return {
    id: 'step-1',
    type: 'action',
    position: { x: 0, y: yOffset },
    data: {
      label: 'Notify Blackbox',
      description: 'Asks Blackbox to read this organisation’s runs now.',
      config: {
        actionType: 'code/run-code',
        code: [
          '// Blackbox reads the runs itself; this only asks it to look now.',
          `await fetch(${JSON.stringify(url)}, {`,
          "  method: 'POST',",
          `  headers: { Authorization: ${JSON.stringify(`Bearer ${secret}`)} },`,
          '});',
          "return { notified: true };",
        ].join('\n'),
      },
    },
  };
}

const edge = { id: 'e-trigger-1-step-1', source: 'trigger-1', target: 'step-1' };

function triggerNode(config: Record<string, unknown>, label: string): unknown {
  return {
    id: 'trigger-1',
    type: 'trigger',
    position: { x: 0, y: 0 },
    data: { label, config },
  };
}

/**
 * Install a workflow, or update the one already there.
 *
 * Named rather than counted, so re-running this does not accumulate workflows
 * in an operator's console. Schedule configuration is applied by PATCH because
 * that is the route that syncs it — create alone persists the nodes without
 * registering the schedule.
 */
async function upsert(
  options: TriggerInstallOptions,
  name: string,
  nodes: unknown[],
): Promise<{ workflowId: string; created: boolean }> {
  const existing = (await options.client.listWorkflows()).find((w) => w.name === name);
  const definition = { nodes, edges: [edge], enabled: true };
  if (existing) {
    await options.client.patchWorkflow(existing.id, definition);
    return { workflowId: existing.id, created: false };
  }
  const created = await options.client.createWorkflow({ name, ...definition });
  // Create persists the nodes; the schedule and event registrations are synced
  // on update, so the patch is not redundant even immediately after creation.
  await options.client.patchWorkflow(created.id, definition);
  return { workflowId: created.id, created: true };
}

/**
 * C1 — detection on KeeperHub's schedule rather than ours.
 *
 * Our `setInterval` becomes the fallback for a deployment with no KeeperHub
 * key, rather than the only way the loop turns.
 */
export async function installScheduledSweep(
  options: TriggerInstallOptions & { intervalSeconds?: number; cron?: string; timezone?: string },
): Promise<{ workflowId: string; created: boolean }> {
  const name = 'blackbox/triggers/sweep';
  if (options.intervalSeconds !== undefined && options.intervalSeconds < MIN_SCHEDULE_SECONDS) {
    throw new ScheduleIntervalTooSmall(options.intervalSeconds);
  }
  const config: Record<string, unknown> = {
    triggerType: 'Schedule',
    scheduleTimezone: options.timezone ?? 'UTC',
    // Interval wins when both are given, matching how KeeperHub reads it.
    ...(options.intervalSeconds !== undefined
      ? { scheduleIntervalSeconds: options.intervalSeconds }
      : {}),
    ...(options.cron ? { scheduleCron: options.cron } : {}),
  };
  if (options.intervalSeconds === undefined && !options.cron) {
    throw new Error('A scheduled sweep needs either intervalSeconds or a cron expression.');
  }
  return upsert(options, name, [
    triggerNode(config, 'Schedule'),
    nudgeNode(options.baseUrl, options.webhookSecret, 160),
  ]);
}

/**
 * C3 — watch an operator's contract without running an indexer.
 *
 * KeeperHub already watches contracts for its own triggers. Reusing that means
 * Blackbox hears about an event without reading a single block, and without
 * every deployment maintaining a log subscription of its own.
 */
export async function installEventTrigger(options: TriggerInstallOptions & {
  contractAddress: string;
  eventName: string;
  /** Chain id as KeeperHub expects it on a trigger node: a string. */
  network: string;
  contractABI?: string;
  /** Suffixed onto the workflow name, so several contracts can be watched. */
  label?: string;
}): Promise<{ workflowId: string; created: boolean }> {
  const suffix = options.label ?? `${options.contractAddress.slice(0, 10)}-${options.eventName}`;
  return upsert(options, `blackbox/triggers/event/${suffix}`, [
    triggerNode(
      {
        triggerType: 'Event',
        contractAddress: options.contractAddress,
        eventName: options.eventName,
        network: options.network,
        ...(options.contractABI ? { contractABI: options.contractABI } : {}),
      },
      'Contract event',
    ),
    nudgeNode(options.baseUrl, options.webhookSecret, 160),
  ]);
}

/**
 * Their trigger set also includes Block and Transfer, which are not installed
 * here. The Schedule and Event configurations above were read from KeeperHub's
 * own source — `extractScheduleConfig` and the events route — but nothing in
 * the published code names the fields a Block trigger expects. Guessing them
 * would produce a workflow that looks installed and never fires, which is worse
 * than not offering it.
 */
export const UNSUPPORTED_TRIGGERS = ['Block', 'Transfer'] as const;
