import { beforeEach, describe, expect, it } from 'vitest';
import { blackboxConfigSchema, detectionFor, CHAIN_IDS, incidentSchema } from '@blackbox/core';
import { IncidentTracker, incidentKey } from './lifecycle.js';
import { evaluateRules } from './index.js';
import { at, evt, resetSeq, SIGNER, T0 } from './fixtures.js';
import type { EvaluatedDraft } from './index.js';
import type { RuleContext } from './types.js';

const config = blackboxConfigSchema.parse({
  keeperHub: { orgKey: 'kh_test' },
  databaseUrl: 'postgres://localhost/blackbox',
});
const detection = detectionFor(config, CHAIN_IDS.sepolia);

const ctx = (overrides: Partial<RuleContext> = {}): RuleContext => ({
  now: at(200_000),
  detection,
  agentId: 'chaos',
  signer: SIGNER,
  chainId: CHAIN_IDS.sepolia,
  ...overrides,
});

const tracker = () => {
  let n = 0;
  return new IncidentTracker({ makeId: () => `inc-${n++}` });
};

const stuckDraft = (facts: Record<string, unknown> = { nonce: 5 }): EvaluatedDraft => ({
  class: 'STUCK_TRANSACTION',
  ruleId: 'R1',
  severity: 'warning',
  confidence: 0.6,
  eventIds: ['e0'],
  facts,
});

beforeEach(resetSeq);

describe('correlation', () => {
  it('creates one incident on first sighting', () => {
    const t = tracker();
    const res = t.ingest([stuckDraft()], [evt({ status: 'pending', nonce: 5 })], ctx());
    expect(res.created).toHaveLength(1);
    expect(res.created[0]!.status).toBe('open');
    expect(t.openIncidents()).toHaveLength(1);
  });

  it('appends to the same incident rather than duplicating on re-fire', () => {
    const t = tracker();
    const window = [evt({ id: 'e0', status: 'pending', nonce: 5 })];
    t.ingest([stuckDraft()], window, ctx());
    const second = t.ingest(
      [{ ...stuckDraft(), eventIds: ['e1'] }],
      window,
      ctx({ now: at(260_000) }),
    );

    expect(second.created).toHaveLength(0);
    expect(second.updated).toHaveLength(1);
    expect(t.openIncidents()).toHaveLength(1);
    expect(second.updated[0]!.evidence.eventIds).toEqual(['e0', 'e1']);
  });

  it('does not merge across different signers', () => {
    const t = tracker();
    const window = [evt({ status: 'pending', nonce: 5 })];
    t.ingest([stuckDraft()], window, ctx());
    const other = '0x00000000000000000000000000000000000000ff' as `0x${string}`;
    const res = t.ingest([stuckDraft()], window, ctx({ signer: other }));
    expect(res.created).toHaveLength(1);
    expect(t.openIncidents()).toHaveLength(2);
  });

  it('does not merge across different classes', () => {
    const t = tracker();
    const window = [evt({ status: 'pending', nonce: 5 })];
    t.ingest([stuckDraft()], window, ctx());
    const gap: EvaluatedDraft = { ...stuckDraft(), class: 'NONCE_GAP', ruleId: 'R2' };
    expect(t.ingest([gap], window, ctx()).created).toHaveLength(1);
  });

  it('starts a fresh incident once the causal window has elapsed', () => {
    const t = tracker();
    const window = [evt({ status: 'pending', nonce: 5 })];
    t.ingest([stuckDraft()], window, ctx());
    const later = t.ingest([stuckDraft()], window, ctx({ now: at(200_000 + 16 * 60_000) }));
    expect(later.created).toHaveLength(1);
    expect(t.openIncidents()).toHaveLength(1); // old one closed out
  });

  it('ratchets severity and confidence upward only', () => {
    const t = tracker();
    const window = [evt({ status: 'pending', nonce: 5 })];
    t.ingest([{ ...stuckDraft(), severity: 'critical', confidence: 0.95 }], window, ctx());
    const res = t.ingest(
      [{ ...stuckDraft(), severity: 'info', confidence: 0.2 }],
      window,
      ctx({ now: at(210_000) }),
    );
    expect(res.updated[0]!.severity).toBe('critical');
    expect(res.updated[0]!.confidence).toBe(0.95);
  });

  it('records suppressed rules on the incident', () => {
    const t = tracker();
    const e = evt({ status: 'pending', nonce: 5, maxFeePerGas: 100n, submittedAt: T0 });
    const drafts = evaluateRules([e], ctx({ corroboration: { baseFeeAtDetection: 1_000_000_000n } }));
    const res = t.ingest(drafts, [e], ctx({ corroboration: { baseFeeAtDetection: 1_000_000_000n } }));
    expect(res.created[0]!.class).toBe('GAS_UNDERPRICED');
    expect(res.created[0]!.evidence.suppressedRules).toEqual(['R1']);
  });
});

