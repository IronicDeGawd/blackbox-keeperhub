import { describe, expect, it } from 'vitest';
import { deriveKind, deriveLabel, simulationNote } from './events';
import type { IncidentEvent } from './types';

const event = (over: Partial<IncidentEvent>): IncidentEvent => ({
  id: 'evt-1',
  at: '2026-08-10T06:29:26.557Z',
  ...over,
});

describe('event kinds', () => {
  it('uses the kind when the sender supplied one', () => {
    expect(deriveKind(event({ kind: 'rca' }))).toBe('rca');
    expect(deriveKind(event({ kind: 'remediation' }))).toBe('remediation');
  });

  it('derives inclusion from a block number, which the real server sends', () => {
    expect(deriveKind(event({ blockNumber: 11453998, status: 'included' }))).toBe('inclusion');
    expect(deriveKind(event({ status: 'reverted' }))).toBe('inclusion');
  });

  it('treats an unsettled observation as a submission', () => {
    expect(deriveKind(event({ status: 'pending', txHash: '0xabc' }))).toBe('submission');
    expect(deriveKind(event({ status: 'rejected' }))).toBe('submission');
  });
});

describe('event labels', () => {
  it('uses the label when the sender supplied one', () => {
    expect(deriveLabel(event({ label: 'R2 fired — NONCE_GAP' }))).toBe('R2 fired — NONCE_GAP');
  });

  it('builds one from the fields the real server sends', () => {
    expect(deriveLabel(event({ status: 'included', blockNumber: 11453998, nonce: 47 }))).toBe(
      'Included in block 11453998 at nonce 47',
    );
    expect(deriveLabel(event({ status: 'pending', nonce: 51 }))).toBe(
      'Submitted at nonce 51, still pending',
    );
  });

  it('does not describe a rejected call as one that ran', () => {
    // Pre-flight refused it: no hash, no receipt, no gas spent.
    expect(deriveLabel(event({ status: 'rejected', nonce: 12 }))).toBe(
      'Rejected before submission at nonce 12',
    );
  });

  it('says something rather than nothing for an event with no status', () => {
    expect(deriveLabel(event({}))).toBe('Observed');
  });
});

describe('simulation note', () => {
  it('distinguishes a clean simulation, a predicted revert, and no simulation', () => {
    expect(simulationNote(event({ simulationSuccess: true }))).toBe('simulated clean');
    expect(simulationNote(event({ simulationSuccess: false }))).toBe(
      'simulation predicted a revert',
    );
    expect(simulationNote(event({}))).toBeNull();
    expect(simulationNote(event({ simulationSuccess: null }))).toBeNull();
  });
});
