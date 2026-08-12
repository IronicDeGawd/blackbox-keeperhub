import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

/**
 * The one thing a visitor with no account can *cause*.
 *
 * Reading a finished incident is not the same as watching one appear, and
 * everything else on the public deployment is read-only by design. This starts
 * real KeeperHub runs on Blackbox's own organisation, each asking to transfer
 * far beyond its daily spending cap — so their own spend controls refuse them
 * before any chain is involved. No gas, no value moved, somebody else's
 * organisation never touched.
 *
 * The cooldown is shared by everybody rather than per visitor, because it
 * exists to bound an execution quota. Shown as a countdown instead of a button
 * that fails, since "wait 12 minutes" is a better answer than a 429.
 */
export function DemoButton(): React.JSX.Element | null {
  const [state, setState] = useState<{ ready: boolean; nextAllowedAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    let live = true;
    const load = async (): Promise<void> => {
      try {
        const next = await api.demoState();
        if (live) setState(next);
      } catch {
        // A deployment with no organisation of its own does not serve this.
        if (live) setAvailable(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (!available || !state) return null;

  const run = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.runDemo();
      setMessage(
        `Started ${result.executionIds.length} runs. They will be refused before submission, and the incident appears here within a tick.`,
      );
      setState({ ready: false, nextAllowedAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    } catch (cause) {
      setMessage(cause instanceof ApiError ? cause.detail : 'Could not reach the API.');
      if (cause instanceof ApiError && cause.status === 429) setState({ ...state, ready: false });
    } finally {
      setBusy(false);
    }
  };

  const waitMinutes = Math.max(
    0,
    Math.ceil((Date.parse(state.nextAllowedAt) - Date.now()) / 60_000),
  );

  return (
    <div className="demo">
      <button
        type="button"
        className="button button--go"
        onClick={() => void run()}
        disabled={busy || !state.ready}
      >
        {busy ? 'Breaking something…' : 'Break something now'}
      </button>
      {/* Pressing this starts work somewhere else, and the only sign it worked
          is this text changing. Announced, or a screen reader gets silence from
          the one control on the page that does anything. */}
      <p className="demo__note" aria-live="polite">
        {state.ready
          ? 'Runs a workflow that asks to spend beyond this organisation’s daily cap. KeeperHub refuses it before any chain is involved, so it costs no gas — and Blackbox reads the refusal from the audit trail.'
          : `Already run. Available again in about ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'} — the limit is shared by everyone, because it bounds a real execution quota.`}
      </p>
      {message ? (
        <p className="demo__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