describe('resolution', () => {
  it('resolves a stuck transaction once its nonce reaches a terminal state', () => {
    const t = tracker();
    const pending = evt({ id: 'e0', status: 'pending', nonce: 5 });
    t.ingest([stuckDraft()], [pending], ctx());

    const landed = evt({ id: 'e1', status: 'included', nonce: 5 });
    const res = t.ingest([], [pending, landed], ctx({ now: at(260_000) }));
    expect(res.resolved).toHaveLength(1);
    expect(res.resolved[0]!.status).toBe('resolved');
    expect(t.openIncidents()).toHaveLength(0);
  });

  it('resolves when the nonce simply advances past it', () => {
    const t = tracker();
    const pending = evt({ status: 'pending', nonce: 5 });
    t.ingest([stuckDraft()], [pending], ctx());
    const res = t.ingest([], [pending], ctx({ corroboration: { latestNonce: 6 } }));
    expect(res.resolved).toHaveLength(1);
  });

  it('attributes resolution to the operator when Blackbox did not remediate', () => {
    const t = tracker();
    const pending = evt({ status: 'pending', nonce: 5 });
    t.ingest([stuckDraft()], [pending], ctx());
    const res = t.ingest([], [pending], ctx({ corroboration: { latestNonce: 6 } }));
    expect(res.resolved[0]!.resolvedBy).toBe('external');
  });

  it('attributes resolution to Blackbox when a remediation succeeded', () => {
    const t = tracker();
    const pending = evt({ status: 'pending', nonce: 5 });
    const { created } = t.ingest([stuckDraft()], [pending], ctx());
    created[0]!.remediation = { playbookId: 'P1', attempts: [], finalStatus: 'succeeded' };
    const res = t.ingest([], [pending], ctx({ corroboration: { latestNonce: 6 } }));
    expect(res.resolved[0]!.resolvedBy).toBe('blackbox');
  });

  it('leaves an incident open while it still stands', () => {
    const t = tracker();
    const pending = evt({ status: 'pending', nonce: 5 });
    t.ingest([stuckDraft()], [pending], ctx());
    const res = t.ingest([], [pending], ctx({ corroboration: { latestNonce: 5 } }));
    expect(res.resolved).toHaveLength(0);
    expect(t.openIncidents()).toHaveLength(1);
  });

  it('does not resolve an incident that is being remediated', () => {
    const t = tracker();
    const pending = evt({ status: 'pending', nonce: 5 });
    t.ingest([stuckDraft()], [pending], ctx());
    t.markStatus(incidentKey('chaos', SIGNER, CHAIN_IDS.sepolia, 'STUCK_TRANSACTION'), 'remediating');
    const landed = evt({ status: 'included', nonce: 5 });
    // The remediator owns the incident until it reports back; resolving it
    // underneath would drop the remediation record on the floor.
    expect(t.ingest([], [pending, landed], ctx()).resolved).toHaveLength(0);
  });

  it('resolves a nonce gap when the gap closes', () => {
    const t = tracker();
    const gap: EvaluatedDraft = {
      class: 'NONCE_GAP',
      ruleId: 'R2',
      severity: 'critical',
      confidence: 0.9,
      eventIds: ['e0'],
      facts: { latestNonce: 6, pendingNonce: 8 },
    };
    t.ingest([gap], [evt({ status: 'pending', nonce: 7 })], ctx());
    const res = t.ingest(
      [],
      [evt({ status: 'pending', nonce: 7 })],
      ctx({ corroboration: { latestNonce: 8, pendingNonce: 8 } }),
    );
    expect(res.resolved).toHaveLength(1);
  });

  it('resolves gas starvation once the balance recovers', () => {
    const t = tracker();
    const starved: EvaluatedDraft = {
      class: 'SIGNER_GAS_STARVED',
      ruleId: 'R6',
      severity: 'warning',
      confidence: 0.8,
      eventIds: ['e0'],
      facts: { thresholdBalance: '1000' },
    };
    t.ingest([starved], [], ctx());
    expect(t.ingest([], [], ctx({ corroboration: { signerBalance: 999n } })).resolved).toHaveLength(0);
    expect(t.ingest([], [], ctx({ corroboration: { signerBalance: 1000n } })).resolved).toHaveLength(1);
  });

  it('resolves a retry storm once attempts stop arriving', () => {
    const t = tracker();
    const storm: EvaluatedDraft = {
      class: 'RETRY_STORM',
      ruleId: 'R5',
      severity: 'critical',
      confidence: 0.9,
      eventIds: ['e0'],
      facts: { logicalActionId: 'action-1' },
    };
    const attempt = evt({ logicalActionId: 'action-1', status: 'reverted', submittedAt: at(0) });
    t.ingest([storm], [attempt], ctx({ now: at(1_000) }));
    // Still inside the retry window, so still storming.
    expect(t.ingest([], [attempt], ctx({ now: at(1_000) })).resolved).toHaveLength(0);
    // Window has moved past the last attempt.
    expect(t.ingest([], [attempt], ctx({ now: at(400_000) })).resolved).toHaveLength(1);
  });

  it('keeps an adverse inclusion open until something acts on it', () => {
    const t = tracker();
    const adverse: EvaluatedDraft = {
      class: 'ADVERSE_INCLUSION',
      ruleId: 'R7',
      severity: 'warning',
      confidence: 0.65,
      eventIds: ['e0'],
      facts: {},
    };
    const { created } = t.ingest([adverse], [], ctx());
    // Nothing onchain retracts it, so it must not silently disappear.
    expect(t.ingest([], [], ctx({ now: at(300_000) })).resolved).toHaveLength(0);

    created[0]!.remediation = { playbookId: 'P3', attempts: [], finalStatus: 'succeeded' };
    expect(t.ingest([], [], ctx({ now: at(310_000) })).resolved).toHaveLength(1);
  });
});

