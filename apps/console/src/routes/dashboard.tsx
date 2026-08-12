import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';
import { Dashboard } from '../pages/dashboard/Dashboard';

export const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard',
  component: Dashboard,
});
