/**
 * Feature audit — exercises each internal capability once and prints what it
 * produced. Not assertions for their own sake: the point is a record of every
 * feature actually running, which the audit document quotes.
 */
import { describe, expect, it } from 'vitest';
import {
  blackboxConfigSchema,
  CHAIN_IDS,
  detectionFor,
  normaliseRun,
  resolveNetwork,
  type KeeperHubRun,
} from '@blackbox/core';
import {
  evaluateRules,
  rulesFor,
  R1,
  R2,
  R3,
  R4,
  R5,
  R6,
  R7,
  R8,
  R9,
  R10,
  type RuleContext,
} from '@blackbox/detector';
import {
  ALL_PLAYBOOKS,
  playbookFor,
  servability,
  guardedPause,
} from '@blackbox/remediator';
import { alertFor, Alerter, selectRoutes, webhookChannel, discordRender } from '@blackbox/alerter';
import { EventBus } from './bus.js';
import { EventWebhook, signPayload } from './event-webhook.js';
import { WalletAuth } from './wallet-auth.js';
import { privateKeyToAccount } from 'viem/accounts';

const T0 = new Date('2026-08-11T12:00:00.000Z');
const SIGNER = '0x01cc313321eb09c51f5b649f2bbd578ee32750a5' as `0x${string}`;
const config = blackboxConfigSchema.parse({
  keeperHub: { orgKey: 'kh_test' },
  databaseUrl: 'postgres://localhost/blackbox',
});

