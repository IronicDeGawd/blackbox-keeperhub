/**
 * Who the console is signed in as.
 *
 * Reading Blackbox needs no account — incidents, the timeline, the evidence and
 * the diagnosis are all public — so the console works perfectly well with no
 * session at all. Acting is different: remediating spends an organisation's
 * KeeperHub quota, its gas credits and its daily cap, so it needs the account
 * that owns the agent. This is the difference between a page that reads and a
 * page that spends.
 *
 * The token lives in `sessionStorage`, not `localStorage`: it is a bearer
 * credential, and one that survives until the tab closes is the shortest life
 * that still lets somebody click through a whole incident.
 */

const KEY = 'blackbox.session';

export type Session = { token: string; orgId: string; address?: string };

type Listener = (session: Session | null) => void;

const listeners = new Set<Listener>();
let current: Session | null = read();

function read(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return typeof parsed?.token === 'string' && parsed.token !== '' ? parsed : null;
  } catch {
    // A tab with storage disabled still reads Blackbox; it just cannot act.
    return null;
  }
}

export function session(): Session | null {
  return current;
}

export function signedIn(): boolean {
  return current !== null;
}

export function setSession(next: Session | null): void {
  current = next;
  try {
    if (next) sessionStorage.setItem(KEY, JSON.stringify(next));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Non-fatal: the session simply does not outlive this page.
  }
  for (const listener of listeners) listener(next);
}

/** Notifies on sign-in and sign-out, so the shell can redraw its controls. */
export function onSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The header to send, or nothing at all when nobody has signed in. */
export function authHeader(): Record<string, string> {
  return current ? { authorization: `Bearer ${current.token}` } : {};
}

/**
 * Read a session handed back in the URL fragment.
 *
 * "Connect KeeperHub" returns the operator here with `#token=…&orgId=…`. A
 * fragment rather than a query string because browsers do not send fragments to
 * servers and proxies do not log them — the same reasoning the API uses when it
 * puts it there. It is consumed and erased immediately, so a live credential
 * does not sit in the address bar or in the back-button history.
 */
export function adoptSessionFromFragment(location: {
  hash: string;
  pathname: string;
  search: string;
}): Session | null {
  if (!location.hash.startsWith('#')) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  const orgId = params.get('orgId');
  if (!token || !orgId) return null;

  const adopted: Session = { token, orgId };
  setSession(adopted);
  return adopted;
}
