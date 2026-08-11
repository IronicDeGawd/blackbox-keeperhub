import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, ingestCursors, type Database } from '@blackbox/store';
import { Demo, DEMO_COOLDOWN_MS, DEMO_WORKFLOW_NAME } from './demo.js';

const URL_ = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const T0 = new Date('2026-08-12T12:00:00.000Z');

describe('the one button a visitor may press', () => {
  let db: Database;
  let close: () => Promise<void>;
  let now = T0;

  beforeAll(() => {
    ({ db, close } = createDb(URL_));
  });
  afterAll(async () => {
    await close();
  });
  beforeEach(async () => {
    now = T0;
    await db.delete(ingestCursors);
  });

  const client = () => {
    const created: { name: string; nodes: unknown[] }[] = [];
    const executed: string[] = [];
    let existing: { id: string; name: string }[] = [];
    return {
      created,
      executed,
      setExisting: (rows: { id: string; name: string }[]) => {
        existing = rows;
      },
      listWorkflows: async () => existing,
      createWorkflow: async (definition: { name: string; nodes: unknown[] }) => {
        created.push(definition);
        existing = [...existing, { id: 'wf-demo', name: definition.name }];
        return { id: 'wf-demo' };
      },
      executeWorkflow: async (id: string) => {
        executed.push(id);
        return { executionId: `exec-${executed.length}`, status: 'running' };
      },
    };
  };

  const demo = (c: ReturnType<typeof client>, sweep?: () => Promise<unknown>) =>
    new Demo({ db, client: c, chainId: 11155111, now: () => now, ...(sweep ? { sweep } : {}) });

  it('starts a real KeeperHub run', async () => {
    const c = client();
    const result = await demo(c).run();

    expect(result).toMatchObject({ ran: true, executionId: 'exec-1', workflowId: 'wf-demo' });
    expect(c.executed).toEqual(['wf-demo']);
  });

  /**
   * The failure has to cost nothing: the transfer asks for more than the
   * wallet holds, so KeeperHub refuses it in pre-flight and no transaction is
   * ever submitted.
   */
  it('asks for more than any wallet holds, so it is refused before submission', async () => {
    const c = client();
    await demo(c).run();

    const step = (c.created[0]?.nodes[1] as { data: { config: Record<string, string> } }).data.config;
    expect(step['actionType']).toBe('web3/transfer-funds');
    expect(BigInt(step['amount'] ?? '0')).toBeGreaterThan(10n ** 21n - 1n);
    expect(step['network']).toBe('11155111');
  });

  it('reuses the workflow rather than accumulating one per press', async () => {
    const c = client();
    await demo(c).run();
    now = new Date(T0.getTime() + DEMO_COOLDOWN_MS);
    await demo(c).run();

    expect(c.created).toHaveLength(1);
    expect(c.executed).toEqual(['wf-demo', 'wf-demo']);
  });

  it('adopts the workflow already there after a restart', async () => {
    const c = client();
    c.setExisting([{ id: 'wf-existing', name: DEMO_WORKFLOW_NAME }]);
    await demo(c).run();

    expect(c.created).toEqual([]);
    expect(c.executed).toEqual(['wf-existing']);
  });

  /** The cooldown is what bounds our execution quota, so it is not per caller. */
  it('refuses a second press inside the cooldown, for anybody', async () => {
    const c = client();
    await demo(c).run();

    // A different instance, as a different visitor's request would be.
    const second = await demo(client()).run();
    expect(second).toMatchObject({ ran: false, reason: 'cooling_down' });
    expect((second as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('allows the next press once the cooldown has passed', async () => {
    const c = client();
    await demo(c).run();
    now = new Date(T0.getTime() + DEMO_COOLDOWN_MS + 1000);
    expect((await demo(c).run()).ran).toBe(true);
  });

  it('survives a restart, since the cooldown is not held in memory', async () => {
    await demo(client()).run();
    now = new Date(T0.getTime() + 60_000);
    expect((await demo(client()).run()).ran).toBe(false);
  });

  it('says when it may next be pressed', async () => {
    const c = client();
    expect((await demo(c).nextAllowedAt()).getTime()).toBe(0);
    await demo(c).run();
    expect((await demo(c).nextAllowedAt()).toISOString()).toBe(
      new Date(T0.getTime() + DEMO_COOLDOWN_MS).toISOString(),
    );
  });

  /**
   * Claiming the slot before running costs at most one wasted press if the run
   * fails to start. Not claiming it lets two simultaneous visitors both spend
   * an execution, which is the mistake that actually costs something.
   */
  it('claims the slot before spending it', async () => {
    const c = client();
    c.executeWorkflow = async () => {
      throw new Error('their side is down');
    };
    await expect(demo(c).run()).rejects.toThrow('their side is down');
    expect((await demo(c).run()).ran).toBe(false);
  });

  it('asks for the run to be read straight away', async () => {
    let swept = 0;
    await demo(client(), async () => {
      swept += 1;
    }).run();
    expect(swept).toBe(1);
  });

  it('still reports success when that read fails', async () => {
    const result = await demo(client(), async () => {
      throw new Error('sweep failed');
    }).run();
    expect(result.ran).toBe(true);
  });
});
