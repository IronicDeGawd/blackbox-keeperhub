import { describe, expect, it } from 'vitest';
import { matchesFilters } from './store';
import type { IncidentSummary } from './types';

const incident: IncidentSummary = {
  id: 'inc-1',
  class: 'NONCE_GAP',
  severity: 'critical',
  status: 'open',
  agentId: 'chaos',
  signer: '0xb9c58185d09d0acf3b237cd45c67345e32e628ba',
  chainId: 11155111,
  summary: 'Nonce 47 unfilled; 1 action blocked behind it',
  detectedAt: '2026-08-10T06:29:26.557Z',
  lastSeenAt: '2026-08-10T06:31:06.557Z',
  resolvedAt: null,
  resolvedBy: null,
  confidence: 0.9,
  ruleId: 'R2',
  hasRca: false,
  remediationStatus: null,
  remediationTxHash: null,
};

describe('client-side filtering of pushed incidents', () => {
  it('keeps everything when nothing is filtered', () => {
    expect(matchesFilters(incident, {})).toBe(true);
  });

  it('matches on each field the server also filters on', () => {
    expect(matchesFilters(incident, { status: 'open' })).toBe(true);
    expect(matchesFilters(incident, { class: 'NONCE_GAP' })).toBe(true);
    expect(matchesFilters(incident, { severity: 'critical' })).toBe(true);
    expect(matchesFilters(incident, { agentId: 'chaos' })).toBe(true);
    expect(matchesFilters(incident, { chainId: 11155111 })).toBe(true);
  });

  it('excludes an incident that has moved out of the filtered status', () => {
    const diagnosing = { ...incident, status: 'diagnosing' } as IncidentSummary;
    expect(matchesFilters(diagnosing, { status: 'open' })).toBe(false);
  });

  it('compares a signer case-insensitively, since a UI sends it checksummed', () => {
    expect(
      matchesFilters(incident, { signer: '0xb9c58185d09D0aCf3b237cD45C67345E32e628BA' }),
    ).toBe(true);
  });

  it('requires every active filter to hold, not just one', () => {
    expect(matchesFilters(incident, { status: 'open', severity: 'warning' })).toBe(false);
  });

  it('treats chain 0 as a filter rather than as absent', () => {
    expect(matchesFilters(incident, { chainId: 0 })).toBe(false);
  });
});
