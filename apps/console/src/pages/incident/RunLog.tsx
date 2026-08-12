import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { explorerTxUrl } from '../../lib/explorer';
import type { ChainConfig, RunLogEntry } from '../../lib/types';
import { CopyableAddress, ExplorerLink } from '../../ui/primitives';

/**
 * The steps behind the run, from KeeperHub's own record of it.
 *
 * The incident says something failed. This says *which step, and what it said*
 * — the question anybody asks next, and one the page used to answer by sending
 * the operator to another dashboard to read data we already hold.
 *
 * Only the organisation that owns the agent may read this, so a refusal is
 * ordinary rather than an error: a visitor looking at a public incident simply
 * sees nothing here. The panel appears when there is something in it.
 */
export function RunLog({
  incidentId,
  chains,
  chainId,
  refreshKey,
}: {
  incidentId: string;
  chains: ChainConfig[];
  chainId: number;
  /** Changes when the incident is touched, so the log follows a live run. */
  refreshKey: string | number | null;
}): React.JSX.Element | null {
  const [runs, setRuns] = useState<RunLogEntry[] | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await api.runLog(incidentId);
      setRuns(next.runs);
      setDenied(false);
    } catch (cause) {
      // 401/403 is "not yours", 409 is "no connection". Neither is worth
      // reporting: the panel is additional detail, not the page.
      if (cause instanceof ApiError) setDenied(true);
    }
  }, [incidentId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (denied || runs === null || runs.length === 0) return null;

  return (
    <section className="panel section">
      <header className="section__head">
        <h2 className="eyebrow eyebrow--accent">Run log</h2>
        <p className="soft runlog__note">
          {runs.length === 1 ? 'The run' : `The ${runs.length} runs`} behind this incident, step by
          step, as KeeperHub recorded {runs.length === 1 ? 'it' : 'them'}.
        </p>
      </header>

      <ol className="runlog">
        {runs.map((run) => (
          <li className="runlog__run" key={run.executionId}>
            <div className="runlog__run-head">
              <span className="mono runlog__id">{run.executionId}</span>
              <span className={`runlog__status runlog__status--${statusKind(run.status)}`}>
                {run.status}
              </span>
            </div>

            {run.error ? <p className="runlog__error">{run.error}</p> : null}

            {run.steps.length === 0 ? (
              <p className="soft">No steps were recorded for this run.</p>
            ) : (
              <ol className="runlog__steps">
                {run.steps.map((step, index) => {
                  const url = explorerTxUrl(chains, chainId, step.txHash, null);
                  return (
                    <li
                      className={`runlog__step runlog__step--${statusKind(step.status)}`}
                      key={`${step.nodeId}-${index}`}
                    >
                      <span className="runlog__node">{step.nodeId}</span>
                      <span className="runlog__type mono">{step.nodeType}</span>
                      <span className="runlog__step-status">{step.status}</span>
                      <span className="runlog__gas num">
                        {step.gasUsed === null ? '—' : `${step.gasUsed} gas`}
                        {step.sponsored ? ' · sponsored' : ''}
                      </span>
                      <span className="runlog__tx">
                        {step.txHash === null ? (
                          <span className="soft">no transaction</span>
                        ) : url ? (
                          <ExplorerLink url={url}>{step.txHash.slice(0, 12)}…</ExplorerLink>
                        ) : (
                          <CopyableAddress value={step.txHash} kind="hash" />
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Three buckets, because KeeperHub's status strings are its own vocabulary and
 * the stylesheet should not have to know all of it.
 */
function statusKind(status: string): 'good' | 'bad' | 'other' {
  const value = status.toLowerCase();
  if (value === 'success' || value === 'completed') return 'good';
  if (value === 'failed' || value === 'error' || value === 'unavailable') return 'bad';
  return 'other';
}