describe('produced incidents are schema-valid', () => {
  it('passes the core Incident schema', () => {
    const t = tracker();
    const e = evt({ status: 'pending', nonce: 5, submittedAt: T0 });
    const drafts = evaluateRules([e], ctx({ corroboration: { latestNonce: 5, baseFeeAtDetection: 1n } }));
    const { created } = t.ingest(drafts, [e], ctx({ corroboration: { latestNonce: 5 } }));
    for (const incident of created) {
      const { key, lastSeenAt, resolvedBy, ...rest } = incident;
      expect(incidentSchema.safeParse(rest).success).toBe(true);
    }
  });
});

describe('a rule and its resolution predicate disagreeing', () => {
  it('never resolves an incident on the tick a rule confirmed it', () => {
    const t = tracker();
    // A predicate that always claims resolution, i.e. the worst-case
    // disagreement with the rule that just fired.
    const alwaysResolvable: EvaluatedDraft = {
      class: 'NONCE_GAP',
      ruleId: 'R2',
      severity: 'critical',
      confidence: 0.9,
      eventIds: ['e0'],
      facts: { latestNonce: 37 },
    };
    const window = [evt({ status: 'pending', nonce: 38 })];
    const c = ctx({ corroboration: { latestNonce: 38, pendingNonce: 38 } });

    const res = t.ingest([alwaysResolvable], window, c);
    expect(res.created).toHaveLength(1);
    // Without this guard each poll produced a new incident that closed
    // instantly, which is how the bug looked in production.
    expect(res.resolved).toHaveLength(0);
    expect(t.openIncidents()).toHaveLength(1);
  });

  it('keeps a nonce gap open for as long as the hole exists', () => {
    const t = tracker();
    const gap: EvaluatedDraft = {
      class: 'NONCE_GAP',
      ruleId: 'R2',
      severity: 'critical',
      confidence: 0.9,
      eventIds: ['e0'],
      facts: { latestNonce: 37 },
    };
    const window = [evt({ id: 'e0', status: 'pending', nonce: 38 })];

    t.ingest([gap], window, ctx({ corroboration: { latestNonce: 37, pendingNonce: 37 } }));
    // A later tick where no rule fires: pending still equals latest, which is
    // exactly the state that used to resolve it wrongly.
    const second = t.ingest([], window, ctx({ corroboration: { latestNonce: 37, pendingNonce: 37 } }));
    expect(second.resolved).toHaveLength(0);
    expect(t.openIncidents()).toHaveLength(1);
  });

  it('resolves once the hole is actually filled', () => {
    const t = tracker();
    const gap: EvaluatedDraft = {
      class: 'NONCE_GAP',
      ruleId: 'R2',
      severity: 'critical',
      confidence: 0.9,
      eventIds: ['e0'],
      facts: { latestNonce: 37 },
    };
    const window = [evt({ id: 'e0', status: 'pending', nonce: 38 })];
    t.ingest([gap], window, ctx({ corroboration: { latestNonce: 37 } }));

    const settled = [evt({ id: 'e0', status: 'included', nonce: 38 })];
    const res = t.ingest([], settled, ctx({ corroboration: { latestNonce: 39 } }));
    expect(res.resolved).toHaveLength(1);
  });
});

