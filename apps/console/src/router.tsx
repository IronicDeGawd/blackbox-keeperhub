import { createRouter } from '@tanstack/react-router';
import { rootRoute } from './routes/root';
import { timelineRoute } from './routes/timeline';
import { incidentRoute } from './routes/incident';

/**
 * Routes are declared in code rather than generated from the filesystem: the
 * console has five destinations, and a codegen step plus a generated file in
 * the tree costs more than it saves at that size.
 */
const routeTree = rootRoute.addChildren([timelineRoute, incidentRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
