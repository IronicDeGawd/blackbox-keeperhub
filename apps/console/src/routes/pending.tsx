import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';

/**
 * Destinations the nav offers but this build does not serve yet.
 *
 * They say so plainly rather than rendering an empty page: an operator cannot
 * tell "nothing here" from "not built" by looking, and guessing wrong about
 * which one it is wastes an incident.
 */
function Pending({ title, summary }: { title: string; summary: string }): React.JSX.Element {
  return (
    <section className="page">
      <p className="eyebrow eyebrow--accent eyebrow--ruled">{title}</p>
      <div className="panel panel--accent notice">
        <p className="notice__lead">Not built yet.</p>
        <p className="soft">{summary}</p>
      </div>
    </section>
  );
}

// Generic over the path so the literal survives into the router's route types;
// a widened `string` would make every Link to these destinations a type error.
const pending = <P extends string>(path: P, title: string, summary: string) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <Pending title={title} summary={summary} />,
  });

export const incidentsRoute = pending(
  '/incidents',
  'Incidents',
  'The same incidents as the timeline, as a filterable table. The timeline carries the filters today.',
);

export const inspectRoute = pending(
  '/inspect',
  'Inspect',
  'Paste any transaction hash and Blackbox explains it, with nothing registered and nothing installed.',
);

export const watchedRoute = pending(
  '/watched',
  'Watched addresses',
  'Register an address and its transactions are discovered by scanning blocks. Nothing is installed on the watched agent.',
);

export const chaosRoute = pending(
  '/chaos',
  'Chaos',
  'Induce each failure class against real testnet contracts. Every scenario here spends real testnet gas.',
);
