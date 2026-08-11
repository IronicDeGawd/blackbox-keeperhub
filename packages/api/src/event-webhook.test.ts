import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './bus.js';
import { EventWebhook, signPayload } from './event-webhook.js';

const T0 = new Date('2026-08-11T12:00:00.000Z');

const receiver = (status = 200) => {
  const calls: { body: string; headers: Record<string, string> }[] = [];
  const impl = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ body: init.body, headers: init.headers });
    return new Response('', { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
};

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('raw event delivery', () => {
  it('pushes every event the bus carries, unedited', async () => {
    const bus = new EventBus();
    const r = receiver();
    new EventWebhook({ url: 'https://ops.test/hook', fetchImpl: r.impl, now: () => T0 }).attach(bus);

    bus.publish({ type: 'incident.created', data: { id: 'inc-1', severity: 'warning' } });
    bus.publish({ type: 'remediation.succeeded', data: { incidentId: 'inc-1' } });
    await settle();

    expect(r.calls).toHaveLength(2);
    // Unedited: a warning is delivered even though the alerter would suppress
    // it at the default severity floor. Different question, different answer.
    expect(JSON.parse(r.calls[0]!.body)).toEqual({
      type: 'incident.created',
      data: { id: 'inc-1', severity: 'warning' },
      at: T0.toISOString(),
    });
    expect(r.calls[0]!.headers['X-Blackbox-Event']).toBe('incident.created');
  });

  it('signs the body with a timestamp inside the signed string', async () => {
    const bus = new EventBus();
    const r = receiver();
    new EventWebhook({
      url: 'https://ops.test/hook',
      secret: 'shh',
      fetchImpl: r.impl,
      now: () => T0,
    }).attach(bus);

    bus.publish({ type: 'incident.created', data: { id: 'inc-1' } });
    await settle();

    const header = r.calls[0]!.headers['X-Blackbox-Signature']!;
    const [tPart, vPart] = header.split(',');
    const t = tPart!.slice(2);
    const expected = createHmac('sha256', 'shh').update(`${t}.${r.calls[0]!.body}`).digest('hex');
    expect(vPart).toBe(`v1=${expected}`);
    expect(Number(t)).toBe(Math.floor(T0.getTime() / 1000));
  });

  // Replaying a captured delivery with a newer timestamp breaks the signature,
  // because the timestamp is part of what was signed.
  it('cannot have its timestamp swapped without breaking the signature', () => {
    const body = JSON.stringify({ type: 'incident.created' });
    const original = signPayload(body, 'shh', T0);
    const later = signPayload(body, 'shh', new Date(T0.getTime() + 60_000));
    expect(original).not.toBe(later);
    expect(original.split('v1=')[1]).not.toBe(later.split('v1=')[1]);
  });

  it('sends only the types asked for', async () => {
    const bus = new EventBus();
    const r = receiver();
    new EventWebhook({
      url: 'https://ops.test/hook',
      types: ['incident.created'],
      fetchImpl: r.impl,
    }).attach(bus);

    bus.publish({ type: 'incident.created', data: {} });
    bus.publish({ type: 'scan.progress', data: {} });
    await settle();

    expect(r.calls).toHaveLength(1);
  });

  it('counts a failing receiver instead of throwing into the publisher', async () => {
    const bus = new EventBus();
    const r = receiver(500);
    const hook = new EventWebhook({
      url: 'https://ops.test/hook',
      fetchImpl: r.impl,
      logger: { info: () => {}, error: () => {} },
    });
    hook.attach(bus);

    expect(() => bus.publish({ type: 'incident.created', data: {} })).not.toThrow();
    await settle();
    expect(hook.stats).toMatchObject({ delivered: 0, failed: 1 });
  });

  /**
   * A dead receiver must not become this process's problem. An unbounded queue
   * of pending fetches is how a webhook takes down the thing it was watching.
   */
  it('drops rather than queues without limit when the receiver stalls', async () => {
    const bus = new EventBus();
    let release: (() => void) | undefined;
    const impl = (async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const hook = new EventWebhook({
      url: 'https://ops.test/hook',
      fetchImpl: impl,
      maxInFlight: 2,
      logger: { info: () => {}, error: () => {} },
    });
    hook.attach(bus);

    for (let i = 0; i < 5; i++) bus.publish({ type: 'incident.created', data: { i } });
    await settle();

    // Two in flight, three refused and counted rather than silently lost.
    expect(hook.stats.dropped).toBe(3);
    release?.();
  });

  it('stops delivering once detached', async () => {
    const bus = new EventBus();
    const r = receiver();
    const hook = new EventWebhook({ url: 'https://ops.test/hook', fetchImpl: r.impl });
    const detach = hook.attach(bus);
    detach();
    bus.publish({ type: 'incident.created', data: {} });
    await settle();
    expect(r.calls).toHaveLength(0);
  });
});
