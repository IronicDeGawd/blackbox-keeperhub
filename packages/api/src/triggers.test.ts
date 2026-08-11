import { describe, expect, it } from 'vitest';
import {
  installEventTrigger,
  installScheduledSweep,
  MIN_SCHEDULE_SECONDS,
  ScheduleIntervalTooSmall,
  type WorkflowClient,
} from './triggers.js';

type Recorded = { name?: string; nodes: unknown[]; edges: unknown[]; enabled?: boolean };

const client = (existing: { id: string; name: string }[] = []) => {
  const created: Recorded[] = [];
  const patched: { id: string; definition: Recorded }[] = [];
  const impl: WorkflowClient = {
    listWorkflows: async () => existing,
    createWorkflow: async (definition) => {
      created.push(definition as Recorded);
      return { id: 'wf-new' };
    },
    patchWorkflow: async (id, definition) => {
      patched.push({ id, definition: definition as unknown as Recorded });
    },
  };
  return { impl, created, patched };
};

const base = { baseUrl: 'https://blackbox.test/', webhookSecret: 'whsec_abc' };

const nodeConfig = (nodes: unknown[], index: number): Record<string, unknown> =>
  (nodes[index] as { data: { config: Record<string, unknown> } }).data.config;

describe('scheduled sweep', () => {
  it('installs a Schedule trigger that calls this deployment', async () => {
    const c = client();
    const result = await installScheduledSweep({ ...base, client: c.impl, intervalSeconds: 300 });

    expect(result).toEqual({ workflowId: 'wf-new', created: true });
    const nodes = c.created[0]!.nodes;
    expect(nodeConfig(nodes, 0)).toMatchObject({
      triggerType: 'Schedule',
      scheduleIntervalSeconds: 300,
      scheduleTimezone: 'UTC',
    });
    const code = String(nodeConfig(nodes, 1)['code']);
    // No double slash: the base URL's trailing slash is trimmed.
    expect(code).toContain('https://blackbox.test/api/webhooks/keeperhub');
    expect(code).toContain('Bearer whsec_abc');
    expect(nodeConfig(nodes, 1)['actionType']).toBe('code/run-code');
  });

  /**
   * Create persists the nodes; the schedule registration is synced on update.
   * Skipping the patch would leave a workflow that exists and never fires.
   */
  it('patches after creating, because that is what registers the schedule', async () => {
    const c = client();
    await installScheduledSweep({ ...base, client: c.impl, cron: '*/5 * * * *' });
    expect(c.patched).toHaveLength(1);
    expect(c.patched[0]?.id).toBe('wf-new');
  });

  it('updates the existing workflow rather than adding another', async () => {
    const c = client([{ id: 'wf-1', name: 'blackbox/triggers/sweep' }]);
    const result = await installScheduledSweep({ ...base, client: c.impl, intervalSeconds: 60 });
    expect(result).toEqual({ workflowId: 'wf-1', created: false });
    expect(c.created).toHaveLength(0);
    expect(c.patched[0]?.id).toBe('wf-1');
  });

  it('refuses an interval KeeperHub would reject', async () => {
    const c = client();
    await expect(
      installScheduledSweep({ ...base, client: c.impl, intervalSeconds: MIN_SCHEDULE_SECONDS - 1 }),
    ).rejects.toBeInstanceOf(ScheduleIntervalTooSmall);
    // Nothing was written on the way to failing.
    expect(c.created).toHaveLength(0);
    expect(c.patched).toHaveLength(0);
  });

  it('refuses a schedule with neither an interval nor a cron expression', async () => {
    await expect(installScheduledSweep({ ...base, client: client().impl })).rejects.toThrow(
      /intervalSeconds or a cron/,
    );
  });

  it('accepts a cron expression with a timezone', async () => {
    const c = client();
    await installScheduledSweep({
      ...base,
      client: c.impl,
      cron: '0 * * * *',
      timezone: 'Asia/Kolkata',
    });
    expect(nodeConfig(c.created[0]!.nodes, 0)).toMatchObject({
      scheduleCron: '0 * * * *',
      scheduleTimezone: 'Asia/Kolkata',
    });
  });
});

describe('contract event trigger', () => {
  it('installs an Event trigger for one contract and event', async () => {
    const c = client();
    await installEventTrigger({
      ...base,
      client: c.impl,
      contractAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0',
      eventName: 'Paused',
      network: '11155111',
    });
    expect(nodeConfig(c.created[0]!.nodes, 0)).toMatchObject({
      triggerType: 'Event',
      contractAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0',
      eventName: 'Paused',
      network: '11155111',
    });
  });

  // One workflow per contract-and-event, so watching a second contract does not
  // silently replace the first.
  it('names the workflow per contract and event', async () => {
    const c = client();
    await installEventTrigger({
      ...base,
      client: c.impl,
      contractAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0',
      eventName: 'Paused',
      network: '11155111',
    });
    await installEventTrigger({
      ...base,
      client: c.impl,
      contractAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0',
      eventName: 'Unpaused',
      network: '11155111',
    });
    expect(c.created.map((d) => d.name)).toEqual([
      'blackbox/triggers/event/0x69C744Bb-Paused',
      'blackbox/triggers/event/0x69C744Bb-Unpaused',
    ]);
  });

  it('every trigger ends at the same endpoint, so there is one trust boundary', async () => {
    const c = client();
    await installScheduledSweep({ ...base, client: c.impl, intervalSeconds: 60 });
    await installEventTrigger({
      ...base,
      client: c.impl,
      contractAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0',
      eventName: 'Paused',
      network: '11155111',
    });
    for (const definition of c.created) {
      expect(String(nodeConfig(definition.nodes, 1)['code'])).toContain(
        '/api/webhooks/keeperhub',
      );
    }
  });
});
