import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';
import { Incident } from '../pages/incident/Incident';

export const incidentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/incidents/$id',
  component: Incident,
});
