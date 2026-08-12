import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These tests run in Node, which has no `sessionStorage` — the same condition
 * as a browser with storage switched off, which the module already has to
 * survive. A minimal stub keeps the tests about the session logic rather than
 * about the storage API.
 */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem = (key: string): string | null => this.map.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.map.set(key, value);
  removeItem = (key: string): void => void this.map.delete(key);
  clear = (): void => this.map.clear();
}
vi.stubGlobal('sessionStorage', new MemoryStorage());

import {
  adoptSessionFromFragment,
  authHeader,
  onSession,
  session,
  setSession,
  signedIn,
} from './session';

beforeEach(() => {
  sessionStorage.clear();
  setSession(null);
});

describe('holding a session', () => {
  it('starts with none, because reading needs no account', () => {
    expect(session()).toBeNull();
    expect(signedIn()).toBe(false);
    expect(authHeader()).toEqual({});
  });

  it('sends the token once there is one', () => {
    setSession({ token: 'bb_abc', orgId: 'org-9' });
    expect(authHeader()).toEqual({ authorization: 'Bearer bb_abc' });
  });

  it('survives a reload within the tab', () => {
    setSession({ token: 'bb_abc', orgId: 'org-9' });
    expect(JSON.parse(sessionStorage.getItem('blackbox.session') ?? '{}')).toMatchObject({
      token: 'bb_abc',
    });
  });

  it('is forgotten on sign-out, in storage as well as in memory', () => {
    setSession({ token: 'bb_abc', orgId: 'org-9' });
    setSession(null);
    expect(sessionStorage.getItem('blackbox.session')).toBeNull();
    expect(authHeader()).toEqual({});
  });

  it('tells the shell when it changes, so controls redraw', () => {
    const seen: (string | null)[] = [];
    const stop = onSession((s) => seen.push(s?.orgId ?? null));
    setSession({ token: 'bb_abc', orgId: 'org-9' });
    setSession(null);
    stop();
    setSession({ token: 'bb_zzz', orgId: 'ignored' });
    expect(seen).toEqual(['org-9', null]);
  });

  it('ignores a stored value that is not a session', () => {
    sessionStorage.setItem('blackbox.session', 'not json');
    // The read is guarded, so a corrupt value leaves the console signed out
    // rather than throwing on load.
    expect(() => authHeader()).not.toThrow();
    expect(authHeader()).toEqual({});
  });
});

describe('coming back from KeeperHub', () => {
  /**
   * The API puts the token in the fragment because browsers do not send
   * fragments to servers and proxies do not log them. The console's job is to
   * take it and erase it.
   */
  it('adopts a token handed back in the fragment', () => {
    const adopted = adoptSessionFromFragment({
      hash: '#token=bb_fromfragment&orgId=org-real',
      pathname: '/incidents',
      search: '',
    });

    expect(adopted).toEqual({ token: 'bb_fromfragment', orgId: 'org-real' });
    expect(signedIn()).toBe(true);
  });

  it('ignores a fragment that carries only half of it', () => {
    expect(
      adoptSessionFromFragment({ hash: '#token=bb_x', pathname: '/', search: '' }),
    ).toBeNull();
    expect(
      adoptSessionFromFragment({ hash: '#orgId=org-9', pathname: '/', search: '' }),
    ).toBeNull();
    expect(signedIn()).toBe(false);
  });

  it('ignores an ordinary anchor', () => {
    expect(adoptSessionFromFragment({ hash: '#main', pathname: '/', search: '' })).toBeNull();
    expect(adoptSessionFromFragment({ hash: '', pathname: '/', search: '' })).toBeNull();
  });

  it('handles a token containing url-escaped characters', () => {
    const adopted = adoptSessionFromFragment({
      hash: '#token=bb_a%2Bb&orgId=org%2F9',
      pathname: '/',
      search: '',
    });
    expect(adopted).toEqual({ token: 'bb_a+b', orgId: 'org/9' });
  });
});

describe('a tab with storage switched off', () => {
  it('still lets the page read, it just cannot remember', () => {
    const spy = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => setSession({ token: 'bb_abc', orgId: 'org-9' })).not.toThrow();
    expect(authHeader()).toEqual({ authorization: 'Bearer bb_abc' });
    spy.mockRestore();
  });
});
