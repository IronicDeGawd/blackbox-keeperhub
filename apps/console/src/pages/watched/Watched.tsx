import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { chainName } from '../../lib/explorer';
import { useConsole } from '../../lib/store';
import type { WatchedAddress } from '../../lib/types';
import { CopyableAddress, RelativeTime } from '../../ui/primitives';
import './watched.css';

/**
 * Addresses Blackbox discovers transactions for by scanning blocks.
 *
 * Nothing is installed on the watched agent's side, which is the point — but
 * that also bounds what watching can do, and this page says so plainly. Letting
 * someone believe every watched address can be fixed automatically is the
 * fastest way to lose their trust the first time one cannot.
 */
export function Watched(): React.JSX.Element {
  const { config, scan } = useConsole();
  const chains = config?.chains ?? [];

  const [items, setItems] = useState<WatchedAddress[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const [signer, setSigner] = useState('');
  const [chainId, setChainId] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [agentId, setAgentId] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await api.watched();
      setItems(list.items);
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeChain = chainId ?? chains[0]?.chainId ?? 11155111;

  const add = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.watch({
        signer: signer.trim(),
        chainId: activeChain,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
      });
      setSigner('');
      setLabel('');
      setAgentId('');
      await load();
    } catch (cause) {
      // invalid_address and unsupported_chain both arrive with a readable
      // detail line; it is shown as written.
      if (cause instanceof ApiError) setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: WatchedAddress): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.unwatch(entry.signer, entry.chainId);
      await load();
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page">
      <header className="pagehead">
        <p className="eyebrow eyebrow--accent eyebrow--ruled">Watched addresses</p>
        <div className="pagehead__row">
          <h1 className="pagehead__title">
            {items.length} address{items.length === 1 ? '' : 'es'}
          </h1>
          <span className="row__gap" />
          {scan ? (
            <span className="scanline">
              scanner at block {scan.toBlock} · {scan.blocksScanned} scanned · {scan.matched}{' '}
              matched
            </span>
          ) : null}
        </div>
      </header>

      <div className="panel panel--accent section">
        <p className="eyebrow">What watching gives you</p>
        <p className="soft watched__prose">
          Detection and explanation for <strong>any</strong> address. Its transactions are
          discovered by scanning blocks, so the agent being watched installs nothing and needs to
          know nothing.
        </p>
        <p className="eyebrow">What it does not</p>
        <p className="soft watched__prose">
          Remediation only where Blackbox holds a key for the signer, the address is a KeeperHub
          managed wallet, or the owner signs a plan themselves. For everything else this is a
          diagnosis, not a fix.
        </p>
        <p className="soft watched__prose">
          {/* An empty list otherwise reads as a bug rather than as a
              not-yet-anything. */}
          Discovery starts when an address is registered, not from genesis. Nothing that happened
          before you added it will appear here.
        </p>
      </div>

      <form className="filters" onSubmit={(event) => void add(event)}>
        <label className="filter">
          <span className="filter__label">Address</span>
          <input
            className="filter__control watched__address"
            type="text"
            placeholder="0x…"
            value={signer}
            spellCheck={false}
            onChange={(event) => setSigner(event.target.value)}
          />
        </label>

        <label className="filter">
          <span className="filter__label">Chain</span>
          <select
            className="filter__control"
            value={activeChain}
            onChange={(event) => setChainId(Number(event.target.value))}
          >
            {chains.map((chain) => (
              <option key={chain.chainId} value={chain.chainId}>
                {chain.name}
              </option>
            ))}
          </select>
        </label>

        <label className="filter">
          <span className="filter__label">Label (optional)</span>
          <input
            className="filter__control"
            type="text"
            placeholder="their agent"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>

        <label className="filter">
          <span className="filter__label">Agent id (optional)</span>
          <input
            className="filter__control"
            type="text"
            placeholder="derived from the address"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          />
        </label>

        <span className="filters__gap" />
        <button type="submit" className="button" disabled={busy || signer.trim() === ''}>
          {busy ? 'Working…' : 'Watch this address'}
        </button>
      </form>

      {error ? (
        <div className="panel panel--accent state" role="alert">
          <p className="state__lead">
            {error.code === 'invalid_address'
              ? 'That is not an address.'
              : error.code === 'unsupported_chain'
                ? 'That chain is not configured.'
                : 'The request failed.'}
          </p>
          <p className="soft">{error.detail}</p>
        </div>
      ) : null}

      <div className="feed">
        {items.length === 0 ? (
          <div className="state">
            <p className="state__lead">Nothing is being watched.</p>
            <p className="soft">
              Add an address above and Blackbox starts scanning blocks for its transactions.
            </p>
          </div>
        ) : (
          <table className="listing">
            <thead>
              <tr>
                <th>Address</th>
                <th>Chain</th>
                <th>Agent</th>
                <th>Label</th>
                <th>Watching since</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={`${entry.signer}-${entry.chainId}`}>
                  <td>
                    <CopyableAddress value={entry.signer} />
                  </td>
                  <td>{chainName(chains, entry.chainId)}</td>
                  <td>{entry.agentId}</td>
                  <td className={entry.label ? '' : 'dim'}>{entry.label ?? 'none'}</td>
                  <td>
                    <RelativeTime at={entry.registeredAt} />
                  </td>
                  <td className="listing__actions">
                    <button
                      type="button"
                      className="linkbutton"
                      disabled={busy}
                      onClick={() => void remove(entry)}
                      // Worth stating: unwatching is not a delete.
                      title="Stops discovery. Incidents already found are kept."
                    >
                      unwatch
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
