import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './root';
import { Timeline } from '../pages/timeline/Timeline';
import {
  INCIDENT_CLASSES,
  INCIDENT_STATUSES,
  SEVERITIES,
  type IncidentClass,
  type IncidentStatus,
  type Severity,
} from '../lib/types';

export type TimelineSearch = {
  class?: IncidentClass;
  severity?: Severity;
  status?: IncidentStatus;
  agentId?: string;
  chainId?: number;
};

/**
 * Clearing a filter means setting it to undefined, which under
 * exactOptionalPropertyTypes is a different thing from omitting the key.
 */
export type TimelineSearchPatch = {
  [K in keyof TimelineSearch]?: TimelineSearch[K] | undefined;
};

const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined =>
  typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

/**
 * Filter state is read from the URL and validated against the vocabulary the
 * rules emit. A hand-edited or stale link with a class that no longer exists
 * drops that one filter rather than rendering an empty list with no
 * explanation for why.
 */
export function validateSearch(search: Record<string, unknown>): TimelineSearch {
  const parsed: TimelineSearch = {};

  const incidentClass = oneOf(INCIDENT_CLASSES, search['class']);
  if (incidentClass) parsed.class = incidentClass;

  const severity = oneOf(SEVERITIES, search['severity']);
  if (severity) parsed.severity = severity;

  const status = oneOf(INCIDENT_STATUSES, search['status']);
  if (status) parsed.status = status;

  const agentId = search['agentId'];
  if (typeof agentId === 'string' && agentId !== '') parsed.agentId = agentId;

  const chainId = Number(search['chainId']);
  if (Number.isInteger(chainId) && chainId > 0) parsed.chainId = chainId;

  return parsed;
}

export const timelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/timeline',
  component: Timeline,
  validateSearch,
});