describe('attachRemediation', () => {
  it('makes a Blackbox-fixed incident resolve as blackbox rather than external', () => {
    const t = tracker();
    const created = t.ingest([stuckDraft()], [evt({ status: 'pending', nonce: 5 })], ctx()).created[0]!;

    expect(
      t.attachRemediation(created.id, {
        playbookId: 'P1',
        attempts: [],
        finalStatus: 'succeeded',
      }),
    ).toBe(true);

    // Stops firing, and the stuck transaction is now confirmed.
    const resolved = t.ingest(
      [],
      [evt({ status: 'included', nonce: 5 })],
      ctx({ now: at(320_000) }),
    ).resolved;
    expect(resolved[0]?.resolvedBy).toBe('blackbox');
  });

  it('reports false for an incident it is no longer holding', () => {
    const t = tracker();
    expect(
      t.attachRemediation('nope', { playbookId: 'P1', attempts: [], finalStatus: 'succeeded' }),
    ).toBe(false);
  });
});

describe('attribution of a user-signed remediation', () => {
  const remediated = (executor?: string) => ({
    playbookId: 'P2',
    finalStatus: 'succeeded' as const,
    attempts: [
      {
        attemptIndex: 0,
        startedAt: T0,
        guardsPassed: [],
        guardsFailed: [],
        status: 'succeeded' as const,
        ...(executor ? { executor } : {}),
      },
    ],
  });

  it('credits Blackbox when Blackbox submitted it', () => {
    const t = tracker();
    const created = t.ingest([stuckDraft()], [evt({ status: 'pending', nonce: 5 })], ctx()).created[0]!;
    t.attachRemediation(created.id, remediated('signer') as never);

    const resolved = t.ingest([], [evt({ status: 'included', nonce: 5 })], ctx({ now: at(320_000) }))
      .resolved;
    expect(resolved[0]?.resolvedBy).toBe('blackbox');
  });

  it('says proposed when a wallet signed what Blackbox planned', () => {
    // Overstating this would make every "resolved by blackbox" less believable.
    const t = tracker();
    const created = t.ingest([stuckDraft()], [evt({ status: 'pending', nonce: 5 })], ctx()).created[0]!;
    t.attachRemediation(created.id, remediated('user-signed') as never);

    const resolved = t.ingest([], [evt({ status: 'included', nonce: 5 })], ctx({ now: at(320_000) }))
      .resolved;
    expect(resolved[0]?.resolvedBy).toBe('blackbox-proposed');
  });
});
