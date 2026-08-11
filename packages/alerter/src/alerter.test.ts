import { describe, expect, it, vi } from 'vitest';
import { CHAIN_IDS, type Incident } from '@blackbox/core';
import { alertFor } from './alert.js';
import { Alerter, type Channel } from './alerter.js';
import { inQuietHours, selectRoutes, type RoutingPolicy } from './routing.js';
import { discordRender, keeperHubEmailChannel, logChannel, webhookChannel } from './channels.js';

const T0 = new Date('2026-08-11T12:00:00.000Z');
const SIGNER = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5' as const;

const incident = (over: Partial<Incident> = {}): Incident =>
  ({
    id: 'inc-1',
    class: 'NONCE_GAP',
    severity: 'critical',
    status: 'open',
    agentId: 'demo-agent',
    signer: SIGNER,
    chainId: CHAIN_IDS.sepolia,
    detectedAt: T0,
    firstEventAt: T0,
    confidence: 0.9,
    evidence: {
      eventIds: ['e1'],
      ruleId: 'R2',
      facts: { missingNonces: [47], blockedActionCount: 2 },
    },
    ...over,
  }) as Incident;

const collector = (name = 'default'): Channel & { got: string[] } => {
  const got: string[] = [];
  return { name, got, deliver: async (a) => void got.push(`${a.kind}:${a.summary}`) };
};

describe('what is worth saying', () => {
  it('announces a new incident in words rather than jargon', () => {
    const alert = alertFor(incident(), undefined, T0);
    expect(alert?.kind).toBe('opened');
    expect(alert?.summary).toBe('demo-agent: nonce 47 unfilled, 2 actions blocked');
  });

  // The whole point: a detector re-evaluates every tick, and the same problem
  // still being true is not news.
  it('says nothing the second time it sees the same incident', async () => {
    const channel = collector();
    const alerter = new Alerter({ channels: [channel], now: () => T0 });
    await alerter.consider(incident());
    await alerter.consider(incident());
    await alerter.consider(incident());
    expect(channel.got).toEqual(['opened:demo-agent: nonce 47 unfilled, 2 actions blocked']);
  });

  it('speaks again when the incident gets worse', async () => {
    const channel = collector();
    const policy: RoutingPolicy = { routes: [{ channel: 'default', minSeverity: 'info' }] };
    const alerter = new Alerter({ channels: [channel], policy, now: () => T0 });
    await alerter.consider(incident({ severity: 'warning' }));
    await alerter.consider(incident({ severity: 'critical' }));
    await alerter.consider(incident({ severity: 'critical' }));
    expect(channel.got.map((g) => g.split(':')[0])).toEqual(['opened', 'escalated']);
  });

  /** The alert most likely to end up in a screenshot. */
  it('reports a self-repair with the transaction that did it', async () => {
    const channel = collector();
    const alerter = new Alerter({ channels: [channel], now: () => T0 });
    await alerter.consider(incident());
    const fixed = incident({
      status: 'resolved',
      remediation: {
        playbookId: 'P1',
        finalStatus: 'succeeded',
        attempts: [
          // An earlier attempt that failed must not be the hash we quote.
          { attemptIndex: 0, startedAt: T0, guardsPassed: [], guardsFailed: [], status: 'failed', txHash: `0x${'b'.repeat(64)}` },
          { attemptIndex: 1, startedAt: T0, guardsPassed: [], guardsFailed: [], status: 'succeeded', txHash: `0x${'a'.repeat(64)}` },
        ],
      },
    } as Partial<Incident>);
    const result = await alerter.consider(fixed);
    expect(result.alert?.kind).toBe('resolved');
    expect(result.alert?.summary).toContain('fixed, 0xaaaaaaaa');
    expect(result.alert?.links[0]?.url).toContain(`0x${'a'.repeat(64)}`);
  });

  it('reports a failed repair once, with the reason it stopped', async () => {
    const channel = collector();
    const alerter = new Alerter({ channels: [channel], now: () => T0 });
    await alerter.consider(incident());
    const broken = incident({
      remediation: {
        playbookId: 'P1',
        finalStatus: 'failed',
        attempts: [
          { attemptIndex: 0, startedAt: T0, guardsPassed: [], guardsFailed: [], status: 'failed', failureReason: 'budget exhausted' },
        ],
      },
    } as Partial<Incident>);
    await alerter.consider(broken);
    await alerter.consider(broken);
    expect(channel.got.filter((g) => g.startsWith('remediation_failed'))).toEqual([
      'remediation_failed:demo-agent: could not fix nonce 47 unfilled, 2 actions blocked — budget exhausted',
    ]);
  });

  // A restart can replay history. Announcing a problem that already ended would
  // send someone to look at nothing.
  it('does not announce an incident first seen already resolved', () => {
    expect(alertFor(incident({ status: 'resolved' }), undefined, T0)).toBeNull();
  });
});

