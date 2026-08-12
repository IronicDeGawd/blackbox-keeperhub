import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';
import { Connections } from '../pages/connections/Connections';

export const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connections',
  component: Connections,
});
