import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';
import { Landing } from '../pages/landing/Landing';

export const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Landing,
});
