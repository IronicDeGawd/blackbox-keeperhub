import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';
import { validateSearch } from './timeline';
import { IncidentsTable } from '../pages/incidents/IncidentsTable';

/**
 * The table view shares the timeline's search contract, so moving between the
 * two keeps whatever was filtered.
 */
export const incidentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/incidents',
  component: IncidentsTable,
  validateSearch,
});
