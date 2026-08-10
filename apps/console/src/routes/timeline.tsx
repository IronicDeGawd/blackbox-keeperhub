import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';

function Timeline(): React.JSX.Element {
  return (
    <section>
      <p className="eyebrow eyebrow--accent eyebrow--ruled">Timeline</p>
      <h1>Blackbox Console</h1>
    </section>
  );
}

export const timelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Timeline,
});
