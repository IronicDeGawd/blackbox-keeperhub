import type { Alert, AlertKind } from './alert.js';

/**
 * Where an alert goes, and whether it goes at all.
 *
 * Routing is per owner because the answer is a judgement about their team, not
 * about the failure: the same critical incident is a page for one operator and
 * a morning digest for another. The default is critical-only, which is the
 * setting least likely to make someone mute the whole thing.
 */

export type Route = {
  /** Channel name; resolved to a delivery implementation by the caller. */
  channel: string;
  /** Nothing below this severity is delivered here. */
  minSeverity: 'info' | 'warning' | 'critical';
  /** Restrict to particular moments — e.g. resolutions only. */
  kinds?: readonly AlertKind[];
  /**
   * Local hours during which only critical alerts get through, as
   * `[startHour, endHour)` in the timezone offset given. A window that wraps
   * midnight (22 → 7) is the normal case and is handled.
   */
  quietHours?: { start: number; end: number; utcOffsetHours?: number };
};

export type RoutingPolicy = {
  routes: readonly Route[];
};

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 } as const;

/** What an operator gets before configuring anything. */
export const DEFAULT_POLICY: RoutingPolicy = {
  routes: [{ channel: 'default', minSeverity: 'critical' }],
};

/**
 * Which routes this alert should be delivered on.
 *
 * A resolution is delivered wherever the problem was reported, regardless of
 * quiet hours: telling someone at 3am that a thing broke and not telling them
 * it fixed itself is the worst of both. It is the same reasoning that keeps
 * critical alerts exempt — quiet hours exist to suppress noise, not to hide the
 * two messages that actually change what a person does.
 */
export function selectRoutes(alert: Alert, policy: RoutingPolicy = DEFAULT_POLICY): Route[] {
  return policy.routes.filter((route) => {
    if (SEVERITY_RANK[alert.severity] < SEVERITY_RANK[route.minSeverity]) return false;
    if (route.kinds && !route.kinds.includes(alert.kind)) return false;
    if (!route.quietHours) return true;
    if (alert.severity === 'critical' || alert.kind === 'resolved') return true;
    return !inQuietHours(alert.firedAt, route.quietHours);
  });
}

export function inQuietHours(
  at: Date,
  quiet: { start: number; end: number; utcOffsetHours?: number },
): boolean {
  const shifted = new Date(at.getTime() + (quiet.utcOffsetHours ?? 0) * 3_600_000);
  const hour = shifted.getUTCHours();
  // A window that wraps midnight is two ranges, not one.
  return quiet.start <= quiet.end
    ? hour >= quiet.start && hour < quiet.end
    : hour >= quiet.start || hour < quiet.end;
}
