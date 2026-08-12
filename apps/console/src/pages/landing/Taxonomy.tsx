import { INCIDENT_CLASSES, type IncidentClass } from '../../lib/types';

/**
 * What it actually catches.
 *
 * The strongest answer to "what does this do", and it was missing from the
 * front page entirely — the page said "ten checks" and left a reader to take
 * that on faith. Ten named failures let somebody see immediately whether their
 * problem is on the list, which is also honest scope-setting: a failure that
 * is not here will not be found.
 *
 * The list comes from `INCIDENT_CLASSES`, which a test holds equal to the
 * detector's own enum, so a rule that adds a class cannot leave this page
 * describing a product that no longer exists.
 */

/** One line each. What the rule measures, not what the class is called. */
const DESCRIPTIONS: Record<IncidentClass, string> = {
  STUCK_TRANSACTION: 'Submitted, still pending, and the nonce has not moved past it.',
  NONCE_GAP: 'A nonce was never filled, and everything queued behind it cannot run.',
  GAS_UNDERPRICED: 'The bid is under the market, so it will not be included at that price.',
  SIM_PASS_EXEC_REVERT: 'Simulated clean, reverted on inclusion — the state moved underneath it.',
  RETRY_STORM: 'The same action failing over and over, burning a wallet down as it goes.',
  SIGNER_GAS_STARVED: 'The balance no longer covers the cost of the next action.',
  ADVERSE_INCLUSION: 'Included, but the result came back worse than it simulated.',
  EXECUTION_STALLED: 'A workflow that started and never finished, with no transaction to find.',
  WORKFLOW_MISCONFIGURED:
    'Refused before the chain, repeatedly, at the same step — broken rather than unlucky.',
  SPEND_CAP_EXHAUSTED: 'The organisation’s daily budget is spent, so nothing else will execute.',
};

export function Taxonomy(): React.JSX.Element {
  return (
    <section>
      <h2 className="eyebrow eyebrow--ruled">What it catches</h2>
      <p className="landing__note">
        Ten deterministic checks. Each compares a measured value against a threshold, so an
        incident can be argued with rather than merely trusted — and a failure that is not on this
        list will not be found.
      </p>

      <dl className="taxonomy">
        {INCIDENT_CLASSES.map((incidentClass) => (
          <div className="taxonomy__item" key={incidentClass}>
            <dt className="taxonomy__class">{incidentClass}</dt>
            <dd className="taxonomy__line">{DESCRIPTIONS[incidentClass]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
