import { useCallback, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ApiError, api } from '../../lib/api';
import { explorerAddressUrl, explorerTxUrl } from '../../lib/explorer';
import { formatWei } from '../../lib/format';
import { useConsole } from '../../lib/store';
import type { ChaosContext, ChaosRun } from '../../lib/types';
import { CopyableAddress, ExplorerLink } from '../../ui/primitives';
import './chaos.css';

/**
 * Induce real failures against real testnet contracts.
 *
 * Everything on this page spends real testnet gas. The harness is restricted to
 * testnets in code with no runtime override, but the UI still names the chain,
 * because "it is safe because the code says so" is not something an operator
 * should have to take on faith at the moment they click.
 */
export function Chaos(): React.JSX.Element {
  const { config } = useConsole();
  const chains = config?.chains ?? [];

  const [context, setContext] = useState<ChaosContext | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [runs, setRuns] = useState<ChaosRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setContext(await api.chaosScenarios());
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (scenario: string): Promise<void> => {
    setBusy(scenario);
    setError(null);
    try {
      const started = await api.chaosRun(scenario);
      setRuns((previous) => [started, ...previous]);
      await load();
    } catch (cause) {
      // A disabled scenario answers 409 with its note as the detail.
      if (cause instanceof ApiError) setError(cause);
    } finally {
      setBusy(null);
    }
  };

  const sweep = async (): Promise<void> => {
    if (!context) return;
    // In sequence, not in parallel: they share one signer and one nonce
    // sequence, and firing them together would induce a nonce gap that no
    // scenario asked for.
    for (const scenario of context.items.filter((item) => item.enabled)) {
      await run(scenario.id);
    }
  };

  const balance = context ? formatWei(context.signerBalanceWei, true) : null;
  const drained = context ? BigInt(context.signerBalanceWei || '0') < 10n ** 15n : false;

  return (
    <section className="page">
      <header className="pagehead">
        <p className="eyebrow eyebrow--accent eyebrow--ruled">Chaos</p>
        <div className="pagehead__row">
          <h1 className="pagehead__title">Induce a failure</h1>
          <span className="row__gap" />
          {context ? (
            <button
              type="button"
              className="button"
              disabled={busy !== null}
              onClick={() => void sweep()}
            >
              Run full sweep
            </button>
          ) : null}
        </div>
      </header>

      {context ? (
        <div
          className={context.isTestnet ? 'panel banner banner--testnet' : 'mainnet-warning'}
          role="alert"
        >
          <strong>{context.isTestnet ? 'TESTNET' : 'NOT A TESTNET'}</strong>{' '}
          <span>
            Every scenario here submits real transactions on{' '}
            <strong>{context.chainName}</strong> and spends real gas.
          </span>
        </div>
      ) : null}

      {context ? (
        <div className="panel section">
          <p className="eyebrow">Harness</p>
          <dl className="incident__meta">
            <div>
              <dt>Chaos signer</dt>
              <dd>
                <CopyableAddress value={context.signer} />
              </dd>
            </div>
            <div>
              <dt>Balance</dt>
              {/* A drained signer is the commonest reason a scenario silently
                  does nothing at all. */}
              <dd className={drained ? 'crit num' : 'num'}>
                {balance}
                {drained ? ' — too low to fund a run' : ''}
              </dd>
            </div>
            {Object.entries(context.targets).map(([name, address]) => {
              const url = explorerAddressUrl(chains, context.chainId, address);
              return (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>
                    {address ? (
                      url ? (
                        <ExplorerLink url={url}>{address.slice(0, 10)}…</ExplorerLink>
                      ) : (
                        <CopyableAddress value={address} />
                      )
                    ) : (
                      <span className="dim">not deployed</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      ) : null}

      {error ? (
        <div className="panel panel--accent state" role="alert">
          <p className="state__lead">That scenario did not run.</p>
          <p className="soft">{error.detail}</p>
        </div>
      ) : null}

      <div className="scenarios">
        {(context?.items ?? []).map((scenario) => (
          <article
            className={scenario.enabled ? 'scenario' : 'scenario scenario--off'}
            key={scenario.id}
          >
            <div className="scenario__head">
              <span className="scenario__id">{scenario.id}</span>
              <span className="scenario__name">{scenario.name}</span>
            </div>

            <p className="scenario__induces">
              induces{' '}
              {scenario.induces.map((cls) => (
                <span className="classbadge" key={cls}>
                  {cls}{' '}
                </span>
              ))}
            </p>

            <p className="scenario__determinism">
              {scenario.deterministic ? 'deterministic' : 'depends on conditions'}
            </p>

            {/* The note is the content, and for a disabled scenario it is the
                reason it cannot run. */}
            <p className="scenario__note soft">{scenario.note}</p>

            <button
              type="button"
              className="button"
              disabled={!scenario.enabled || busy !== null}
              onClick={() => void run(scenario.id)}
            >
              {busy === scenario.id ? 'Running…' : scenario.enabled ? 'Run' : 'Cannot run here'}
            </button>
          </article>
        ))}
      </div>

      {runs.length > 0 ? (
        <div className="panel section">
          <p className="eyebrow eyebrow--accent">Runs this session</p>
          {runs.map((entry) => (
            <div className="run" key={entry.runId}>
              <div className="run__head">
                <span className="mono">
                  {entry.scenario} · {entry.runId}
                </span>
                <span className="section__gap" />
                {entry.expectedIncidentClass ? (
                  <span className="classbadge">{entry.expectedIncidentClass}</span>
                ) : null}
              </div>
              <p className="soft subsection__note">
                {entry.expectedDetectionSeconds !== undefined ? (
                  <>
                    Expected to be detected within about {entry.expectedDetectionSeconds}s. Watch it
                    arrive on the <Link to="/">timeline</Link>.
                  </>
                ) : (
                  <>
                    Watch it arrive on the <Link to="/">timeline</Link>.
                  </>
                )}
              </p>
              <ul className="run__hashes">
                {entry.txHashes.map((hash) => {
                  const url = explorerTxUrl(chains, context?.chainId ?? 0, hash);
                  return (
                    <li key={hash}>
                      {url ? (
                        <ExplorerLink url={url}>{hash.slice(0, 18)}…</ExplorerLink>
                      ) : (
                        <CopyableAddress value={hash} kind="hash" />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
