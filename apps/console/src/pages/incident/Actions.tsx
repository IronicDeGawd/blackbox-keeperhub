import { useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { chainName } from '../../lib/explorer';
import { store } from '../../lib/store';
import { onSession, signedIn as isSignedIn } from '../../lib/session';
import type { Capabilities, ChainConfig, IncidentDetail, RemediateResponse } from '../../lib/types';

/**
 * The two things an operator can do from this page.
 *
 * Remediating spends real gas, so it is confirmed against the named chain
 * first — an unconfirmed button that moves funds is not a button, it is a trap.
 *
 * A guard refusal comes back as a 200 with the guards that blocked it. It is
 * rendered here, in place, at full weight, because it is the outcome and not an
 * error: Blackbox declining to act with a stated reason is the system working.
 */
export function Actions({
  incident,
  capabilities,
  chains,
  onChanged,
}: {
  incident: IncidentDetail;
  capabilities: Capabilities | null;
  chains: ChainConfig[];
  onChanged: () => void;
}): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'acknowledge' | 'remediate' | null>(null);
  const [result, setResult] = useState<RemediateResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const [signedIn, setSignedIn] = useState(isSignedIn());
  useEffect(() => onSession((s) => setSignedIn(s !== null)), []);

  const settled = incident.status === 'resolved' || incident.status === 'acknowledged';
  const canRemediate = capabilities?.remediate === true;
  /**
   * Acting spends: a remediation consumes an organisation's KeeperHub quota,
   * its gas credits and its daily cap, so the API answers only to the account
   * that owns the agent. Said here rather than discovered by pressing a button
   * that returns 403.
   */
  const canAct = signedIn;


  if (settled && !canRemediate) return null;

  const acknowledge = async (): Promise<void> => {
    setBusy('acknowledge');
    setError(null);
    try {
      const updated = await api.acknowledge(incident.id);
      store.apply(updated);
      onChanged();
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause);
    } finally {
      setBusy(null);
    }
  };

  const remediate = async (): Promise<void> => {
    setBusy('remediate');
    setError(null);
    setConfirming(false);
    try {
      setResult(await api.remediate(incident.id));
      onChanged();
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel section actions">
      <header className="section__head">
        <h2 className="eyebrow eyebrow--accent">Actions</h2>
      </header>

      {!canAct ? (
        <p className="actions__note">
          Connect your KeeperHub account to act on this incident. Reading it needs no
          account; acknowledging or remediating answers to the organisation that owns{' '}
          <span className="mono">{incident.agentId}</span>.
        </p>
      ) : null}

      <div className="actions__row">
        {!settled ? (
          <button
            type="button"
            className="button"
            onClick={() => void acknowledge()}
            disabled={busy !== null || !canAct}
          >
            {busy === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge'}
          </button>
        ) : null}

        {canRemediate && !confirming ? (
          <button
            type="button"
            className="button"
            onClick={() => setConfirming(true)}
            disabled={busy !== null || !canAct}
          >
            Remediate now
          </button>
        ) : null}

        {canRemediate && confirming ? (
          <div className="confirm">
            <span className="confirm__text">
              This submits a transaction on <strong>{chainName(chains, incident.chainId)}</strong>{' '}
              and spends real gas.
            </span>
            <button
              type="button"
              className="button button--go"
              onClick={() => void remediate()}
              disabled={busy !== null}
            >
              {busy === 'remediate' ? 'Submitting…' : 'Confirm and remediate'}
            </button>
            <button type="button" className="linkbutton" onClick={() => setConfirming(false)}>
              cancel
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="panel panel--accent state" role="alert">
          <p className="state__lead">The request failed.</p>
          <p className="soft">{error.detail}</p>
        </div>
      ) : null}

      {result && result.accepted ? (
        <p className="soft">
          Accepted. Playbook <span className="mono">{result.playbookId}</span> is running; this page
          updates as it progresses.
        </p>
      ) : null}

      {result && !result.accepted ? (
        <div className="refusal">
          <p className="refusal__lead">
            Blackbox declined to act
            {result.playbookId ? (
              <>
                {' '}
                on <span className="mono">{result.playbookId}</span>
              </>
            ) : null}
            .
          </p>
          <p className="soft">
            This is the automation refusing with a reason, not a failure. The guards below stopped
            it.
          </p>
          <ul className="refusal__guards">
            {(result.guardsFailed ?? []).map((failure) => (
              <li key={failure.guard}>
                <span className="guard guard--failed">{failure.guard}</span>
                <span className="soft"> {failure.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
