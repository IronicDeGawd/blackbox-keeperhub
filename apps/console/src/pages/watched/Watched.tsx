import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { chainName } from '../../lib/explorer';
import { useConsole } from '../../lib/store';
import type { Agent, ChainConfig, SignerHealth, WatchedAddress } from '../../lib/types';
import { formatWei } from '../../lib/format';
import { CopyableAddress, RelativeTime } from '../../ui/primitives';
import './watched.css';

/**
 * What the chain says about one address, right now.
 *
 * Asked for a row at a time. Each call is an RPC lookup, and firing one per
 * address the moment the page loads would spend a burst of them to answer a
 * question nobody had asked yet.
 */
function Health({ signer, chainId }: { signer: string; chainId: number }): React.JSX.Element {
  const [health, setHealth] = useState<SignerHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const check = async (): Promise<void> => {
    setBusy(true);
    setFailed(null);
    try {
      setHealth(await api.signerHealth(signer, chainId));
    } catch (cause) {
      setFailed(cause instanceof ApiError ? cause.detail : (cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (failed) return <span className="crit">{failed}</span>;

  if (!health) {
    return (
      <button type="button" className="linkbutton" onClick={() => void check()} disabled={busy}>
        {busy ? 'reading…' : 'check'}
      </button>
    );
  }

  const wedged = health.missingNonces.length > 0;
  return (
    <span className="watched__health">
      <span className="num">{formatWei(health.balanceWei)}</span>
      <span className="dim">nonce</span>
      <span className="num">{health.latestNonce}</span>
      {health.pendingNonce !== health.latestNonce ? (
        <span className="warn num">{health.pendingNonce} pending</span>
      ) : null}
      {wedged ? (
        <span className="crit">gap at {health.missingNonces.join(', ')}</span>
      ) : (
        <span className="ok">no gap</span>
      )}
      {health.runwayActions !== null ? (
        <span className={health.runwayActions < 5 ? 'warn' : 'dim'}>
          ~{health.runwayActions} left
        </span>
      ) : null}
    </span>
  );
}

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
                <th>Health</th>
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
                  <td>
                    <Health signer={entry.signer} chainId={entry.chainId} />
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

      <Agents chains={chains} />
    </section>
  );
}

/**
 * Who Blackbox thinks it is watching, and what it is allowed to do about it.
 *
 * An agent is the thing incidents are raised against; a watched address is one
 * of the ways an agent is discovered. They are listed together because the
 * question people actually ask — "so can it fix this one?" — is answered by the
 * agent row, not the address row.
 *
 * The list is already filtered by the server to what the caller may read, so an
 * anonymous visitor sees the public ones and an operator sees their own.
 */
/**
 * Register the breaker Blackbox may pause for an agent.
 *
 * This is the step that turns detection into remediation: P4 halts a runaway
 * agent by calling pause() on a contract the operator deployed and granted
 * Blackbox the pauser role on, and without one there is nothing to call. The
 * role is checked at registration rather than during an incident, because now
 * is when the operator can do something about it.
 */
function RegisterBreaker({
  agentId,
  chains,
  onDone,
}: {
  agentId: string;
  chains: ChainConfig[];
  onDone: () => void;
}): React.JSX.Element {
  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState(chains[0]?.chainId ?? 11155111);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await api.registerBreaker(agentId, { address: address.trim(), chainId });
      setResult(
        res.verified
          ? { tone: 'ok', text: 'Registered. Blackbox can pause this agent.' }
          : { tone: 'warn', text: res.detail ?? 'Registered, but the pauser role is missing.' },
      );
      onDone();
    } catch (cause) {
      setResult({
        tone: 'bad',
        text: cause instanceof ApiError ? cause.detail : 'Could not register that.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel section breaker" onSubmit={submit}>
      <h3 className="eyebrow eyebrow--accent">Register a breaker for {agentId}</h3>
      <p className="soft">
        Deploy a circuit breaker, grant Blackbox the pauser role on it, then register the address
        here. Blackbox may then halt this agent when a retry storm, a misconfigured workflow or a
        simulate-pass/execute-revert is detected. It can do nothing else with it — the contract
        allows pausing and nothing more.
      </p>

      <div className="breaker__row">
        <label className="breaker__field">
          <span className="breaker__label">Contract address</span>
          <input
            className="input mono"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            required
          />
        </label>
        <label className="breaker__field">
          <span className="breaker__label">Chain</span>
          <select
            className="input"
            value={chainId}
            onChange={(e) => setChainId(Number(e.target.value))}
          >
            {chains.map((chain) => (
              <option key={chain.chainId} value={chain.chainId}>
                {chain.name}
              </option>
            ))}
          </select>
        </label>
        <button className="button button--go" type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Register'}
        </button>
      </div>

      {result ? (
        <p
          className={result.tone === 'ok' ? 'ok' : result.tone === 'warn' ? 'warn' : 'crit'}
          role={result.tone === 'bad' ? 'alert' : 'status'}
        >
          {result.text}
        </p>
      ) : null}
    </form>
  );
}

function Agents({ chains }: { chains: ChainConfig[] }): React.JSX.Element | null {
  const [items, setItems] = useState<Agent[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = (): void => {
    void api
      .agents()
      .then((result) => setItems(result.items))
      .catch(() => setItems([]));
  };

  useEffect(() => {
    let live = true;
    void api
      .agents()
      .then((result) => {
        if (live) setItems(result.items);
      })
      .catch(() => {
        if (live) setItems([]);
      });
    return () => {
      live = false;
    };
  }, []);

  if (items === null || items.length === 0) return null;

  return (
    <section className="watched__agents">
      <h2 className="eyebrow eyebrow--ruled">Agents</h2>
      <div className="tablewrap">
        <table className="listing">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Signs from</th>
              <th>Chains</th>
              <th>Open</th>
              <th>Remediation</th>
              <th>Auto-halt</th>
            </tr>
          </thead>
          <tbody>
            {items.map((agent) => (
              <tr key={agent.agentId}>
                <td>
                  <span className="mono">{agent.agentId}</span>
                  {agent.label ? <span className="dim"> · {agent.label}</span> : null}
                </td>
                <td>
                  {agent.signers.map((signer) => (
                    <CopyableAddress key={signer} value={signer} />
                  ))}
                </td>
                <td>{agent.chainIds.map((id) => chainName(chains, id)).join(', ')}</td>
                <td className={agent.openIncidents > 0 ? 'crit num' : 'dim num'}>
                  {agent.openIncidents}
                </td>
                {/*
                 * The distinction the whole ownership model exists for: an
                 * agent Blackbox can act on, versus one it can only explain.
                 */}
                <td className={agent.selfRemediation ? 'ok' : 'dim'}>
                  {agent.selfRemediation ? 'can be executed' : 'proposal only'}
                </td>
                {/*
                 * Halting a runaway agent means pausing a breaker it has
                 * registered. Without one there is nothing to call, so this
                 * column is the difference between an agent that can be
                 * stopped and one that can only be described.
                 */}
                <td>
                  {agent.breaker ? (
                    <span className={agent.breaker.verified ? 'ok' : 'warn'}>
                      {agent.breaker.verified ? 'ready' : 'needs pauser role'}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="button button--quiet"
                      onClick={() => setOpen(open === agent.agentId ? null : agent.agentId)}
                    >
                      Register a breaker
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open ? <RegisterBreaker agentId={open} chains={chains} onDone={load} /> : null}
    </section>
  );
}
