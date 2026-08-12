import { formatFact } from '../../lib/facts';
import { ClassBadge, RuleTag, SeverityDot, StatusPill } from '../../ui/primitives';

/**
 * One incident, rendered by the console's own components.
 *
 * Every competitor claims detection. Showing the actual output — the class,
 * the rule, and the measured value beside the threshold it was compared
 * against — is the claim and its proof in one object, and it costs nothing
 * because the parts already exist.
 *
 * The values are from a real incident on the public deployment, the same one
 * the arc below traces. It is captioned as a specimen rather than left to look
 * like a live feed: an instrument on the front page is exactly what this page
 * stopped having.
 */

/** The facts R2 emitted, and what each was judged against. */
const FACTS: { key: string; value: unknown; against?: { key: string; value: unknown } }[] = [
  { key: 'missingNonces', value: [122] },
  { key: 'blockedActionCount', value: 1 },
  {
    key: 'consecutiveGapPolls',
    value: 5,
    against: { key: 'nonceGapConfirmations', value: 2 },
  },
  { key: 'latestNonce', value: 122 },
  { key: 'highestSubmittedNonce', value: 123 },
];

export function Specimen(): React.JSX.Element {
  return (
    <figure className="specimen">
      <div className="specimen__head">
        <SeverityDot severity="critical" />
        <span className="row__sev row__sev--critical">critical</span>
        <ClassBadge value="NONCE_GAP" />
        <RuleTag ruleId="R2" />
        <StatusPill status="resolved" />
      </div>

      <p className="specimen__summary">Nonce 122 unfilled; 1 action blocked behind it</p>

      <dl className="specimen__facts">
        {FACTS.map((fact) => (
          <div className="specimen__fact" key={fact.key}>
            <dt>{fact.key}</dt>
            <dd className="num">
              {formatFact(fact.key, fact.value)}
              {fact.against ? (
                <span className="specimen__against">
                  {' '}
                  vs {formatFact(fact.against.key, fact.against.value)} required
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>

      <figcaption className="specimen__caption">
        One incident, as the console shows it. Not a live feed.
      </figcaption>
    </figure>
  );
}
