import { FACT_KEYS, THRESHOLD_KEYS, THRESHOLD_OF, formatFact } from '../lib/facts';
import type { IncidentClass } from '../lib/types';

/**
 * A rule's facts, with each measured value beside the threshold it was compared
 * against. Shared by the incident page and Inspect, which show the same thing:
 * Inspect is an incident's evidence without an incident record behind it.
 *
 * Keys are never renamed for display — what is on screen is what the rule wrote.
 */
export function FactsTable({
  facts,
  incidentClass,
}: {
  facts: Record<string, unknown>;
  incidentClass: IncidentClass | null | undefined;
}): React.JSX.Element {
  // Documented order first, so every incident of a class reads the same way,
  // then anything the rule emitted that the spec does not list.
  const documented = incidentClass ? (FACT_KEYS[incidentClass] ?? []) : [];
  const extra = Object.keys(facts).filter((key) => !documented.includes(key));
  const ordered = [...documented, ...extra].filter(
    (key) => key in facts && !THRESHOLD_KEYS.has(key),
  );

  if (ordered.length === 0) {
    return <p className="dim">The rule recorded no facts.</p>;
  }

  return (
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
      </tbody>
    </table>
  );
}
