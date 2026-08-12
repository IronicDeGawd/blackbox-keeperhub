import { describe, expect, it } from 'vitest';
import { KeeperHubClient } from './client.js';
import { rateLimitRemaining, retryAfterMs } from './rate-limit.js';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const headers = (bag: Record<string, string>) => new Headers(bag);

describe('reading a rate limiter', () => {
  it('takes Retry-After in seconds', () => {
    expect(retryAfterMs(headers({ 'retry-after': '3' }), NOW)).toBe(3000);
  });

  it('takes Retry-After as an HTTP-date', () => {
    const at = new Date(NOW + 5000).toUTCString();
    expect(retryAfterMs(headers({ 'retry-after': at }), NOW)).toBe(5000);
  });

  it('never asks for a wait in the past', () => {
    const at = new Date(NOW - 60_000).toUTCString();
    expect(retryAfterMs(headers({ 'retry-after': at }), NOW)).toBe(0);
    expect(retryAfterMs(headers({ 'retry-after': '-9' }), NOW)).toBe(0);
  });

  it('falls back to the window reset, read as an epoch', () => {
    const reset = String(Math.floor(NOW / 1000) + 12);
    expect(retryAfterMs(headers({ 'x-ratelimit-reset': reset }), NOW)).toBe(12_000);
  });

  it('reads a small reset as seconds from now, not as 1970', () => {
    expect(retryAfterMs(headers({ 'x-ratelimit-reset': '8' }), NOW)).toBe(8000);
  });

  it('prefers Retry-After when both are present', () => {
    const both = headers({ 'retry-after': '2', 'x-ratelimit-reset': '900' });
    expect(retryAfterMs(both, NOW)).toBe(2000);
  });

  it('says nothing when the response says nothing', () => {
    expect(retryAfterMs(headers({}), NOW)).toBeNull();
    expect(retryAfterMs(headers({ 'retry-after': '' }), NOW)).toBeNull();
    expect(retryAfterMs(headers({ 'retry-after': 'soon' }), NOW)).toBeNull();
  });

  it('reports what is left of the quota, when told', () => {
    expect(rateLimitRemaining(headers({ 'x-ratelimit-remaining': '0' }))).toBe(0);
    expect(rateLimitRemaining(headers({ 'x-ratelimit-remaining': '17' }))).toBe(17);
    expect(rateLimitRemaining(headers({}))).toBeNull();
  });
});

describe('a client that has been rate limited', () => {
  /** Answers 429 for the first `limited` calls, then succeeds. */
  const provider = (limited: number, headerBag: Record<string, string>) => {
    const calls: string[] = [];
    let seen = 0;
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (seen++ < limited) {
        return new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: headerBag,
        });
      }
      return new Response(JSON.stringify([{ id: 'wf-1', name: 'Rebalance' }]), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };

  const client = (
    over: { limited: number; headers: Record<string, string> },
    slept: number[],
  ) => {
    const { fetchImpl, calls } = provider(over.limited, over.headers);
    return {
      calls,
      instance: new KeeperHubClient({
        baseUrl: 'https://provider.test/api',
        orgKey: 'kh_test',
        fetchImpl,
        nowImpl: () => NOW,
        sleepImpl: async (ms) => {
          slept.push(ms);
        },
      }),
    };
  };

  it('waits exactly as long as it was asked to, then succeeds', async () => {
    const slept: number[] = [];
    const { instance, calls } = client({ limited: 1, headers: { 'retry-after': '4' } }, slept);

    await expect(instance.listWorkflows()).resolves.toHaveLength(1);
    expect(slept).toEqual([4000]);
    expect(calls).toHaveLength(2);
  });

  it('gives up rather than sleeping longer than a tick', async () => {
    const slept: number[] = [];
    const { instance, calls } = client({ limited: 1, headers: { 'retry-after': '600' } }, slept);

    await expect(instance.listWorkflows()).rejects.toThrow();
    expect(slept).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('stops retrying rather than looping on a limiter that never lets go', async () => {
    const slept: number[] = [];
    const { instance, calls } = client({ limited: 99, headers: { 'retry-after': '1' } }, slept);

    await expect(instance.listWorkflows()).rejects.toThrow();
    // Two waits, three calls: the original and two retries.
    expect(slept).toEqual([1000, 1000]);
    expect(calls).toHaveLength(3);
  });

  it('does not retry a limiter that said nothing, since the delay would be invented', async () => {
    const slept: number[] = [];
    const { instance, calls } = client({ limited: 1, headers: {} }, slept);

    await expect(instance.listWorkflows()).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('will not repeat a write that carries no idempotency key', async () => {
    // Sending a transfer twice pays twice. A rate limit is not a good enough
    // reason to risk that, so it surfaces instead.
    const slept: number[] = [];
    const { fetchImpl, calls } = provider(1, { 'retry-after': '1' });
    const instance = new KeeperHubClient({
      baseUrl: 'https://provider.test/api',
      orgKey: 'kh_test',
      fetchImpl,
      nowImpl: () => NOW,
      sleepImpl: async (ms) => {
        slept.push(ms);
      },
    });

    await expect(
      instance.transfer({ network: 'sepolia', recipientAddress: '0xabc', amount: '1' }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('does repeat a write that carries one, because the key makes it safe', async () => {
    const slept: number[] = [];
    const { fetchImpl, calls } = provider(1, { 'retry-after': '1' });
    const instance = new KeeperHubClient({
      baseUrl: 'https://provider.test/api',
      orgKey: 'kh_test',
      fetchImpl,
      nowImpl: () => NOW,
      sleepImpl: async (ms) => {
        slept.push(ms);
      },
    });

    // The success body here is not a real execution, so the call still
    // rejects — what is being pinned is that it was sent a second time.
    await instance
      .transfer({
        network: 'sepolia',
        recipientAddress: '0xabc',
        amount: '1',
        idempotencyKey: 'fix-inc-1',
      })
      .catch(() => undefined);
    expect(slept).toEqual([1000]);
    expect(calls).toHaveLength(2);
  });
});
