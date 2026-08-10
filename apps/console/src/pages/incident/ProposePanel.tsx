import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { chainName } from '../../lib/explorer';
import { formatGwei, formatWei } from '../../lib/format';
import type { ChainConfig, RemediationPlan, RemediationTxResult } from '../../lib/types';
import {
  connectWallet,
  sameAddress,
  sendPlannedTransaction,
  switchChain,
  walletAvailable,
  type WalletConnection,
} from '../../lib/wallet';
import { CopyableAddress, ExplorerLink } from '../../ui/primitives';

/**
 * Remediation the owner signs.
 *
 * Some fixes must occupy a specific nonce on a specific account, and only that
 * account's key can do it — KeeperHub executes through a sponsored relayer at
 * the sponsor's nonce, so it cannot. Blackbox plans; the owner signs.
 *
 * The whole transaction is rendered before a signature is asked for. Someone is
 * about to authorise a state change with their own key, and showing them a
 * spinner and a button instead of the thing they are signing is not acceptable.
 */
export function ProposePanel({
  incidentId,
  chains,
}: {
  incidentId: string;
  chains: ChainConfig[];
}): React.JSX.Element | null {
  const [plan, setPlan] = useState<RemediationPlan | null>(null);
  const [planError, setPlanError] = useState<ApiError | null>(null);
  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<RemediationTxResult | null>(null);
  const [pastedHash, setPastedHash] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .remediationPlan(incidentId)
      .then((next) => {
        if (live) setPlan(next);
      })
      .catch((cause: unknown) => {
        if (live && cause instanceof ApiError) setPlanError(cause);
      });
    return () => {
      live = false;
    };
  }, [incidentId]);

  const submitHash = useCallback(
    async (hash: string): Promise<void> => {
      setSubmitError(null);
      setBusy(true);
      try {
        setResult(await api.submitRemediationTx(incidentId, hash));
      } catch (cause) {
        // A 422 names exactly which check failed and is written to be read.
        if (cause instanceof ApiError) setSubmitError(cause);
      } finally {
        setBusy(false);
      }
    },
    [incidentId],
  );

  const connect = async (): Promise<void> => {
    setWalletError(null);
    try {
      setWallet(await connectWallet());
    } catch (cause) {
      setWalletError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const sign = async (): Promise<void> => {
    if (!plan?.transaction || !wallet) return;
    setWalletError(null);
    setBusy(true);
    try {
      if (wallet.chainId !== plan.chainId) {
        await switchChain(plan.chainId);
        setWallet({ ...wallet, chainId: plan.chainId });
      }
      const hash = await sendPlannedTransaction(plan.transaction, wallet.address);
      await submitHash(hash);
    } catch (cause) {
      setWalletError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (planError) {
    // A 404 here means this incident has no plan, which is ordinary.
    if (planError.status === 404) return null;
    return (
      <section className="panel section">
        <header className="section__head">
          <p className="eyebrow eyebrow--accent">Fix it yourself</p>
        </header>
        <p className="soft section__empty">{planError.detail}</p>
      </section>
    );
  }

  if (!plan) return null;

  const tx = plan.transaction;
  const wrongAccount = wallet !== null && !sameAddress(wallet.address, plan.signerRequired);
  const url = result?.explorerUrl ?? null;

  return (
    <section className="panel section propose">
      <header className="section__head">
        <p className="eyebrow eyebrow--accent">Fix it yourself</p>
        <p className="soft subsection__note">
          This fix has to come from{' '}
          <span className="mono">{plan.signerRequired}</span> on{' '}
          {chainName(chains, plan.chainId)}. Blackbox plans it; only that account can sign it.
        </p>
      </header>

      {plan.declined ? (
        <div className="refusal">
          <p className="refusal__lead">The playbook declined to plan a transaction.</p>
          <p className="soft">{plan.declined.reason}</p>
        </div>
      ) : null}

      {tx ? (
        <>
          {!plan.actionable ? (
            <div className="refusal">
              <p className="refusal__lead">Blackbox's own guards would block this.</p>
              {/* Shown anyway: a person may legitimately choose to sign what the
                  automation is not permitted to do. */}
              <p className="soft">
                The transaction is shown in full regardless — you may choose to sign what the
                automation is not allowed to.
              </p>
              {plan.guards.failed.length > 0 ? (
                <ul className="guards__list">
                  {plan.guards.failed.map((guard) => (
                    <li className="guard guard--failed" key={guard}>
                      {guard}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="subsection">
            <p className="eyebrow">The transaction you would sign</p>
            <table className="facts">
              <tbody>
                <tr>
                  <th scope="row">description</th>
                  <td colSpan={2}>{tx.description}</td>
                </tr>
                <tr>
                  <th scope="row">to</th>
                  <td colSpan={2} className="mono">
                    {tx.to}
                  </td>
                </tr>
                <tr>
                  <th scope="row">value</th>
                  <td colSpan={2}>{formatWei(tx.value, true)}</td>
                </tr>
                <tr>
                  <th scope="row">nonce</th>
                  {/* The point of the whole exercise: this exact nonce. */}
                  <td colSpan={2} className="num">
                    {tx.nonce}
                  </td>
                </tr>
                <tr>
                  <th scope="row">maxFeePerGas</th>
                  <td colSpan={2} className="num">
                    {formatGwei(tx.maxFeePerGas, 9)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">maxPriorityFeePerGas</th>
                  <td colSpan={2} className="num">
                    {formatGwei(tx.maxPriorityFeePerGas, 9)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">data</th>
                  <td colSpan={2} className="mono">
                    {tx.data ?? 'none'}
                  </td>
                </tr>
                {tx.route ? (
                  <tr>
                    <th scope="row">route</th>
                    <td colSpan={2}>{tx.route}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <p className="soft subsection__note">
              Sign it exactly as shown. A wallet that re-prices or re-nonces it produces a different
              transaction that does not fill the gap, and the server will reject the hash.
            </p>
          </div>

          {result ? (
            <div className="proof proof--won">
              <span className="eyebrow">Accepted and verified</span>
              {url ? (
                <ExplorerLink url={url}>{pastedHash || 'view the transaction'}</ExplorerLink>
              ) : null}
              <span className="soft">
                Recorded as user-signed. Gas used {formatWei(result.gasUsed, true)}.
              </span>
            </div>
          ) : (
            <div className="subsection">
              <p className="eyebrow">Sign it</p>

              <div className="actions__row">
                {!walletAvailable() ? (
                  <span className="soft">
                    No injected wallet in this browser. Sign it elsewhere and paste the hash below.
                  </span>
                ) : wallet === null ? (
                  <button type="button" className="button" onClick={() => void connect()}>
                    Connect a wallet
                  </button>
                ) : (
                  <>
                    <span className="mono soft">
                      connected <CopyableAddress value={wallet.address} />
                    </span>
                    <button
                      type="button"
                      className="button button--go"
                      onClick={() => void sign()}
                      disabled={busy || wrongAccount}
                    >
                      {busy ? 'Waiting for the wallet…' : 'Sign and submit'}
                    </button>
                  </>
                )}
              </div>

              {/* Said before a signature is wasted rather than after. */}
              {wrongAccount && wallet ? (
                <div className="refusal">
                  <p className="refusal__lead">That account cannot fix this.</p>
                  <p className="soft">
                    The wallet is connected as <span className="mono">{wallet.address}</span>, but
                    this incident is about <span className="mono">{plan.signerRequired}</span>. Only
                    a transaction from the incident's own signer occupies the nonce that is blocked.
                  </p>
                </div>
              ) : null}

              {walletError ? (
                <div className="refusal">
                  <p className="refusal__lead">The wallet did not complete it.</p>
                  <p className="soft">{walletError}</p>
                </div>
              ) : null}

              <div className="paste">
                <label className="filter">
                  <span className="filter__label">Already sent it? Paste the hash</span>
                  <input
                    className="filter__control paste__input"
                    type="text"
                    placeholder="0x…"
                    value={pastedHash}
                    spellCheck={false}
                    onChange={(event) => setPastedHash(event.target.value.trim())}
                  />
                </label>
                <button
                  type="button"
                  className="button"
                  disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(pastedHash)}
                  onClick={() => void submitHash(pastedHash)}
                >
                  Submit hash
                </button>
              </div>

              {submitError ? (
                <div className="refusal">
                  <p className="refusal__lead">
                    {submitError.status === 422
                      ? 'That transaction does not match this incident.'
                      : 'The hash was not accepted.'}
                  </p>
                  {/* Verbatim: the server names which check failed, and any
                      paraphrase here would be less specific than the truth. */}
                  <p className="soft">{submitError.detail}</p>
                </div>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
