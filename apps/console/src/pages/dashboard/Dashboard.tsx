import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { API_URL, api } from '../../lib/api';
import { useConsole } from '../../lib/store';
import { DemoButton } from '../../ui/DemoButton';
import { EventLog } from './EventLog';
import { Spend } from './Spend';
import { RelativeTime, RuleTag, SeverityDot, StatusPill } from '../../ui/primitives';
import type { Capabilities, IncidentSummary, LedgerVerification } from '../../lib/types';
import './dashboard.css';

/**
 * The console's own front door: what is happening, and everywhere worth going.
 *
 * This is where the working parts live — the live feed, the destinations, the
 * button that induces a failure. They used to sit on the front page, where they
 * asked somebody still deciding what this is to read an incident queue.
 *
 * Readable without an account on purpose. Signing in is what it takes to *act*
 * on an agent; being shown that the thing works should not cost a registration.
 */

type Destination = {
  to: string;
  label: string;
  line: string;
  needs?: keyof Capabilities;
};

const DESTINATIONS: Destination[] = [
  {
    to: '/timeline',
    label: 'Timeline',
    line: 'Every incident as it is detected, newest first, with the filters held in the URL so a view can be pasted to someone else.',
  },
  {
    to: '/incidents',
    label: 'Incidents',
    line: 'The same incidents as a table, with who resolved each one as its own column.',
  },
  {
    to: '/inspect',
    label: 'Inspect',
    line: 'Paste a transaction hash and get a verdict. No account, no setup, nothing to register first.',
  },
  {
    to: '/watched',
    label: 'Watched',
    line: 'The addresses being read, the agents behind them, and what each one is allowed to have fixed.',
  },
  {
    to: '/connections',
    label: 'Connections',
    line: 'Connect a KeeperHub account and choose which of its workflows Blackbox watches.',
    needs: 'connectKeeperHub',
  },
  {
    to: '/chaos',
    label: 'Chaos',
    line: 'Induce a real failure on a testnet, then watch it get caught, explained and fixed.',
    // `signChaos`, not `chaos`: the public deployment holds no key, so the
    // panel it *can* offer is the one the visitor signs themselves.
    needs: 'signChaos',
  },
];

/** The last few, newest first. Refetched whenever the stats strip moves. */
function Latest(): React.JSX.Element {
  const { stats } = useConsole();
  const [items, setItems] = useState<IncidentSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const pulse = stats ? JSON.stringify(stats.openBySeverity) + stats.remediations.total : '';

  useEffect(() => {
    let live = true;
    void api
      .incidents({ limit: 5 })
      .then((list) => {
        if (live) setItems(list.items);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [pulse]);

  return (
    <section className="panel dash__now">
      <h2 className="eyebrow eyebrow--accent dash__now-head">Caught most recently</h2>

      {failed ? (
        <p className="dash__empty">The feed is unreachable from here.</p>
      ) : items === null ? (
        <p className="dash__empty">Reading…</p>
      ) : items.length === 0 ? (
        <p className="dash__empty">Nothing detected yet.</p>
      ) : (
        <ul className="dash__list">
          {items.map((incident) => (
            <li key={incident.id} className="dash__item">
              <Link to="/incidents/$id" params={{ id: incident.id }} className="dash__link">
                <SeverityDot severity={incident.severity} />
                <span className="dash__class">{incident.class}</span>
              </Link>
              <p className="dash__summary">{incident.summary}</p>
              <span className="dash__facts">
                <RuleTag ruleId={incident.ruleId} />
                <StatusPill status={incident.status} />
                <RelativeTime at={incident.detectedAt} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {items && items.length > 0 ? (
        <Link to="/timeline" className="dash__all">
          All incidents, as they arrive →
        </Link>
      ) : null}
    </section>
  );
}

/**
 * Whether the remediation record can still be trusted.
 *
 * Any single entry names a transaction anybody can look up. This is the claim
 * a per-entry check cannot make: the entries are all of them, in the order
 * they happened, with nothing edited and nothing removed. One line, because it
 * only ever needs to be interesting when it is bad.
 */
function LedgerLine(): React.JSX.Element | null {
  const { stats } = useConsole();
  const [result, setResult] = useState<LedgerVerification | null>(null);
  // Re-checked whenever a remediation lands, since that is when it changes.
  const pulse = stats?.remediations.total ?? 0;

  useEffect(() => {
    let live = true;
    void api
      .ledger()
      .then((next) => {
        if (live) setResult(next);
      })
      .catch(() => {
        if (live) setResult(null);
      });
    return () => {
      live = false;
    };
  }, [pulse]);

  // Nothing to vouch for yet, and "0 entries verified" is not a reassurance.
  if (result === null || result.entries === 0) return null;

  return (
    <p className={`dash__ledger ${result.ok ? '' : 'dash__ledger--broken'}`} role="status">
      <span className="dash__ledger-mark" aria-hidden="true">
        {result.ok ? '✓' : '✕'}
      </span>
      {result.ok ? (
        <>
          Remediation record intact — {result.entries}{' '}
          {result.entries === 1 ? 'entry' : 'entries'}, each carrying the hash of the one before it.
        </>
      ) : (
        <>
          Remediation record broken at <span className="mono">{result.brokenAt}</span>. An entry has
          been changed or removed since it was written.
        </>
      )}{' '}
      <a href={`${API_URL}/api/ledger/verify`} target="_blank" rel="noreferrer">
        Check it yourself
      </a>
      {result.unchained > 0 ? (
        <span className="dash__ledger-note">
          {' '}
          ({result.unchained} recorded before the chain existed, and not claimed by it)
        </span>
      ) : null}
    </p>
  );
}

export function Dashboard(): React.JSX.Element {
  const { config } = useConsole();
  const capabilities = config?.capabilities ?? null;

  const visible = DESTINATIONS.filter(
    (destination) => !destination.needs || capabilities?.[destination.needs] !== false,
  );

  return (
    <div className="page dash">
      <header>
        <h1 className="eyebrow eyebrow--accent eyebrow--ruled">Console</h1>
      </header>

      <LedgerLine />

      <div className="dash__top">
        <Latest />

        {capabilities?.demo ? (
          <section className="panel dash__demo">
            <h2 className="eyebrow">Make one happen</h2>
            <p className="dash__demo-line">
              Runs a workflow that asks to spend beyond this organisation’s daily cap. KeeperHub
              refuses it before any chain is involved, so it costs no gas — and Blackbox reads the
              refusal from the audit trail.
            </p>
            <DemoButton />
          </section>
        ) : null}

        <Spend />
      </div>

      <EventLog />

      <section>
        <h2 className="eyebrow eyebrow--ruled">Everywhere else</h2>
        <ul className="dash__destinations">
          {visible.map((destination) => (
            <li key={destination.to} className="dash__destination">
              <Link to={destination.to} className="dash__destination-link">
                {destination.label}
              </Link>
              <p className="dash__destination-line">{destination.line}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