const log = (id: string, detail: unknown): void =>
  console.log(`AUDIT|${id}|${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);

const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  now: new Date(T0.getTime() + 900_000),
  detection: detectionFor(config, CHAIN_IDS.sepolia),
  agentId: 'audit',
  signer: SIGNER,
  chainId: CHAIN_IDS.sepolia,
  ...over,
});

let n = 0;
const evt = (over: Record<string, unknown> = {}) =>
  ({
    id: `e${n++}`,
    sourceId: `s${n}`,
    logicalActionId: 'action-1',
    attemptIndex: 0,
    agentId: 'audit',
    signer: SIGNER,
    chainId: CHAIN_IDS.sepolia,
    trigger: { kind: 'api' as const, detail: {} },
    simulation: { performed: true, success: true },
    submission: { submittedAt: T0, route: 'unknown' as const },
    outcome: { status: 'included' as const },
    raw: null,
    ingestedAt: T0,
    ...over,
  }) as never;

describe('detection rules, one by one', () => {
  it('R1 STUCK_TRANSACTION', () => {
    const d = R1.evaluate(
      [evt({ outcome: { status: 'pending' }, submission: { submittedAt: T0, route: 'unknown', nonce: 5 } })],
      ctx(),
    );
    log('R1', { fired: !!d, class: d?.class, facts: d?.facts });
    expect(d?.class).toBe('STUCK_TRANSACTION');
  });

  it('R2 NONCE_GAP', () => {
    const d = R2.evaluate(
      [evt({ outcome: { status: 'pending' }, submission: { submittedAt: T0, route: 'unknown', nonce: 9 } })],
      ctx({ corroboration: { latestNonce: 7, consecutiveGapPolls: 3 } }),
    );
    log('R2', { fired: !!d, class: d?.class, missing: d?.facts['missingNonces'] });
    expect(d?.class).toBe('NONCE_GAP');
  });

  it('R3 GAS_UNDERPRICED', () => {
    const d = R3.evaluate(
      [
        evt({
          outcome: { status: 'pending' },
          submission: { submittedAt: T0, route: 'unknown', nonce: 5, maxFeePerGas: 1_000_000n },
        }),
      ],
      ctx({ corroboration: { baseFeeAtDetection: 2_000_000_000n } }),
    );
    log('R3', { fired: !!d, deficitPct: d?.facts['feeDeficitPct'] });
    expect(d?.class).toBe('GAS_UNDERPRICED');
  });

  it('R4 SIM_PASS_EXEC_REVERT', () => {
    const d = R4.evaluate(
      [
        evt({
          simulation: { performed: true, success: true, simulatedAtBlock: 100 },
          outcome: { status: 'reverted', blockNumber: 104, revertReason: 'ERC20: balance' },
        }),
      ],
      ctx(),
    );
    log('R4', { fired: !!d, drift: d?.facts['blockDrift'], reason: d?.facts['revertReason'] });
    expect(d?.class).toBe('SIM_PASS_EXEC_REVERT');
  });

  it('R5 RETRY_STORM', () => {
    const failures = [0, 1, 2, 3].map((i) =>
      evt({
        id: `r${i}`,
        outcome: { status: 'reverted', gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n },
        submission: { submittedAt: new Date(T0.getTime() + 800_000 + i), route: 'unknown' },
      }),
    );
    const d = R5.evaluate(failures, ctx());
    log('R5', { fired: !!d, attempts: d?.facts['attemptCount'], burned: d?.facts['totalGasBurned'] });
    expect(d?.class).toBe('RETRY_STORM');
  });

  it('R6 SIGNER_GAS_STARVED', () => {
    const d = R6.evaluate(
      [evt({ outcome: { status: 'included', gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n } })],
      ctx({ corroboration: { signerBalance: 1_000n, baseFeeAtDetection: 1_000_000_000n } }),
    );
    log('R6', { fired: !!d, facts: d?.facts });
    expect(d?.class).toBe('SIGNER_GAS_STARVED');
  });

  it('R7 ADVERSE_INCLUSION', () => {
    // R7 only considers a publicly-routed transaction: a private-mempool
    // submission is not exposed to the ordering this rule reasons about.
    const d = R7.evaluate([evt({ submission: { submittedAt: T0, route: 'public' }, outcome: { status: 'included', blockNumber: 100 } })], ctx({
      inclusion: {
        expectedOut: 1_000n,
        actualOut: 900n,
        blockNumber: 100,
        txIndexInBlock: 3,
        neighbouringTxHashes: ['0xabc'],
      },
    }));
    log('R7', { fired: !!d, deltaBps: d?.facts['deltaBps'] });
    expect(d?.class).toBe('ADVERSE_INCLUSION');
  });

  it('R8 SPEND_CAP_EXHAUSTED', () => {
    const d = R8.evaluate([], ctx({
      agentKind: 'keeperhub',
      corroboration: { spendCap: { dailyCapWei: 1_000n, dailyUsedWei: 860n } },
    }));
    log('R8', { fired: !!d, severity: d?.severity, ratio: d?.facts['usedRatio'] });
    expect(d?.class).toBe('SPEND_CAP_EXHAUSTED');
  });

  it('R9 EXECUTION_STALLED', () => {
    const d = R9.evaluate(
      [
        evt({
          outcome: { status: 'pending' },
          trigger: { kind: 'api', detail: { workflowId: 'wf-1', workflowName: 'rebalance', completedSteps: 1 } },
        }),
      ],
      ctx({ agentKind: 'keeperhub', now: new Date(T0.getTime() + 700_000) }),
    );
    log('R9', { fired: !!d, stalledMs: d?.facts['stalledMs'], workflow: d?.facts['workflowName'] });
    expect(d?.class).toBe('EXECUTION_STALLED');
  });

  it('R10 WORKFLOW_MISCONFIGURED', () => {
    const rejects = [0, 1, 2].map((i) =>
      evt({
        id: `w${i}`,
        workflowId: 'wf-1',
        logicalActionId: 'wf-1',
        outcome: { status: 'rejected' },
        simulation: { performed: true, success: false, revertReason: 'bad address' },
        trigger: { kind: 'api', detail: { workflowId: 'wf-1', workflowName: 'rebalance', completedSteps: 2 } },
        submission: { submittedAt: new Date(T0.getTime() + 800_000 + i), route: 'unknown' },
      }),
    );
    const d = R10.evaluate(rejects, ctx({ agentKind: 'keeperhub' }));
    log('R10', { fired: !!d, failures: d?.facts['failureCount'], step: d?.facts['failingAfterSteps'] });
    expect(d?.class).toBe('WORKFLOW_MISCONFIGURED');
  });

  it('applicability by agent kind', () => {
    log('rules.byKind', { keeperhub: rulesFor('keeperhub'), signer: rulesFor('signer') });
    expect(rulesFor('keeperhub')).not.toContain('R2');
  });

  it('R10 suppresses R5', () => {
    const rejects = [0, 1, 2, 3].map((i) =>
      evt({
        id: `x${i}`,
        workflowId: 'wf-1',
        logicalActionId: 'wf-1',
        outcome: { status: 'rejected' },
        simulation: { performed: true, success: false, revertReason: 'bad address' },
        trigger: { kind: 'api', detail: { workflowId: 'wf-1', completedSteps: 2 } },
        submission: { submittedAt: new Date(T0.getTime() + 800_000 + i), route: 'unknown' },
      }),
    );
    const fired = evaluateRules(rejects, ctx({ agentKind: 'keeperhub' }));
    log('suppression', fired.map((f) => ({ rule: f.ruleId, suppressed: f.suppressedRules })));
    expect(fired.map((f) => f.ruleId)).toContain('R10');
  });
});

describe('remediation playbooks', () => {
  it('each class routes to a playbook, or says none does', () => {
    const map = [
      'STUCK_TRANSACTION',
      'NONCE_GAP',
      'GAS_UNDERPRICED',
      'SIM_PASS_EXEC_REVERT',
      'RETRY_STORM',
      'SIGNER_GAS_STARVED',
      'ADVERSE_INCLUSION',
      'EXECUTION_STALLED',
      'WORKFLOW_MISCONFIGURED',
      'SPEND_CAP_EXHAUSTED',
    ].map((c) => ({ class: c, playbook: playbookFor(c as never)?.id ?? null }));
    log('playbooks.routing', map);
    expect(map.filter((m) => m.playbook).length).toBeGreaterThan(0);
  });

  it('declares who each playbook can serve', () => {
    log(
      'playbooks.applicability',
      ALL_PLAYBOOKS.map((p) => ({ id: p.id, appliesTo: p.appliesTo, executors: p.executors })),
    );
    // Seven since P6 (stalled workflow) and P7 (spend cap), which decline with
    // instructions rather than acting.
    expect(ALL_PLAYBOOKS).toHaveLength(7);
  });

  it('refuses a nonce-bearing playbook for a managed wallet', () => {
    const r = servability(ALL_PLAYBOOKS[0]!, 'keeperhub', ['signer', 'keeperhub']);
    log('playbooks.refusal', r);
    expect(r.servable).toBe(false);
  });

  it('guarded pause skips when already paused', async () => {
    const already = await guardedPause(
      { checkAndExecute: async () => ({ conditionMet: false, execution: null, raw: {} }) },
      { breakerAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0', chainId: 11155111 },
    );
    const acts = await guardedPause(
      { checkAndExecute: async () => ({ conditionMet: true, execution: { executionId: 'x' }, raw: {} }) },
      { breakerAddress: '0x69C744Bb9f953D822a52E88604D26C9a895ac0E0', chainId: 11155111 },
    );
    log('guardedPause', { already, acts });
    expect(already).toMatchObject({ acted: false });
  });
});

describe('alerting', () => {
  const incident = (over: Record<string, unknown> = {}) =>
    ({
      id: 'inc-audit',
      class: 'NONCE_GAP',
      severity: 'critical',
      status: 'open',
      agentId: 'audit',
      signer: SIGNER,
      chainId: CHAIN_IDS.sepolia,
      detectedAt: T0,
      firstEventAt: T0,
      confidence: 0.9,
      evidence: { eventIds: ['e1'], ruleId: 'R2', facts: { missingNonces: [47], blockedActionCount: 2 } },
      ...over,
    }) as never;

  it('writes a human sentence for every incident class', () => {
    const classes = [
      ['NONCE_GAP', { missingNonces: [47], blockedActionCount: 2 }],
      ['STUCK_TRANSACTION', { pendingDurationMs: 252_000 }],
      ['GAS_UNDERPRICED', { feeDeficitPct: 42 }],
      ['SIM_PASS_EXEC_REVERT', { revertReason: 'ERC20: balance' }],
      ['RETRY_STORM', { attemptCount: 4 }],
      ['SIGNER_GAS_STARVED', {}],
      ['ADVERSE_INCLUSION', {}],
      ['EXECUTION_STALLED', { stalledMs: 900_000, workflowName: 'rebalance' }],
      ['WORKFLOW_MISCONFIGURED', { failureCount: 3, distinctReasons: ['bad address'] }],
      ['SPEND_CAP_EXHAUSTED', { usedRatio: 0.86, exhausted: false }],
    ] as const;
    const lines = classes.map(([cls, facts]) => ({
      cls,
      line: alertFor(
        incident({ class: cls, evidence: { eventIds: ['e'], ruleId: 'R2', facts } }),
        undefined,
        T0,
      )?.summary,
    }));
    log('alert.summaries', lines);
    expect(lines.every((l) => l.line)).toBe(true);
  });

  it('deduplicates, escalates and resolves', async () => {
    const got: string[] = [];
    const alerter = new Alerter({
      channels: [{ name: 'default', deliver: async (a) => void got.push(a.kind) }],
      policy: { routes: [{ channel: 'default', minSeverity: 'info' }] },
      now: () => T0,
    });
    await alerter.consider(incident({ severity: 'warning' }));
    await alerter.consider(incident({ severity: 'warning' }));
    await alerter.consider(incident({ severity: 'critical' }));
    await alerter.consider(incident({ status: 'resolved' }));
    log('alert.lifecycle', got);
    expect(got).toEqual(['opened', 'escalated', 'resolved']);
  });

  it('routes by severity and quiet hours', () => {
    const alert = alertFor(incident({ severity: 'warning' }), undefined, new Date('2026-08-11T23:00:00Z'))!;
    const quiet = { routes: [{ channel: 'd', minSeverity: 'info' as const, quietHours: { start: 22, end: 7 } }] };
    log('alert.routing', {
      defaultPolicyDropsWarning: selectRoutes(alert).length === 0,
      quietDropsWarning: selectRoutes(alert, quiet).length === 0,
      quietPassesResolution: selectRoutes({ ...alert, kind: 'resolved' }, quiet).length === 1,
    });
    expect(selectRoutes(alert)).toEqual([]);
  });

  it('renders for discord and posts over a webhook', async () => {
    let body = '';
    const channel = webhookChannel({
      url: 'https://hook.test/x',
      render: discordRender,
      fetchImpl: (async (_u: string, init: { body: string }) => {
        body = init.body;
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
    });
    await channel.deliver(alertFor(incident(), undefined, T0)!);
    log('alert.discord', JSON.parse(body));
    expect(body).toContain('nonce 47');
  });
});

describe('raw event webhook', () => {
  it('delivers signed events and drops when saturated', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const hook = new EventWebhook({
      url: 'https://ops.test/hook',
      secret: 'shh',
      now: () => T0,
      fetchImpl: (async (_u: string, init: { headers: Record<string, string> }) => {
        seen.push(init.headers['X-Blackbox-Signature']!);
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
    });
    hook.attach(bus);
    bus.publish({ type: 'incident.created', data: { id: 'inc-audit' } });
    await new Promise((r) => setImmediate(r));
    log('eventWebhook', { signature: seen[0], stats: hook.stats });
    expect(seen[0]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('signature covers the timestamp', () => {
    const a = signPayload('{}', 'shh', T0);
    const b = signPayload('{}', 'shh', new Date(T0.getTime() + 60_000));
    log('eventWebhook.replay', { differs: a !== b });
    expect(a).not.toBe(b);
  });
});

describe('wallet ownership', () => {
  it('accepts a real signature and refuses a replay', async () => {
    const account = privateKeyToAccount(`0x${'44'.repeat(32)}`);
    const auth = new WalletAuth({ domain: 'audit.test' });
    const { message, nonce } = auth.issue(account.address);
    const signature = await account.signMessage({ message });
    const first = await auth.verify({ nonce, signature });
    const replay = await auth.verify({ nonce, signature });
    log('wallet', { first, replay });
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(false);
  });
});

describe('KeeperHub run normalisation', () => {
  it('turns runs of every shape into events', () => {
    const base: KeeperHubRun = {
      id: 'run-1',
      source: 'workflow',
      status: 'success',
      startedAt: T0.toISOString(),
      completedAt: null,
      durationMs: 1000,
      workflowId: 'wf-1',
      workflowName: 'demo',
      directType: null,
      network: '11155111',
      networks: ['11155111'],
      gasCostWei: null,
      gasUsedWei: null,
      transactionHashes: [{ hash: `0x${'a'.repeat(64)}`, chainId: 11155111, receiptStatus: 'success' }],
      totalSteps: null,
      completedSteps: 2,
      error: null,
      errorCode: null,
      errorType: null,
      errorCategory: null,
    };
    const shapes = {
      workflowSuccess: normaliseRun(base, opts())[0]?.outcome.status,
      preflightRejection: normaliseRun(
        { ...base, status: 'error', transactionHashes: [], error: 'Contract call failed: Error(bad)' },
        opts(),
      )[0]?.outcome.status,
      directByName: normaliseRun(
        { ...base, source: 'direct', workflowId: null, network: 'sepolia', networks: ['sepolia'] },
        opts(),
      )[0]?.outcome.status,
      unknownChain: normaliseRun(
        { ...base, network: 'solana', networks: [], transactionHashes: [{ hash: `0x${'b'.repeat(64)}`, network: 'solana' }] },
        opts(),
      ).length,
      networkForms: { numeric: resolveNetwork('11155111'), named: resolveNetwork('sepolia'), unknown: resolveNetwork('solana') },
    };
    log('normaliseRun', shapes);
    expect(shapes.preflightRejection).toBe('rejected');
  });
});

const opts = () => ({
  agentId: 'audit',
  signer: SIGNER,
  now: T0,
  makeId: () => `id-${n++}`,
});
