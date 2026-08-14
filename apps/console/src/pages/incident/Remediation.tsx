import { explorerTxUrl } from '../../lib/explorer';
import { EM_DASH, absoluteTime, formatWei } from '../../lib/format';
import type { ChainConfig, Executor, Remediation as RemediationType } from '../../lib/types';
import { CopyableAddress, ExplorerLink } from '../../ui/primitives';

/**
 * What Blackbox did about it.
 *
 * Three outcomes, and they are not ranked. A remediation declined by a guard is
 * correct behaviour with a stated reason, so it is rendered at the same weight
 * as a success — greying it out or tucking it away would present the product's
 * restraint as a malfunction.
 */

const OUTCOME: Record<string, { label: string; tone: string; note: string }> = {
  succeeded: {
    label: 'Succeeded',
    tone: 'ok',
    note: 'The fix was executed and the receipt verified.',
  },
  failed: {
    label: 'Failed',
    tone: 'crit',
    note: 'The fix was attempted and did not resolve the incident.',
  },
  skipped_by_guard: {
    label: 'Declined by a guard',
    tone: 'accent',
    note: 'A guard refused to act. This is the automation working, not failing.',
  },
  skipped_by_policy: {
    label: 'Declined by policy',
    tone: 'accent',
    note: 'The playbook refused with a stated reason rather than acting.',
  },
  pending: {
    label: 'In progress',
    tone: 'warn',
    note: 'A remediation is running.',
  },
};

/**
 * Which path put the transaction on chain. A workflow run happened inside the
 * operator's own KeeperHub dashboard with per-node logs, and saying so is the
 * point of recording it.
 */
const EXECUTOR: Record<Executor, string> = {
  'keeperhub-workflow': 'KeeperHub workflow run — visible in your own dashboard, with node logs',
  keeperhub: 'KeeperHub Direct Execution',
  signer: 'a key Blackbox holds',
  'user-signed': "signed by the account's own wallet, not by Blackbox",
};

export function Remediation({
  remediation,
  chains,
  chainId,
}: {
  remediation: RemediationType | null;
  chains: ChainConfig[];
  chainId: number;
}): React.JSX.Element {
  if (!remediation) {
    return (
      <section className="panel section">
        <header className="section__head">
          <h2 className="eyebrow eyebrow--accent">Remediation</h2>
        </header>
        <p className="soft section__empty">Nothing has acted on this incident.</p>
      </section>
    );
  }

  const outcome = OUTCOME[remediation.finalStatus] ?? {
    label: remediation.finalStatus,
    tone: '',
    note: '',
  };

  return (
    <section className="panel section">
      <header className="section__head">
        <h2 className="eyebrow eyebrow--accent">Remediation</h2>
        <div className="section__title">
          <span className="mono">
            {remediation.playbookId}
            {remediation.playbookName ? ` · ${remediation.playbookName}` : ''}
          </span>
          <span className="section__gap" />
          <span className={`outcome outcome--${outcome.tone}`}>{outcome.label}</span>
        </div>
        {outcome.note ? <p className="soft subsection__note">{outcome.note}</p> : null}
      </header>

      {remediation.verifiedAt ? (
        <p className="dim mono">verified {absoluteTime(remediation.verifiedAt)}</p>
      ) : null}

      {remediation.attempts.map((attempt) => {
        const url = explorerTxUrl(chains, chainId, attempt.txHash, attempt.explorerUrl);

        return (
          <div className="attempt" key={attempt.attemptIndex}>
            <div className="attempt__head">
              <span className="eyebrow">Attempt {attempt.attemptIndex + 1}</span>
              <span className="section__gap" />
              <span className={`attempt__status attempt__status--${attempt.status}`}>
                {attempt.status}
              </span>
            </div>

            {/* On a success this hash is the product's proof of work, so it is
                the largest thing on the page. */}
            {attempt.txHash ? (
              <div className={attempt.status === 'succeeded' ? 'proof proof--won' : 'proof'}>
                <span className="eyebrow">Transaction</span>
                {url ? (
                  <ExplorerLink url={url}>{attempt.txHash}</ExplorerLink>
                ) : (
                  <CopyableAddress value={attempt.txHash} kind="hash" />
                )}
              </div>
            ) : null}

            {attempt.failureReason ? (
              <p className="attempt__reason">{attempt.failureReason}</p>
            ) : null}

            <dl className="attempt__meta">
              <div>
                <dt>Executed by</dt>
                <dd>{attempt.executor ? EXECUTOR[attempt.executor] : EM_DASH}</dd>
              </div>
              <div>
                <dt>Gas used</dt>
                <dd className="num">{attempt.gasUsed ? formatWei(attempt.gasUsed, true) : EM_DASH}</dd>
              </div>
              {attempt.keeperHubActionId ? (
                <div>
                  <dt>KeeperHub action</dt>
                  <dd className="mono">{attempt.keeperHubActionId}</dd>
                </div>
              ) : null}
              <div>
                <dt>Started</dt>
                <dd>{absoluteTime(attempt.startedAt)}</dd>
              </div>
            </dl>

            {/*
              Blackbox checks the workflow with KeeperHub's own MCP validator
              before running it. Showing the verdict is the point: "we asked"
              is a claim, and this is the evidence for it. A flag is not a
              fault — their validator reports a templated chain field as an
              unknown chain id, which is a false positive we fixed upstream, so
              that case is named rather than quietly discounted.
            */}
            {attempt.validation ? (
              <p
                className={
                  attempt.validation.valid || attempt.validation.knownFalsePositive
                    ? 'attempt__validation'
                    : 'attempt__validation attempt__validation--flagged'
                }
              >
                <span className="attempt__validation-label">KeeperHub validate_workflow</span>{' '}
                {attempt.validation.valid ? (
                  <>checked clean before running.</>
                ) : attempt.validation.knownFalsePositive ? (
                  <>
                    flagged this, and the complaint is a known false positive on templated chain
                    fields — reported and fixed upstream as KeeperHub#1995. Run anyway.
                  </>
                ) : (
                  <>flagged this: {attempt.validation.detail}</>
                )}
              </p>
            ) : null}

            {/* Every guard is listed, passed and failed. They are evaluated
                independently, so several can fail at once and showing only the
                first would misstate why nothing happened. */}
            <div className="guards">
              <div className="guards__group">
                <span className="eyebrow">Guards passed</span>
                <ul className="guards__list">
                  {attempt.guardsPassed.length === 0 ? (
                    <li className="dim">none</li>
                  ) : (
                    attempt.guardsPassed.map((guard) => (
                      <li className="guard guard--passed" key={guard}>
                        {guard}
                      </li>
                    ))
                  )}
                </ul>
              </div>
              <div className="guards__group">
                <span className="eyebrow">Guards failed</span>
                <ul className="guards__list">
                  {attempt.guardsFailed.length === 0 ? (
                    <li className="dim">none</li>
                  ) : (
                    attempt.guardsFailed.map((guard) => (
                      <li className="guard guard--failed" key={guard}>
                        {guard}
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}
