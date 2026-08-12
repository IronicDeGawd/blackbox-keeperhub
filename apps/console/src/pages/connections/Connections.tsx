import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { onSession, session } from '../../lib/session';
import { useConsole } from '../../lib/store';
import type { Connection, OfferedWorkflow } from '../../lib/types';
import { RelativeTime } from '../../ui/primitives';
import './connections.css';

/**
 * Connect a KeeperHub account, then say which of its workflows to watch.
 *
 * The second half is the part that matters and the part that is easy to leave
 * out: connecting alone watches nothing. An operator who authenticates and is
 * then shown no list has a connection that reads their audit trail for no
 * workflows at all, and no way to tell that from working.
 *
 * Picking a workflow is also the act of claiming its agent. That is safe only
 * because the server re-checks every id against the account's own workflows
 * before believing any of it — a token lists the workflows of the organisation
 * that issued it and nothing else. So the page never asks anyone to claim
 * anything twice.
 */
export function Connections(): React.JSX.Element {
  const { config } = useConsole();
  const [signedIn, setSignedIn] = useState(session() !== null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [offered, setOffered] = useState<OfferedWorkflow[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Asked twice: reconnecting means walking the whole OAuth flow again, and the
  // workflows this organisation had picked stop being read the moment it goes.
  const [confirming, setConfirming] = useState(false);

  useEffect(() => onSession((s) => setSignedIn(s !== null)), []);

  const loadConnection = useCallback(async (): Promise<void> => {
    if (!signedIn) return;
    try {
      setConnection(await api.connection());
    } catch (cause) {
      setError(cause as Error);
    }
  }, [signedIn]);

  useEffect(() => {
    void loadConnection();
  }, [loadConnection]);

  /**
   * Loaded on request, not on arrival: it costs a call to KeeperHub on their
   * quota, and an operator who came here to read the connection's state should
   * not spend one to do it.
   */
  const loadOffered = async (): Promise<void> => {
    setBusy('list');
    setError(null);
    try {
      const result = await api.offeredWorkflows();
      setOffered(result.workflows);
      setPicked(new Set(result.workflows.filter((w) => w.watched).map((w) => w.id)));
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string): void => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const save = async (): Promise<void> => {
    if (!offered) return;
    setBusy('save');
    setError(null);
    setNote(null);
    try {
      const added = offered.filter((w) => picked.has(w.id) && !w.watched);
      const removed = offered.filter((w) => !picked.has(w.id) && w.watched);

      if (added.length > 0) {
        const result = await api.watchWorkflows(added.map((w) => ({ id: w.id, name: w.name })));
        if (result.contested && result.contested.length > 0) {
          // Reported, not overridden: another tenant claimed it first, and the
          // honest answer is to say so rather than to take it.
          setNote(
            `Already claimed by another organisation, so left alone: ${result.contested.join(', ')}.`,
          );
        }
      }
      for (const workflow of removed) await api.unwatchWorkflow(workflow.id);

      await loadConnection();
      await loadOffered();
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (): Promise<void> => {
    setConfirming(false);
    setBusy('disconnect');
    setError(null);
    try {
      const result = await api.disconnect();
      setNote(result.note);
      setOffered(null);
      setPicked(new Set());
      await loadConnection();
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setBusy(null);
    }
  };

  const connections = config?.connections;
  const dirty =
    offered !== null && offered.some((w) => w.watched !== picked.has(w.id));

  if (connections && connections.available === false) {
    return (
      <div className="page">
        <h1 className="eyebrow eyebrow--ruled">Connections</h1>
        <p className="panel panel--accent notice">
          {connections.detail ?? 'This deployment does not offer KeeperHub connections.'}
        </p>
      </div>
    );
  }

  return (
    <div className="page connections">
      <h1 className="eyebrow eyebrow--ruled">KeeperHub connection</h1>

      <p className="connections__lead">
        Blackbox reads your KeeperHub audit trail to detect failures in the workflows you name
        below. It asks for <code>{connections?.scope ?? 'mcp:read'}</code> — reading only — and you
        authenticate on KeeperHub&rsquo;s own page, so no credential of yours is ever typed into
        this one.
      </p>

      {error ? (
        <p className="panel panel--accent notice connections__error" role="alert">
          {error instanceof ApiError ? error.detail : error.message}
        </p>
      ) : null}

      {note ? (
        <p className="panel notice" role="status">
          {note}
        </p>
      ) : null}

      {!signedIn ? (
        <p className="panel notice">
          Sign in first — the control is in the header. Connecting is per organisation, and
          Blackbox has to know whose it is before it can hold one.
        </p>
      ) : connection === null ? (
        <p className="connections__quiet">Reading…</p>
      ) : !connection.connected ? (
        <section className="panel notice connections__none">
          <p className="notice__lead">No KeeperHub account is connected.</p>
          <p>
            Use <strong>Connect KeeperHub</strong> in the header. It lasts{' '}
            {connections?.lifetimeDays?.default ?? 30} days, and every read extends it.
          </p>
        </section>
      ) : (
        <>
          <section className="panel connections__state">
            <dl className="connections__facts">
              <div>
                <dt>Status</dt>
                <dd className="mono">{connection.status}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd className="mono">{connection.scope}</dd>
              </div>
              <div>
                <dt>Connected</dt>
                <dd>
                  {connection.connectedAt ? <RelativeTime at={connection.connectedAt} /> : '—'}
                </dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{connection.expiresAt ? <RelativeTime at={connection.expiresAt} /> : '—'}</dd>
              </div>
              <div>
                <dt>Last read</dt>
                <dd>
                  {connection.lastSweptAt ? (
                    <RelativeTime at={connection.lastSweptAt} />
                  ) : (
                    <span className="dim">not yet</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Watching</dt>
                <dd className="num">{connection.watching.length}</dd>
              </div>
            </dl>

            {connection.lastError ? (
              <p className="connections__lasterror">
                Last error: <span className="mono">{connection.lastError}</span>
              </p>
            ) : null}
          </section>

          {/*
           * Said before it can be discovered the hard way. A connection that
           * watches nothing looks exactly like one that is working.
           */}
          {connection.watching.length === 0 ? (
            <p className="panel panel--accent notice">
              <span className="notice__lead">This connection watches nothing yet.</span>
              Choose at least one workflow below, or Blackbox reads your audit trail for nothing.
            </p>
          ) : null}

          <section>
            <h2 className="eyebrow eyebrow--ruled">Workflows</h2>

            {offered === null ? (
              <p className="connections__quiet">
                <button
                  type="button"
                  className="button"
                  onClick={() => void loadOffered()}
                  disabled={busy !== null}
                >
                  {busy === 'list' ? 'Asking KeeperHub…' : 'List my workflows'}
                </button>
                <span className="connections__aside">
                  One call to KeeperHub, on your quota — so it is not made until you ask.
                </span>
              </p>
            ) : offered.length === 0 ? (
              <p className="connections__quiet">This account has no workflows.</p>
            ) : (
              <>
                <ul className="connections__workflows">
                  {offered.map((workflow) => (
                    <li key={workflow.id} className="connections__workflow">
                      <label className="connections__pick">
                        <input
                          type="checkbox"
                          checked={picked.has(workflow.id)}
                          onChange={() => toggle(workflow.id)}
                          disabled={busy !== null}
                        />
                        <span className="connections__name">{workflow.name}</span>
                      </label>
                      <span className="connections__id mono">{workflow.id}</span>
                      {workflow.enabled === false ? (
                        <span className="pill">disabled at keeperhub</span>
                      ) : null}
                    </li>
                  ))}
                </ul>

                <div className="connections__actions">
                  <button
                    type="button"
                    className="button button--go"
                    onClick={() => void save()}
                    disabled={busy !== null || !dirty}
                    title={dirty ? undefined : 'Nothing has changed.'}
                  >
                    {busy === 'save' ? 'Saving…' : 'Save what is watched'}
                  </button>
                  <span className="connections__aside">
                    Watching a workflow claims its agent for this organisation, which is what makes
                    remediation of it yours to authorise.
                  </span>
                </div>
              </>
            )}
          </section>

          <section className="connections__danger">
            <h2 className="eyebrow eyebrow--ruled">Disconnect</h2>
            <p className="connections__quiet">
              Blackbox deletes its copy of the credential and stops reading.{' '}
              {connection.revocation === 'local_only'
                ? 'It cannot revoke it at KeeperHub — they expose no endpoint that would — so revoke it there too if that matters to you.'
                : null}
            </p>
            {confirming ? (
              <div className="connections__confirm" role="group" aria-label="Confirm disconnect">
                <span>
                  Disconnect, and stop reading {connection.watching.length} workflow
                  {connection.watching.length === 1 ? '' : 's'}?
                </span>
                <button
                  type="button"
                  className="button"
                  onClick={() => void disconnect()}
                  disabled={busy !== null}
                >
                  {busy === 'disconnect' ? 'Disconnecting…' : 'Yes, disconnect'}
                </button>
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => setConfirming(false)}
                  disabled={busy !== null}
                >
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="button"
                onClick={() => setConfirming(true)}
                disabled={busy !== null}
              >
                Disconnect this account
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
