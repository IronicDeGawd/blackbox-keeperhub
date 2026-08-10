import { KIND_GLYPH, deriveKind, deriveLabel, simulationNote } from '../../lib/events';
import { explorerTxUrl } from '../../lib/explorer';
import { absoluteTime } from '../../lib/format';
import type { ChainConfig, IncidentEvent } from '../../lib/types';
import { CopyableAddress, ExplorerLink } from '../../ui/primitives';

/**
 * What happened, oldest first.
 *
 * Absolute timestamps rather than relative ones: this is a reconstruction of a
 * sequence, and "2m ago" on every row tells you nothing about the gaps between
 * them.
 */
export function EventTimeline({
  events,
  chains,
  chainId,
}: {
  events: IncidentEvent[];
  chains: ChainConfig[];
  chainId: number;
}): React.JSX.Element {
  const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return (
    <section className="panel section">
      <header className="section__head">
        <p className="eyebrow eyebrow--accent">Event timeline</p>
      </header>

      {ordered.length === 0 ? (
        <p className="soft section__empty">
          No events are linked to this incident. Detection can fire on chain state rather than on a
          recorded execution, in which case there is nothing to list here.
        </p>
      ) : (
        <ol className="events">
          {ordered.map((event) => {
            const kind = deriveKind(event);
            const url = explorerTxUrl(chains, chainId, event.txHash, event.explorerUrl);
            const note = simulationNote(event);

            return (
              <li className={`event event--${kind}`} key={event.id}>
                <span className={`event__glyph event__glyph--${kind}`} aria-hidden="true">
                  {KIND_GLYPH[kind]}
                </span>

                <div className="event__body">
                  <div className="event__line">
                    <span className="event__label">{deriveLabel(event)}</span>
                    <span className="event__kind">{kind}</span>
                  </div>

                  <div className="event__meta">
                    <time dateTime={event.at}>{absoluteTime(event.at)}</time>
                    {event.blockNumber !== null && event.blockNumber !== undefined ? (
                      <span>block {event.blockNumber}</span>
                    ) : null}
                    {note ? <span>{note}</span> : null}
                    {event.txHash ? (
                      url ? (
                        <ExplorerLink url={url}>{event.txHash.slice(0, 12)}…</ExplorerLink>
                      ) : (
                        <CopyableAddress value={event.txHash} kind="hash" />
                      )
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
