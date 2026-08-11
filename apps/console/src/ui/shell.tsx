import { Link } from '@tanstack/react-router';
import { EM_DASH, formatMean, formatWei } from '../lib/format';
import type { Capabilities, ChainConfig, ConnectionState, Stats } from '../lib/types';

/**
 * The pieces of the frame. All three answer a question an operator should never
 * have to go looking for: is this feed live, which chain is this, and how much
 * has been detected and spent.
 */

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'connecting',
  connected: 'live',
  reconnecting: 'reconnecting',
  disconnected: 'feed down',
};

export function ConnectionDot({ state }: { state: ConnectionState }): React.JSX.Element {
  return (
    <span className={`live live--${state}`} title={`Event stream: ${CONNECTION_LABEL[state]}`}>
      <span className="live__dot" aria-hidden="true" />
      <span>{CONNECTION_LABEL[state]}</span>
    </span>
  );
}

export function ChainBanner({ chains }: { chains: ChainConfig[] }): React.JSX.Element | null {
  if (chains.length === 0) return null;

  return (
    <div className="chains">
      {chains.map((chain) => (
        <span
          key={chain.chainId}
          className={chain.testnet ? 'chain' : 'chain chain--live'}
          title={`chain id ${chain.chainId}`}
        >
          {chain.name}
          <span className="chain__tag">{chain.testnet ? 'testnet' : 'mainnet'}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * A mainnet Blackbox can *spend on* gets its own line, not just a differently
 * coloured chip. The difference between a testnet and a mainnet is the whole of
 * the risk.
 *
 * Keyed on the remediation chain allowlist rather than on the chain list,
 * because those are two different facts. A mainnet is usually configured so
 * that a transaction on it can be read and explained; remediation reaches only
 * the chains named in the allowlist. Warning about the first as though it were
 * the second is a false alarm, and a banner that cries wolf on every page load
 * is one nobody reads on the day it is true.
 */
export function MainnetWarning({
  chains,
  remediableChainIds,
}: {
  chains: ChainConfig[];
  remediableChainIds: number[];
}): React.JSX.Element | null {
  const spendable = chains.filter(
    (chain) => !chain.testnet && remediableChainIds.includes(chain.chainId),
  );
  if (spendable.length === 0) return null;

  return (
    <div className="mainnet-warning" role="alert">
      <strong>MAINNET REMEDIATION ENABLED</strong>
      <span>
        {spendable.map((chain) => chain.name).join(', ')} — a fix submitted here spends real funds.
      </span>
    </div>
  );
}

function Part({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'crit' | 'warn' | 'ok';
}): React.JSX.Element {
  const zero = value === 0 || value === '0';
  return (
    <span className="stat__part">
      <span className={[tone ?? '', zero ? 'stat__zero' : ''].filter(Boolean).join(' ')}>
        {value}
      </span>
      <span className="stat__part-label">{label}</span>
    </span>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">{children}</div>
    </div>
  );
}

export function StatsStrip({ stats }: { stats: Stats | null }): React.JSX.Element {
  const open = stats?.openBySeverity;
  const rem = stats?.remediations;

  return (
    <div className="stats">
      <Cell label="Open incidents">
        <Part label="crit" value={open?.critical ?? EM_DASH} tone="crit" />
        <Part label="warn" value={open?.warning ?? EM_DASH} tone="warn" />
        <Part label="info" value={open?.info ?? EM_DASH} />
      </Cell>

      <Cell label="Remediations">
        <Part label="total" value={rem?.total ?? EM_DASH} />
        <Part label="ok" value={rem?.succeeded ?? EM_DASH} tone="ok" />
        <Part label="skipped" value={rem?.skipped ?? EM_DASH} />
        <Part label="failed" value={rem?.failed ?? EM_DASH} tone="crit" />
      </Cell>

      <Cell label="Gas spent">{rem ? formatWei(rem.gasWei) : EM_DASH}</Cell>

      {/* Both means are an em dash when nothing qualifies. Zero would read as
          instant detection, which is a claim the data does not make. */}
      <Cell label="Mean time to detection">{formatMean(stats?.meanTimeToDetectionMs)}</Cell>
      <Cell label="Mean time to remediation">{formatMean(stats?.meanTimeToRemediationMs)}</Cell>
    </div>
  );
}

type Destination = { to: string; label: string; needs?: keyof Capabilities };

const DESTINATIONS: Destination[] = [
  { to: '/', label: 'Overview' },
  { to: '/timeline', label: 'Timeline' },
  { to: '/incidents', label: 'Incidents' },
  { to: '/inspect', label: 'Inspect', needs: 'diagnose' },
  { to: '/watched', label: 'Watched' },
  /**
   * Gated on `signChaos`, not `chaos`.
   *
   * The public deployment holds no key, so `chaos` is false there by design —
   * and gating on it hid the one thing a visitor is meant to do. The panel
   * plans a failure for the visitor's own wallet to sign, which is exactly
   * what `signChaos` reports.
   */
  { to: '/chaos', label: 'Chaos', needs: 'signChaos' },
  { to: '/connections', label: 'Connections', needs: 'connectKeeperHub' },
];

/**
 * Destinations are gated on capabilities. A process without the machinery to
 * run chaos does not serve those routes at all, so linking to them would offer
 * a 404 — a worse answer than not offering the link.
 */
export function Rail({ capabilities }: { capabilities: Capabilities | null }): React.JSX.Element {
  const visible = DESTINATIONS.filter(
    (destination) => !destination.needs || capabilities?.[destination.needs] !== false,
  );

  return (
    <nav className="rail" aria-label="Console sections">
      <div className="rail__nav">
        {visible.map((destination) => (
          <Link
            key={destination.to}
            to={destination.to}
            className="rail__link"
            activeProps={{ className: 'rail__link rail__link--active' }}
            // Exact, or /incidents lights up while reading /incidents/inc-1,
            // which is a different destination. Search is excluded, or a
            // filtered timeline stops lighting up the link that leads to it.
            activeOptions={{ exact: true, includeSearch: false }}
          >
            {destination.label}
          </Link>
        ))}
      </div>
      <p className="rail__note">
        Detection is deterministic. Rules R1–R7 fire on measured facts; no model decides whether
        something is wrong.
      </p>
    </nav>
  );
}
