import { FACT_KEYS, THRESHOLD_KEYS, THRESHOLD_OF, formatFact } from '../../lib/facts';
import { formatConfidence, formatWei } from '../../lib/format';
import type { Evidence as EvidenceType, IncidentClass } from '../../lib/types';
import { ClassBadge, RuleTag } from '../../ui/primitives';

/**
 * The measured facts that tripped the rule.
 *
 * This panel comes before the narrative on purpose: the mechanical facts are
 * what make the narrative trustworthy, and reading them in the other order
 * invites believing the story and skimming the evidence.
 *
 * Facts are never renamed for display. The key shown is the key the rule wrote,
 * so it can be grepped for in the detector.
 */
export function Evidence({
  evidence,
  incidentClass,
  confidence,
}: {
  evidence: EvidenceType;
  incidentClass: IncidentClass;
  confidence: number;
}): React.JSX.Element {
  const facts = evidence.facts ?? {};

  // Documented order first so the panel reads the same for every incident of a
  // class, then anything the rule emitted that the spec does not list.
  const documented = FACT_KEYS[incidentClass] ?? [];
  const extra = Object.keys(facts).filter((key) => !documented.includes(key));
  const ordered = [...documented, ...extra].filter(
    (key) => key in facts && !THRESHOLD_KEYS.has(key),
  );

  const corroboration = evidence.corroboration ?? {};
  const corroborationKeys = Object.keys(corroboration) as (keyof typeof corroboration)[];
  const suppressed = evidence.suppressedRules ?? [];

  return (
    <section className="panel section">
      <header className="section__head">
        <p className="eyebrow eyebrow--accent">Evidence</p>
        <div className="section__title">
          <RuleTag ruleId={evidence.ruleId} />
          <ClassBadge value={incidentClass} />
          <span className="section__gap" />
          <span className="dim mono">confidence {formatConfidence(confidence)}</span>
        </div>
      </header>

      <table className="facts">
        <tbody>
          {ordered.map((key) => {
            const thresholdKey = THRESHOLD_OF[key];
            const hasThreshold = thresholdKey !== undefined && thresholdKey in facts;
            return (
              <tr key={key}>
                <th scope="row">{key}</th>
                <td className="num" title={String(facts[key])}>
                  {formatFact(key, facts[key])}
                </td>
                <td className="facts__threshold">
                  {hasThreshold ? (
                    <>
                      <span className="dim">{thresholdKey}</span>{' '}
                      <span className="num">{formatFact(thresholdKey, facts[thresholdKey])}</span>
                    </>
                  ) : null}
                </td>
              </tr>
            );
          })}
          {ordered.length === 0 ? (
            <tr>
              <td colSpan={3} className="dim">
                The rule recorded no facts.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {corroborationKeys.length > 0 ? (
        <div className="subsection">
          <p className="eyebrow">Corroboration</p>
          {/* Independent readings taken from the chain at detection time. This
              is what separates a claim from a measurement. */}
          <p className="subsection__note soft">
            Read from the chain at detection time, independently of the events above.
          </p>
          <table className="facts">
            <tbody>
              {corroborationKeys.map((key) => {
                const value = corroboration[key];
                const isWei = key === 'signerBalance' || key === 'baseFeeAtDetection';
                return (
                  <tr key={key}>
                    <th scope="row">{key}</th>
                    <td className="num" title={String(value)}>
                      {isWei ? formatWei(value, true) : String(value)}
                    </td>
                    <td />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {suppressed.length > 0 ? (
        <div className="subsection">
          <p className="eyebrow">Suppressed rules</p>
          {/* A hidden R1 underneath an R3 is otherwise baffling: the operator
              sees one incident where two rules fired. */}
          <p className="subsection__note soft">
            These also fired and were suppressed by a more specific rule:{' '}
            <span className="mono">{suppressed.join(', ')}</span>.
          </p>
        </div>
      ) : null}
    </section>
  );
}
