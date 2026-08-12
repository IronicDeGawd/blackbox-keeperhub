import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Node has no sessionStorage; the client reads one through ./session. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem = (key: string): string | null => this.map.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.map.set(key, value);
  removeItem = (key: string): void => void this.map.delete(key);
  clear = (): void => this.map.clear();
}
vi.stubGlobal('sessionStorage', new MemoryStorage());

import { api } from './api';
import { setSession } from './session';

/** The last request the client made, as the server would have received it. */
function lastCall(): { url: string; init: RequestInit; headers: Record<string, string> } {
  const mock = globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error('nothing was requested');
  return { url: call[0], init: call[1], headers: (call[1].headers ?? {}) as Record<string, string> };
}

beforeEach(() => {
  setSession(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
  );
});

/**
 * Fastify refuses a request that announces JSON and then sends nothing, so a
 * declared content-type on a bodyless call is not untidiness — it is a 500 on
 * every action that has nothing to say. Acknowledging an incident, unwatching
 * an address, signing out and running the demo are all of that shape.
 */
describe('declaring a content-type', () => {
  it('does not announce JSON when there is no body', async () => {
    await api.acknowledge('inc-1');
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().headers['content-type']).toBeUndefined();
  });

  it('leaves a bodyless DELETE bare as well', async () => {
    await api.unwatch('0xabc', 11155111);
    expect(lastCall().init.method).toBe('DELETE');
    expect(lastCall().headers['content-type']).toBeUndefined();
  });

  it('announces it whenever something is actually sent', async () => {
    await api.watchWorkflows([{ id: 'wf-1', name: 'one' }]);
    expect(lastCall().headers['content-type']).toBe('application/json');
    expect(lastCall().init.body).toContain('wf-1');
  });
});

describe('carrying the session', () => {
  it('sends nothing when signed out, because reading needs no account', async () => {
    await api.incidents();
    expect(lastCall().headers['authorization']).toBeUndefined();
  });

  it('sends the token once there is one', async () => {
    setSession({ token: 'bb_abc', orgId: 'org-1' });
    await api.connection();
    expect(lastCall().headers['authorization']).toBe('Bearer bb_abc');
  });
});
