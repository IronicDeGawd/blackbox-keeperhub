import { useEffect, useState } from 'react';
import { api, ApiError, API_URL } from '../lib/api';
import { onSession, session, setSession, type Session } from '../lib/session';
import { connectWallet, signMessage, walletAvailable } from '../lib/wallet';
import type { Capabilities } from '../lib/types';

/**
 * Sign in, or say who you are.
 *
 * Reading Blackbox needs no account, so this is never in the way: it is a
 * single control in the masthead that a visitor can ignore entirely. It
 * matters only when somebody wants to *act* — remediating spends an
 * organisation's KeeperHub quota and gas credits, so it answers only to the
 * organisation that owns the agent.
 *
 * "Connect" rather than "sign in with your key", because pasting an
 * organisation key into a third-party website means handing over a credential
 * that can execute transactions. The OAuth flow asks KeeperHub for reading
 * only, and the operator authenticates on KeeperHub's own page.
 */
export function SessionControl({
  capabilities,
}: {
  capabilities: Capabilities | null;
}): React.JSX.Element | null {
  const [live, setLive] = useState<Session | null>(session());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onSession(setLive), []);

  // Shown whenever there is any way to sign in at all: an operator connects
  // KeeperHub, a visitor proves their own address.
  if (live === null && capabilities?.connectKeeperHub !== true && !walletAvailable()) return null;

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const started = await api.connectUrl({ returnTo: window.location.pathname });
      // Their page, not ours: the operator's credential never touches Blackbox.
      window.location.assign(started.url);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.detail
          : `Could not reach ${API_URL}. Is the API running?`,
      );
      setBusy(false);
    }
  };

  /**
   * The other door, and the one a visitor uses.
   *
   * An agent that holds its own key belongs to no KeeperHub organisation, so
   * the address *is* the account: a signature proves it, and nothing else can.
   * Without this a visitor can induce a failure on their own wallet and then
   * be refused when they offer the signed fix, which is a demo that stops
   * halfway.
   */
  const signInWithWallet = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const wallet = await connectWallet();
      const challenge = await api.walletChallenge(wallet.address);
      const signature = await signMessage(challenge.message, wallet.address);
      await api.walletVerify(challenge.nonce, signature);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.detail : (cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.signOut();
    } finally {
      setSession(null);
      setBusy(false);
    }
  };

  if (live) {
    return (
      <span className="session">
        <span className="session__org" title={`Signed in as organisation ${live.orgId}`}>
          {live.orgId.slice(0, 8)}…
        </span>
        <button type="button" className="button button--quiet" onClick={signOut} disabled={busy}>
          Sign out
        </button>
      </span>
    );
  }

  return (
    <span className="session">
      {error ? <span className="session__error">{error}</span> : null}
      {capabilities?.connectKeeperHub === true ? (
        <button type="button" className="button button--quiet" onClick={connect} disabled={busy}>
          {busy ? 'Opening KeeperHub…' : 'Connect KeeperHub'}
        </button>
      ) : null}
      {walletAvailable() ? (
        <button
          type="button"
          className="button button--quiet"
          onClick={() => void signInWithWallet()}
          disabled={busy}
          title="Prove an address by signing a message. Nothing is sent to a chain."
        >
          Sign in with wallet
        </button>
      ) : null}
    </span>
  );
}
