import type { IncidentEvent } from './types';

/**
 * Event kinds and labels.
 *
 * The mock sends `kind` and `label`; the server sends neither, and instead
 * sends `nonce`, `status`, `blockNumber` and `simulationSuccess`
 * (packages/api/src/serialise.ts). Both shapes have to render, so what is
 * missing is derived rather than assumed — an event with no `kind` is a normal
 * event from the real API, not a broken one.
 */

export type EventKind = 'submission' | 'detection' | 'rca' | 'remediation' | 'inclusion';

const SETTLED = new Set(['included', 'reverted']);

export function deriveKind(event: IncidentEvent): EventKind {
  if (event.kind) return event.kind;
  if (event.blockNumber !== null && event.blockNumber !== undefined) return 'inclusion';
  if (event.status && SETTLED.has(event.status)) return 'inclusion';
  return 'submission';
}

/** A mono glyph per kind. Distinct at a glance, and no emoji in a dense table. */
export const KIND_GLYPH: Record<EventKind, string> = {
  submission: '→',
  detection: '!',
  rca: '?',
  remediation: '⟳',
  inclusion: '✓',
};

export function deriveLabel(event: IncidentEvent): string {
  if (event.label) return event.label;

  const nonce = event.nonce !== null && event.nonce !== undefined ? ` at nonce ${event.nonce}` : '';

  switch (event.status) {
    case 'included':
      return `Included in block ${event.blockNumber ?? '?'}${nonce}`;
    case 'reverted':
      return `Reverted in block ${event.blockNumber ?? '?'}${nonce}`;
    case 'pending':
      return `Submitted${nonce}, still pending`;
    case 'rejected':
      // Pre-flight refused it, so it never reached the mempool: no hash, no
      // receipt, no gas. Saying "failed" would imply it ran.
      return `Rejected before submission${nonce}`;
    case 'dropped':
      return `Dropped from the mempool${nonce}`;
    case 'replaced':
      return `Replaced${nonce}`;
    default:
      return event.status ? `${event.status}${nonce}` : `Observed${nonce}`;
  }
}

/** The simulation note, when the event carries one. */
export function simulationNote(event: IncidentEvent): string | null {
  if (event.simulationSuccess === true) return 'simulated clean';
  if (event.simulationSuccess === false) return 'simulation predicted a revert';
  return null;
}
