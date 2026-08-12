import { describe, expect, it, vi } from 'vitest';

/** The module reaches the store, which reaches the session, which reads storage. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem = (key: string): string | null => this.map.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.map.set(key, value);
  removeItem = (key: string): void => void this.map.delete(key);
  clear = (): void => this.map.clear();
}
vi.stubGlobal('sessionStorage', new MemoryStorage());

import { callToAction } from './Landing';
import type { AppConfig, ConnectionsConfig } from '../../lib/types';

const configWith = (connections: ConnectionsConfig | undefined): AppConfig =>
  ({ ...(connections ? { connections } : {}) }) as AppConfig;

/**
 * The front page has one action, and it is the same element in every state, so
 * getting the state wrong tells the reader the page does not know who they are.
 */
describe('the one action on the front page', () => {
  it('asks a visitor to connect', () => {
    expect(callToAction(configWith({ available: true, sweepsOwnOrg: true, mine: null }))).toEqual({
      to: '/connections',
      label: 'Connect your KeeperHub account',
    });
  });

  it('asks somebody connected but watching nothing to choose', () => {
    const mine = { status: 'active', expiresAt: '2026-09-01T00:00:00Z', watching: 0 };
    expect(callToAction(configWith({ available: true, sweepsOwnOrg: true, mine }))).toEqual({
      to: '/connections',
      label: 'Choose what it watches',
    });
  });

  it('sends somebody already watching into the console', () => {
    const mine = { status: 'active', expiresAt: '2026-09-01T00:00:00Z', watching: 3 };
    expect(callToAction(configWith({ available: true, sweepsOwnOrg: true, mine }))).toEqual({
      to: '/dashboard',
      label: 'Open the console',
    });
  });

  it('offers nothing where the deployment cannot hold a connection', () => {
    expect(callToAction(configWith({ available: false, sweepsOwnOrg: false }))).toBeNull();
    expect(callToAction(configWith(undefined))).toBeNull();
    expect(callToAction(null)).toBeNull();
  });
});
