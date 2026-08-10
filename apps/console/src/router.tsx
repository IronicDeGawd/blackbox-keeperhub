import { createRouter } from '@tanstack/react-router';
import { rootRoute } from './routes/root';
import { timelineRoute } from './routes/timeline';
import { incidentRoute } from './routes/incident';
import { incidentsRoute } from './routes/incidents';
import { inspectRoute } from './routes/inspect';
import { watchedRoute } from './routes/watched';
import { chaosRoute } from './routes/chaos';

/**
 * Routes are declared in code rather than generated from the filesystem: the
 * console has five destinations, and a codegen step plus a generated file in
 * the tree costs more than it saves at that size.
 */
const routeTree = rootRoute.addChildren([
  timelineRoute,
  incidentRoute,
  incidentsRoute,
  inspectRoute,
  watchedRoute,
  chaosRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
