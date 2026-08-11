import { useEffect } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { store, useConsole } from '../../lib/store';
import { timelineRoute, type TimelineSearch, type TimelineSearchPatch } from '../../routes/timeline';
import { SkeletonRows } from '../../ui/primitives';
import { Filters, activeFilterCount } from './Filters';
import { IncidentRow } from './IncidentRow';
import './timeline.css';

/**
 * The incident feed: newest first, live, and filtered by whatever is in the URL.
 *
 * Every empty result is not the same empty result. "Nothing has gone wrong" and
 * "your filters exclude everything" look identical if you only count rows, and
 * telling them apart is the difference between a quiet system and a mistake.
 */
export function Timeline(): React.JSX.Element {
  const search = timelineRoute.useSearch();
  const navigate = useNavigate();
  const { incidents, listStatus, error, connection, config, scan } = useConsole();

  const key = JSON.stringify(search);
  useEffect(() => {
    store.setFilters(JSON.parse(key) as TimelineSearch);
  }, [key]);

  /**
   * Clearing a filter removes the key from the URL rather than setting it to
   * undefined, so a shared link carries only the filters actually in effect.
   */
  const update = (patch: TimelineSearchPatch): void => {
    void navigate({
      to: '/timeline',
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
    void navigate({ to: '/timeline', search: {}, replace: true });
  };

  const filtered = activeFilterCount(search) > 0;
  const chains = config?.chains ?? [];
  const stale = connection === 'reconnecting' || connection === 'disconnected';

  return (
    <section className="page">
      <header className="pagehead">
        <p className="eyebrow eyebrow--accent eyebrow--ruled">Incident timeline</p>
        <div className="pagehead__row">
          <h1 className="pagehead__title">
            {incidents.length} incident{incidents.length === 1 ? '' : 's'}
            {filtered ? <span className="dim"> matching</span> : null}
          </h1>
          <span className="row__gap" />
          {scan ? (
            // Without this line "nothing has happened" and "nothing is running"
            // are the same screen.
            <span className="scanline" title="Block scanner progress">
              scanner at block {scan.toBlock} · {scan.watching} watched
            </span>
          ) : null}
          <button type="button" className="linkbutton" onClick={() => store.refresh()}>
            refresh
          </button>
        </div>
      </header>

      {stale ? (
        <div className="panel banner banner--stale" role="status">
          <strong>The feed is {connection === 'disconnected' ? 'down' : 'reconnecting'}.</strong>{' '}
          <span className="soft">
            What you see below is the last state received. The list is re-read automatically once
            the stream reopens.
          </span>
        </div>
      ) : null}

      <Filters search={search} chains={chains} onChange={update} onClear={clear} />

      <div className="feed">
        {listStatus === 'error' && error ? (
          <div className="panel panel--accent state" role="alert">
            <p className="state__lead">Could not load incidents.</p>
            {/* The detail line names what actually failed; showing anything
                vaguer here throws away the only useful part. */}
            <p className="soft">{error.detail}</p>
            {error.requestId ? <p className="dim mono">request {error.requestId}</p> : null}
            <button type="button" className="button" onClick={() => store.refresh()}>
              Retry
            </button>
          </div>
        ) : null}

        {listStatus === 'loading' && incidents.length === 0 ? <SkeletonRows count={5} /> : null}

        {listStatus === 'ready' && incidents.length === 0 && !filtered ? (
          <div className="panel state">
            <p className="state__lead">No incidents.</p>
            <p className="soft">
              Nothing has gone wrong on the chains being watched.
              {config?.capabilities.chaos ? (
                <>
                  {' '}
                  Induce one from the <Link to="/chaos">Chaos panel</Link>.
                </>
              ) : null}
            </p>
          </div>
        ) : null}

        {listStatus === 'ready' && incidents.length === 0 && filtered ? (
          <div className="panel state">
            <p className="state__lead">No incidents match these filters.</p>
            <p className="soft">
              Incidents exist, but none of them match. This is not the same as nothing having gone
              wrong.
            </p>
            <button type="button" className="button" onClick={clear}>
              Clear filters
            </button>
          </div>
        ) : null}

        {incidents.map((incident) => (
          <IncidentRow key={incident.id} incident={incident} chains={chains} />
        ))}
      </div>
    </section>
  );
}
