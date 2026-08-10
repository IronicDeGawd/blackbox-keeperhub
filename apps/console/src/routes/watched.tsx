import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';
import { Watched } from '../pages/watched/Watched';

export const watchedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/watched',
  component: Watched,
});
