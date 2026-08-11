import { useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { explorerTxUrl } from '../../lib/explorer';
import { connectWallet, sameAddress, sendPlannedTransaction, switchChain, walletAvailable } from '../../lib/wallet';
import type { ChaosPlan, ChainConfig } from '../../lib/types';
import { ExplorerLink } from '../../ui/primitives';

/**
 * Break something with your own wallet, on a deployment that holds no key.
 *
 * The public deployment deliberately holds no signer key — a spendable key on
 * an open URL is a key handed to the internet — so it cannot induce a failure
 * for you. It can still *plan* one: it works out the exact transactions that
 * produce a given failure on your own address, and your wallet signs them.
 *
 * Every field is sent exactly as planned. Some of these scenarios exist to
 * occupy one specific nonce, so a wallet that helpfully re-nonces or re-prices
 * produces something that costs money and induces nothing.
 */

type Signed = { label: string; txHash: string };

export function SelfSigned({
  scenarios,
  chains,
  chainId,
}: {
  scenarios: { id: string; induces: string; summary: string; signable: boolean }[];
  chains: ChainConfig[];
  chainId: number;
}): React.JSX.Element {
  const [wallet, setWallet] = useState<{ address: string; chainId: number } | null>(null);
  const [plan, setPlan] = useState<ChaosPlan | null>(null);
  const [signed, setSigned] = useState<Signed[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reported, setReported] = useState<string | null>(null);

  const connect = async (): Promise<void> => {
    setError(null);
    try {
      setWallet(await connectWallet());
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const planFor = async (scenario: string): Promise<void> => {
    if (!wallet) return;
    setBusy(scenario);
    setError(null);
    setSigned([]);
    setReported(null);
    try {
      const next = await api.chaosPlan({ scenario, signer: wallet.address, chainId });
      setPlan(next);
      if (next.declined) setError(next.declined);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.detail : (cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const sign = async (): Promise<void> => {
    if (!plan || !wallet) return;
    setBusy('sign');
    setError(null);
    try {
      if (wallet.chainId !== plan.chainId) await switchChain(plan.chainId);
      const produced: Signed[] = [];
      // In order, and one at a time: these share a nonce sequence, and firing
      // them together would induce a gap no scenario asked for.
      for (const step of plan.steps) {
        if (!step.transaction) continue;
        const txHash = await sendPlannedTransaction(
          { ...step.transaction, description: step.label } as never,
          wallet.address,
        );
        produced.push({ label: step.label, txHash });
        setSigned([...produced]);
      }

      /**
       * Report the hashes.
       *
       * Not politeness: a transaction above an unused nonce is *queued*, never
       * gossiped and in no block, so scanning cannot find it. The wallet is
       * the only party that knows it exists.
       */
      const result = await api.chaosObserve({
        txHashes: produced.map((s) => s.txHash),
        chainId: plan.chainId,
      });
      setReported(
        `Reported ${result.observed.length} transaction${result.observed.length === 1 ? '' : 's'}. Detection follows within a tick.`,
      );
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.detail : (cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const wrongAccount =
    plan !== null && wallet !== null && !sameAddress(wallet.address, plan.signer);

  return (
    <div className="selfsigned">
      <p className="selfsigned__lead">
        This deployment holds no signer key, deliberately — a spendable key on an open URL is a
        key handed to the internet. So it plans the failure and your wallet signs it. Everything
        happens on your own address, on a testnet, and costs you a few thousand gwei.
      </p>

      {!walletAvailable() ? (
        <p className="selfsigned__note">
          No injected wallet found in this browser. The scenarios below are still listed, and{' '}
          <code>POST /api/chaos/plan</code> answers without one.
        </p>
      ) : !wallet ? (
        <button type="button" className="button" onClick={() => void connect()}>
          Connect a wallet
        </button>
      ) : (
        <p className="selfsigned__note">
          Signing as <span className="mono">{wallet.address}</span>
        </p>
      )}

      {error ? <p className="selfsigned__error">{error}</p> : null}

      <ul className="selfsigned__list">
        {scenarios.map((scenario) => (
          <li key={scenario.id} className="selfsigned__item">
            <div className="selfsigned__head">
              <span className="mono">{scenario.id}</span>
              <span className="tag">{scenario.induces}</span>
            </div>
            <p className="selfsigned__summary">{scenario.summary}</p>
            <button
              type="button"
              className="button"
              disabled={!wallet || busy !== null || !scenario.signable}
              onClick={() => void planFor(scenario.id)}
            >
              {busy === scenario.id ? 'Planning…' : 'Plan it'}
            </button>
          </li>
        ))}
      </ul>

      {plan && !plan.declined ? (
        <section className="panel selfsigned__plan">
          <h2 className="eyebrow eyebrow--accent">
            {plan.scenario} — induces {plan.induces}
          </h2>
          {plan.expect ? <p className="selfsigned__summary">{plan.expect}</p> : null}

          <ol className="selfsigned__steps">
            {plan.steps.map((step) => (
              <li key={step.order}>
                <strong>{step.label}</strong>
                <p className="selfsigned__summary">{step.explanation}</p>
                {step.transaction ? (
                  <p className="selfsigned__facts mono">
                    nonce {step.transaction.nonce} · to {step.transaction.to.slice(0, 10)}… ·{' '}
                    {step.transaction.value} wei
                  </p>
                ) : null}
              </li>
            ))}
          </ol>

          {wrongAccount ? (
            <p className="selfsigned__error">
              The plan is for <span className="mono">{plan.signer}</span> but the wallet is
              connected as <span className="mono">{wallet?.address}</span>.
            </p>
          ) : (
            <button
              type="button"
              className="button button--go"
              disabled={busy !== null}
              onClick={() => void sign()}
            >
              {busy === 'sign' ? 'Signing…' : `Sign ${plan.steps.length} transaction${plan.steps.length === 1 ? '' : 's'}`}
            </button>
          )}

          {signed.length > 0 ? (
            <ul className="selfsigned__signed">
              {signed.map((s) => (
                <li key={s.txHash}>
                  {s.label} —{' '}
                  <ExplorerLink url={explorerTxUrl(chains, plan.chainId, s.txHash) ?? ''}>
                    {s.txHash.slice(0, 10)}…
                  </ExplorerLink>
                </li>
              ))}
            </ul>
          ) : null}

          {reported ? <p className="selfsigned__note">{reported}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
