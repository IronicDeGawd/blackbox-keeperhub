import { describe, expect, it } from 'vitest';
import { FACT_KEYS, THRESHOLD_OF, formatFact } from './facts';
import { INCIDENT_CLASSES } from './types';
import { EM_DASH } from './format';

/**
 * These names have drifted before, and the only symptom was the word "unknown"
 * in the UI — indistinguishable from a fact that was genuinely absent. If a
 * rule renames a fact, this is the test that is supposed to fail.
 */
describe('fact keys', () => {
  it('covers every incident class', () => {
    for (const incidentClass of INCIDENT_CLASSES) {
      expect(FACT_KEYS[incidentClass].length).toBeGreaterThan(0);
    }
  });

  it('names R6 runway as projectedActionsRemaining, not runwayActions', () => {
    // The exact drift that shipped once. runwayActions is a real field, but it
    // belongs to the signer-health route, not to this rule.
    expect(FACT_KEYS.SIGNER_GAS_STARVED).toContain('projectedActionsRemaining');
    expect(FACT_KEYS.SIGNER_GAS_STARVED).not.toContain('runwayActions');
  });

  it('pairs every threshold with a fact from the same class', () => {
    for (const [measured, threshold] of Object.entries(THRESHOLD_OF)) {
      const owner = INCIDENT_CLASSES.find((c) => FACT_KEYS[c].includes(measured));
      expect(owner, `no class emits ${measured}`).toBeDefined();
      expect(FACT_KEYS[owner!], `${threshold} is not emitted beside ${measured}`).toContain(
        threshold,
      );
    }
  });

  it('renders every documented key without inventing a value', () => {
    for (const incidentClass of INCIDENT_CLASSES) {
      for (const key of FACT_KEYS[incidentClass]) {
        expect(formatFact(key, undefined)).toBe(EM_DASH);
      }
    }
  });
});

describe('fact formatting', () => {
  it('gives wei-valued facts a unit and full precision', () => {
    expect(formatFact('signerBalance', '38886020810000')).toBe('38886.02081 gwei');
    expect(formatFact('thresholdBalance', '131459295996000')).toBe('131459.295996 gwei');
    expect(formatFact('totalGasBurned', '2000000000000000000')).toBe('2 ETH');
  });

  it('renders durations as durations', () => {
    expect(formatFact('pendingDurationMs', 252_000)).toBe('4m 12s');
    expect(formatFact('stuckThresholdMs', 90_000)).toBe('1m 30s');
  });

  it('leaves counts, nonces and block numbers exactly as they came', () => {
    expect(formatFact('latestNonce', 47)).toBe('47');
    expect(formatFact('blockedActionCount', 1)).toBe('1');
    expect(formatFact('missingNonces', [47])).toBe('[47]');
    expect(formatFact('includedAtBlock', 11457999)).toBe('11457999');
  });

  it('labels swap amounts as base units rather than asserting a token', () => {
    // R7 does not identify what was swapped, so calling these ETH would be a
    // claim the rule never made — but a bare 18-digit integer gets misread.
    expect(formatFact('expectedOut', '1000000000000000000')).toBe(
      '1000000000000000000 base units',
    );
    expect(formatFact('actualOut', '959000000000000000')).toBe('959000000000000000 base units');
  });

  it('does not mistake a hash or a reason for a fee', () => {
    expect(formatFact('revertReason', 'trap sprung')).toBe('trap sprung');
    expect(formatFact('route', 'public')).toBe('public');
  });

  it('distinguishes false from missing', () => {
    expect(formatFact('observedFundingFailure', false)).toBe('false');
    expect(formatFact('corroborated', true)).toBe('true');
    expect(formatFact('gap', null)).toBe(EM_DASH);
  });
});