describe('routing', () => {
  it('delivers only critical alerts until an operator says otherwise', () => {
    expect(selectRoutes(alertFor(incident(), undefined, T0)!)).toHaveLength(1);
    const warning = alertFor(incident({ severity: 'warning' }), undefined, T0)!;
    expect(selectRoutes(warning)).toEqual([]);
  });

  it('handles a quiet window that wraps midnight', () => {
    const quiet = { start: 22, end: 7 };
    expect(inQuietHours(new Date('2026-08-11T23:30:00Z'), quiet)).toBe(true);
    expect(inQuietHours(new Date('2026-08-11T03:00:00Z'), quiet)).toBe(true);
    expect(inQuietHours(new Date('2026-08-11T12:00:00Z'), quiet)).toBe(false);
    // Offsets shift the window, not the clock it is compared against.
    expect(inQuietHours(new Date('2026-08-11T18:00:00Z'), { ...quiet, utcOffsetHours: 5.5 })).toBe(true);
  });

  /**
   * Quiet hours suppress noise. Waking someone to say a thing broke and then
   * not telling them it fixed itself would be the worst of both.
   */
  it('lets a resolution through quiet hours, but not a warning', () => {
    const policy: RoutingPolicy = {
      routes: [{ channel: 'default', minSeverity: 'info', quietHours: { start: 22, end: 7 } }],
    };
    const night = new Date('2026-08-11T23:00:00Z');
    const warning = { ...alertFor(incident({ severity: 'warning' }), undefined, T0)!, firedAt: night };
    expect(selectRoutes(warning, policy)).toEqual([]);
    expect(selectRoutes({ ...warning, kind: 'resolved' }, policy)).toHaveLength(1);
    expect(selectRoutes({ ...warning, severity: 'critical' }, policy)).toHaveLength(1);
  });

  it('routes a channel that only wants resolutions', () => {
    const policy: RoutingPolicy = {
      routes: [{ channel: 'wins', minSeverity: 'info', kinds: ['resolved'] }],
    };
    const opened = alertFor(incident(), undefined, T0)!;
    expect(selectRoutes(opened, policy)).toEqual([]);
    expect(selectRoutes({ ...opened, kind: 'resolved' }, policy)).toHaveLength(1);
  });
});

describe('delivery', () => {
  it('keeps going when one channel is down, and does not re-announce for it', async () => {
    const good = collector('good');
    const bad: Channel = { name: 'bad', deliver: async () => Promise.reject(new Error('503')) };
    const policy: RoutingPolicy = {
      routes: [
        { channel: 'good', minSeverity: 'info' },
        { channel: 'bad', minSeverity: 'info' },
      ],
    };
    const errors: unknown[] = [];
    const alerter = new Alerter({
      channels: [good, bad],
      policy,
      now: () => T0,
      logger: { info: () => {}, error: (m) => errors.push(m) },
    });

    const first = await alerter.consider(incident());
    expect(first.delivered).toEqual(['good']);
    expect(first.failed).toEqual(['bad']);
    expect(errors).toHaveLength(1);

    // Remembered despite the failure: retrying the whole announcement because
    // one channel was down is how an alerter becomes the noise it prevents.
    const second = await alerter.consider(incident());
    expect(second.alert).toBeNull();
  });

  /**
   * A warning suppressed by policy is still *said* — otherwise the next tick
   * reconsiders it as new, and a warning held through the night becomes a page
   * the moment quiet hours end.
   */
  it('remembers an alert no route wanted', async () => {
    const channel = collector();
    const alerter = new Alerter({ channels: [channel], now: () => T0 });
    const suppressed = await alerter.consider(incident({ severity: 'warning' }));
    expect(suppressed.alert?.kind).toBe('opened');
    expect(suppressed.delivered).toEqual([]);
    expect((await alerter.consider(incident({ severity: 'warning' }))).alert).toBeNull();
  });

  it('posts to a webhook and fails loudly on a rejection', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const impl = vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const channel = webhookChannel({ url: 'https://hooks.example/x', fetchImpl: impl, render: discordRender });
    await channel.deliver(alertFor(incident(), undefined, T0)!);
    expect((calls[0]?.body as { content: string }).content).toContain('nonce 47 unfilled');

    const failing = webhookChannel({
      url: 'https://hooks.example/x',
      fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(failing.deliver(alertFor(incident(), undefined, T0)!)).rejects.toThrow(/500/);
  });

  /**
   * Their SendGrid action takes `useKeeperHubApiKey`, so email needs no
   * credentials from the operator — the one path that works with nothing
   * configured but the org key Blackbox already holds.
   */
  it('reuses one KeeperHub workflow rather than littering the org with them', async () => {
    const created: unknown[] = [];
    const executed: string[] = [];
    let listed: { id: string; name: string }[] = [];
    const client = {
      listWorkflows: async () => listed,
      createWorkflow: async (d: { name: string; nodes: unknown[]; edges: unknown[] }) => {
        created.push(d);
        listed = [{ id: 'wf-1', name: d.name }];
        return { id: 'wf-1' };
      },
      executeWorkflow: async (id: string) => {
        executed.push(id);
        return { executionId: 'exec-1' };
      },
    };
    const channel = keeperHubEmailChannel({ to: 'ops@example.com', client });
    const alert = alertFor(incident(), undefined, T0)!;
    await channel.deliver(alert);
    await channel.deliver(alert);

    expect(created).toHaveLength(1);
    expect(executed).toEqual(['wf-1', 'wf-1']);
    const node = (created[0] as { nodes: { data: { config: Record<string, unknown> } }[] }).nodes[1];
    expect(node?.data.config['useKeeperHubApiKey']).toBe(true);
    expect(node?.data.config['emailTo']).toBe('ops@example.com');

    // A fresh process finds the existing workflow instead of making another.
    const restarted = keeperHubEmailChannel({ to: 'ops@example.com', client });
    await restarted.deliver(alert);
    expect(created).toHaveLength(1);
  });

  it('says it in the log when nothing else is configured', async () => {
    const lines: string[] = [];
    const channel = logChannel({ info: (m) => lines.push(m) });
    await channel.deliver(alertFor(incident(), undefined, T0)!);
    expect(lines[0]).toContain('nonce 47 unfilled');
  });
});
