import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';

function Incident(): React.JSX.Element {
  const { id } = incidentRoute.useParams();
  return (
    <section>
      <p className="eyebrow eyebrow--accent eyebrow--ruled">Incident</p>
      <h1 className="mono">{id}</h1>
    </section>
  );
}

export const incidentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/incidents/$id',
  component: Incident,
});
