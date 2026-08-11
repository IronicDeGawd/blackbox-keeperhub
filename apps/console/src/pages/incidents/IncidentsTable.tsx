import { useEffect } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { chainName, explorerTxUrl } from '../../lib/explorer';
import { formatConfidence } from '../../lib/format';
import { store, useConsole } from '../../lib/store';
import { incidentsRoute } from '../../routes/incidents';
import type { TimelineSearch, TimelineSearchPatch } from '../../routes/timeline';
import { CopyableAddress, ExplorerLink, RelativeTime, StatusPill } from '../../ui/primitives';
import { Filters, activeFilterCount } from '../timeline/Filters';

/**
 * The same incidents as the timeline, as a table.
 *
 * The timeline is for watching; this is for comparing. It reads the same filter
 * state out of the URL, so switching between the two views keeps the view.
 */
export function IncidentsTable(): React.JSX.Element {
  const search = incidentsRoute.useSearch();
  const navigate = useNavigate();
  const { incidents, listStatus, error, config } = useConsole();

  const key = JSON.stringify(search);
  useEffect(() => {
    store.setFilters(JSON.parse(key) as TimelineSearch);
  }, [key]);

  const update = (patch: TimelineSearchPatch): void => {
    void navigate({
      to: '/incidents',
      search: (previous) => {
        const next: Record<string, unknown> = { ...previous };
        for (const [field, value] of Object.entries(patch)) {
          if (value === undefined || value === '') delete next[field];
          else next[field] = value;
        }
        return next as TimelineSearch;
      },
      replace: true,
    });
  };

  const clear = (): void => {
    void navigate({ to: '/incidents', search: {}, replace: true });
  };

  const chains = config?.chains ?? [];
  const filtered = activeFilterCount(search) > 0;

  return (
    <section className="page">
      <header className="pagehead">
        <p className="eyebrow eyebrow--accent eyebrow--ruled">Incidents</p>
        <div className="pagehead__row">
          <h1 className="pagehead__title">
            {incidents.length} incident{incidents.length === 1 ? '' : 's'}
            {filtered ? <span className="dim"> matching</span> : null}
          </h1>
          <span className="row__gap" />
          <Link to="/timeline" className="linkbutton">
            open the timeline
          </Link>
        </div>
      </header>

      <Filters search={search} chains={chains} onChange={update} onClear={clear} />

      {listStatus === 'error' && error ? (
        <div className="panel panel--accent state" role="alert">
          <p className="state__lead">Could not load incidents.</p>
          <p className="soft">{error.detail}</p>
          <button type="button" className="button" onClick={() => store.refresh()}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="feed">
        {incidents.length === 0 && listStatus === 'ready' ? (
          <div className="state">
            <p className="state__lead">
              {filtered ? 'No incidents match these filters.' : 'No incidents.'}
            </p>
            {filtered ? (
              <button type="button" className="button" onClick={clear}>
                Clear filters
              </button>
            ) : null}
          </div>
        ) : (
          <div className="tablewrap">
            <table className="listing">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Class</th>
                  <th>Rule</th>
                  <th>Agent</th>
                  <th>Signer</th>
                  <th>Chain</th>
                  <th>Conf.</th>
                  <th>Detected</th>
                  <th>Status</th>
                  <th>Fixed by</th>
                  <th>Remediation</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((incident) => {
                  const url = explorerTxUrl(
                    chains,
                    incident.chainId,
                    incident.remediationTxHash,
                    incident.explorerUrl,
                  );
                  return (
                    <tr key={incident.id}>
                      <td className={`row__sev--${incident.severity}`}>{incident.severity}</td>
                      <td>
                        <Link to="/incidents/$id" params={{ id: incident.id }} className="classbadge">
                          {incident.class}
                        </Link>
                      </td>
                      <td className="dim">{incident.ruleId}</td>
                      <td>{incident.agentId}</td>
                      <td>
                        <CopyableAddress value={incident.signer} />
                      </td>
                      <td>{chainName(chains, incident.chainId)}</td>
                      <td className="num">{formatConfidence(incident.confidence)}</td>
                      <td>
                        <RelativeTime at={incident.detectedAt} />
                      </td>
                      <td>
                        <StatusPill status={incident.status} />
                      </td>
                      {/* Attribution stays its own column: a fix a human signed
                          is not the same claim as an autonomous one. */}
                      <td className={incident.resolvedBy === 'blackbox' ? 'ok' : 'dim'}>
                        {incident.resolvedBy ?? '—'}
                      </td>
                      <td>
                        {url && incident.remediationTxHash ? (
                          <ExplorerLink url={url}>
                            {incident.remediationStatus ?? 'tx'}
                          </ExplorerLink>
                        ) : (
                          <span className="dim">{incident.remediationStatus ?? '—'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
