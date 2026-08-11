import { formatConfidence, formatWei } from '../../lib/format';
import type { Evidence as EvidenceType, IncidentClass } from '../../lib/types';
import { FactsTable } from '../../ui/FactsTable';
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
  const corroboration = evidence.corroboration ?? {};
  const corroborationKeys = Object.keys(corroboration) as (keyof typeof corroboration)[];
  const suppressed = evidence.suppressedRules ?? [];

  return (
    <section className="panel section">
      <header className="section__head">
        <h2 className="eyebrow eyebrow--accent">Evidence</h2>
        <div className="section__title">
          <RuleTag ruleId={evidence.ruleId} />
          <ClassBadge value={incidentClass} />
          <span className="section__gap" />
          <span className="dim mono">confidence {formatConfidence(confidence)}</span>
        </div>
      </header>

      <FactsTable facts={facts} incidentClass={incidentClass} />

      {corroborationKeys.length > 0 ? (
        <div className="subsection">
          <h3 className="eyebrow">Corroboration</h3>
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
          <h3 className="eyebrow">Suppressed rules</h3>
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
