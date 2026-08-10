import { useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { chainName, explorerTxUrl } from '../../lib/explorer';
import { EM_DASH, formatConfidence, formatWei } from '../../lib/format';
import { useConsole } from '../../lib/store';
import type { DiagnoseResult, DiagnoseSimulation } from '../../lib/types';
import { FactsTable } from '../../ui/FactsTable';
import { ClassBadge, CopyableAddress, ExplorerLink, RuleTag, SeverityDot } from '../../ui/primitives';
import { Rca } from '../incident/Rca';
import './inspect.css';

/**
 * Explain any transaction, with nothing registered and nothing installed.
 *
 * This is the page to hand someone evaluating the product, so it asks for one
 * hash and nothing else. There is no persistence here: this is a question, not
 * a subscription.
 */
export function Inspect(): React.JSX.Element {
  const { config } = useConsole();
  const chains = config?.chains ?? [];

  const [txHash, setTxHash] = useState('');
  const [chainId, setChainId] = useState<number | null>(null);
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [watched, setWatched] = useState<string | null>(null);

  const activeChain = chainId ?? chains[0]?.chainId ?? 11155111;
  const valid = /^0x[0-9a-fA-F]{64}$/.test(txHash.trim());

  const explain = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    setWatched(null);
    try {
      setResult(await api.diagnose(txHash.trim(), activeChain));
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const watch = async (signer: string): Promise<void> => {
    setBusy(true);
    try {
      await api.watch({ signer, chainId: result?.chainId ?? activeChain });
      setWatched(signer);
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page">
      <header className="pagehead">
        <p className="eyebrow eyebrow--accent eyebrow--ruled">Inspect</p>
        <div className="pagehead__row">
          <h1 className="pagehead__title">Explain a transaction</h1>
        </div>
        <p className="soft inspect__lead">
          Paste any transaction hash on a configured chain. The sender does not have to be
          registered, monitored, or aware Blackbox exists.
        </p>
      </header>

      <form className="filters" onSubmit={(event) => void explain(event)}>
        <label className="filter">
          <span className="filter__label">Transaction hash</span>
          <input
            className="filter__control inspect__input"
            type="text"
            placeholder="0x…"
            value={txHash}
            spellCheck={false}
            onChange={(event) => setTxHash(event.target.value)}
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

        <span className="filters__gap" />
        <button type="submit" className="button" disabled={busy || !valid}>
          {busy ? 'Explaining…' : 'Explain this transaction'}
        </button>
      </form>

      {error ? (
        <div className="panel panel--accent state" role="alert">
          <p className="state__lead">That could not be explained.</p>
          <p className="soft">{error.detail}</p>
        </div>
      ) : null}

      {result ? (
        <Result
          result={result}
          chains={chains}
          onWatch={(signer) => void watch(signer)}
          watched={watched}
          busy={busy}
        />
      ) : null}
    </section>
  );
}

/**
 * The replay. For a reverted transaction Blackbox runs the call again against
 * the block *before* it was mined, and whether it would have succeeded there is
 * the entire difference between state drifting underneath a good call and a
 * call that was doomed when it was signed.
 */
function Simulation({ simulation }: { simulation: DiagnoseSimulation }): React.JSX.Element {
  const verdict = !simulation.performed
    ? 'Not replayed.'
    : simulation.success === true
      ? `It would have succeeded at block ${simulation.simulatedAtBlock ?? EM_DASH}. The state drifted underneath it.`
      : simulation.success === false
        ? `It would have reverted at block ${simulation.simulatedAtBlock ?? EM_DASH} too. This call was doomed before it was sent.`
        : 'Replayed, with no verdict recorded.';

  return (
    <div className="subsection">
      <p className="eyebrow">Replay</p>
      <p className="inspect__verdict">{verdict}</p>
      {simulation.note ? <p className="soft subsection__note">{simulation.note}</p> : null}
    </div>
  );
}

function Result({
  result,
  chains,
  onWatch,
  watched,
  busy,
}: {
  result: DiagnoseResult;
  chains: { chainId: number; name: string; testnet: boolean; privateMempool: boolean; explorerTxUrl: string }[];
  onWatch: (signer: string) => void;
  watched: string | null;
  busy: boolean;
}): React.JSX.Element {
  const url = explorerTxUrl(chains, result.chainId, result.txHash, result.explorerUrl);

  // Not found is a reasonable mistake — a hash from another chain — and is
  // stated plainly rather than dressed as an error.
  if (!result.found) {
    return (
      <section className="panel section">
        <header className="section__head">
          <p className="eyebrow eyebrow--accent">Not found</p>
        </header>
        <p className="soft section__empty">{result.detail}</p>
        <p className="dim mono">
          {result.txHash} on {chainName(chains, result.chainId)}
        </p>
      </section>
    );
  }

  const clean = result.class === null || result.class === undefined;

  return (
    <>
      <section className="panel section">
        <header className="section__head">
          <p className="eyebrow eyebrow--accent">{clean ? 'Nothing wrong with this one' : 'Classified'}</p>
          <div className="section__title">
            {clean ? null : (
              <>
                {result.severity ? <SeverityDot severity={result.severity} /> : null}
                {result.ruleId ? <RuleTag ruleId={result.ruleId} /> : null}
                <ClassBadge value={result.class as string} />
              </>
            )}
            <span className="section__gap" />
            {result.confidence !== undefined ? (
              <span className="dim mono">confidence {formatConfidence(result.confidence)}</span>
            ) : null}
          </div>
        </header>

        {clean && result.detail ? <p className="soft">{result.detail}</p> : null}

        <dl className="incident__meta">
          <div>
            <dt>Transaction</dt>
            <dd>{url ? <ExplorerLink url={url}>{result.txHash.slice(0, 18)}…</ExplorerLink> : result.txHash}</dd>
          </div>
          {result.signer ? (
            <div>
              <dt>Sender</dt>
              <dd>
                <CopyableAddress value={result.signer} />
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Chain</dt>
            <dd>{result.chain ?? chainName(chains, result.chainId)}</dd>
          </div>
          {result.nonce !== undefined ? (
            <div>
              <dt>Nonce</dt>
              <dd className="num">{result.nonce}</dd>
            </div>
          ) : null}
          {result.status ? (
            <div>
              <dt>Outcome</dt>
              <dd>{result.status}</dd>
            </div>
          ) : null}
          {result.blockNumber !== undefined ? (
            <div>
              <dt>Block</dt>
              <dd className="num">{result.blockNumber}</dd>
            </div>
          ) : null}
        </dl>

        {result.simulation ? <Simulation simulation={result.simulation} /> : null}

        {/* What was examined. A clean result is only trustworthy if you can see
            what was looked at to reach it. */}
        {clean && result.checked ? (
          <div className="subsection">
            <p className="eyebrow">What was checked</p>
            <table className="facts">
              <tbody>
                <tr>
                  <th scope="row">latestNonce</th>
                  <td className="num">{result.checked.latestNonce ?? EM_DASH}</td>
                  <td />
                </tr>
                <tr>
                  <th scope="row">pendingNonce</th>
                  <td className="num">{result.checked.pendingNonce ?? EM_DASH}</td>
                  <td />
                </tr>
                <tr>
                  <th scope="row">missingNonces</th>
                  <td className="num">
                    {result.checked.missingNonces
                      ? `[${result.checked.missingNonces.join(', ')}]`
                      : EM_DASH}
                  </td>
                  <td />
                </tr>
                <tr>
                  <th scope="row">balanceWei</th>
                  <td className="num">{formatWei(result.checked.balanceWei, true)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}

        {!clean && result.facts ? (
          <div className="subsection">
            <p className="eyebrow">Evidence</p>
            <FactsTable facts={result.facts} incidentClass={result.class ?? null} />
          </div>
        ) : null}

        {/* No persistence here, so the useful next step is a subscription. */}
        {result.signer ? (
          <div className="subsection inspect__followup">
            {watched === result.signer ? (
              <p className="soft">
                Watching <span className="mono">{result.signer}</span>. Discovery starts now, not
                from genesis.
              </p>
            ) : (
              <>
                <p className="soft subsection__note">
                  Nothing here was saved — this was a question, not a subscription.
                </p>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => onWatch(result.signer as string)}
                >
                  Watch this address
                </button>
              </>
            )}
          </div>
        ) : null}
      </section>

      {!clean ? <Rca rca={result.rca ?? null} /> : null}
    </>
  );
}
