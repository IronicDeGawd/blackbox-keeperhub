import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';
import { Chaos } from '../pages/chaos/Chaos';

export const chaosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chaos',
  component: Chaos,
});
