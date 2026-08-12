import type { ScanProgress, StreamEvent } from './types';

/**
 * The stream, as a line of text.
 *
 * The dashboard already shows the incidents. This shows the *events* — which
 * includes the ones that never become an incident: a scan sweeping blocks, a
 * remediation starting, a chaos run being induced. During a demo it is the
 * thing a viewer actually watches, and it is the most literal reading of the
 * word "console" the product has.
 *
 * Derivation lives here, apart from the store, because what each event says is
 * worth pinning in a test and the store is not.
 */

export type LogTone = 'critical' | 'warning' | 'good' | 'plain';

export type LogLine = {
  /** Unique per line, not per event: one incident produces many. */
  key: string;
  at: number;
  /** The short left-hand label. Fixed width in the stylesheet. */
  tag: string;
  text: string;
  tone: LogTone;
};

let counter = 0;

/**
 * A line for this event, or null when it does not deserve one.
 *
 * `stats.updated` is deliberately silent: it is a recomputation of numbers
 * already on screen, it arrives constantly, and a log it dominated would say
 * nothing about the agents being watched.
 */
export function logLine(event: StreamEvent, at: number = Date.now()): LogLine | null {
  const line = (tag: string, text: string, tone: LogTone = 'plain'): LogLine => ({
    key: `${at}-${(counter += 1)}`,
    at,
    tag,
    text,
    tone,
  });

  switch (event.type) {
    case 'hello':
      return line('open', 'stream open', 'good');

    case 'incident.created':
      return line(
        event.data.severity === 'critical' ? 'CRIT' : event.data.severity === 'warning' ? 'WARN' : 'INFO',
        `${event.data.class} · ${event.data.summary}`,
        event.data.severity === 'critical'
          ? 'critical'
          : event.data.severity === 'warning'
            ? 'warning'
            : 'plain',
      );

    case 'incident.updated':
      return line(
        'incident',
        `${event.data.id} → ${event.data.status}`,
        event.data.status === 'resolved' ? 'good' : 'plain',
      );

    case 'remediation.started':
      return line('fix', `${event.data.playbookId} started on ${event.data.incidentId}`);

    case 'remediation.succeeded':
      return line('fix', `${event.data.incidentId} fixed · ${event.data.txHash.slice(0, 12)}…`, 'good');

    case 'remediation.failed':
      return line('fix', `${event.data.incidentId} failed · ${event.data.reason}`, 'critical');

    case 'chaos.started':
      return line('chaos', `${event.data.scenario} induced`, 'warning');

    case 'chaos.completed':
      return line(
        'chaos',
        `${event.data.scenario} done · ${event.data.incidentIds.length} incident${
          event.data.incidentIds.length === 1 ? '' : 's'
        }`,
        'warning',
      );

    case 'scan.progress':
      return line('scan', scanText(event.data));

    case 'stats.updated':
      return null;

    default:
      return null;
  }
}

function scanText(scan: ScanProgress): string {
  return [
    `blocks ${scan.fromBlock}–${scan.toBlock}`,
    `${scan.matched} matched`,
    `${scan.watching} watched`,
  ].join(' · ');
}

/** Newest last, oldest dropped. A long session must not grow without bound. */
export const LOG_CAP = 200;

export function appendLine(log: readonly LogLine[], next: LogLine | null): readonly LogLine[] {
  if (!next) return log;
  const appended = [...log, next];
  return appended.length > LOG_CAP ? appended.slice(appended.length - LOG_CAP) : appended;
}
