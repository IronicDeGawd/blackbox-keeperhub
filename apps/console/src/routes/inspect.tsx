import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';
import { Inspect } from '../pages/inspect/Inspect';

export const inspectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inspect',
  component: Inspect,
});
