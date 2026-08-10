import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { blackboxConfigSchema, CHAIN_IDS, type BlackboxConfig } from '@blackbox/core';
import {
  createDb,
  incidents,
  recordRemediationAttempt,
  remediationLedger,
  saveIncident,
  watchedSigners,
  type Database,
} from '@blackbox/store';
import { buildApp } from './app.js';
import { EventBus } from './bus.js';
import { summarise } from './serialise.js';

const URL = process.env['DATABASE_URL'] ?? 'postgres://blackbox:blackbox@localhost:5433/blackbox';
const SIGNER = '0xb9c58185d09d0acf3b237cd45c67345e32e628ba';
const T0 = new Date('2026-08-10T12:00:00.000Z');

let db: Database;
let close: () => Promise<void>;

beforeAll(() => {
  ({ db, close } = createDb(URL));
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await db.delete(remediationLedger);
  await db.delete(incidents);
  await db.delete(watchedSigners);
});

const config = (): BlackboxConfig =>
  blackboxConfigSchema.parse({ keeperHub: { orgKey: 'kh_test' }, databaseUrl: URL });

const row = (over: Record<string, unknown> = {}) => ({
  id: 'inc-1',
  key: 'k',
  class: 'NONCE_GAP',
  severity: 'critical',
  status: 'open',
  agentId: 'chaos',
  signer: SIGNER,
  chainId: CHAIN_IDS.sepolia,
  detectedAt: T0,
  firstEventAt: new Date(T0.getTime() - 60_000),
  lastSeenAt: T0,
  ruleId: 'R2',
  confidence: 0.9,
  evidence: {
    eventIds: ['e0'],
    ruleId: 'R2',
    facts: { missingNonces: [47], blockedActionCount: 1 },
  },
  ...over,
});

const app = async (over = {}): Promise<FastifyInstance> =>
  buildApp({ db, config: config(), ...over });

describe('reading incidents', () => {
  it('lists incidents with a derived one-line summary', async () => {
    await saveIncident(db, row() as never);
    const res = await (await app()).inject({ method: 'GET', url: '/api/incidents' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].summary).toContain('Nonce 47 unfilled');
    expect(body.items[0].ruleId).toBe('R2');
  });

  it('passes filters through to the query', async () => {
    await saveIncident(db, row({ id: 'a' }) as never);
    await saveIncident(db, row({ id: 'b', severity: 'warning' }) as never);

    const res = await (await app()).inject({ url: '/api/incidents?severity=warning' });
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual(['b']);
  });

  it('returns the evidence, events and explorer links on the detail route', async () => {
    await saveIncident(db, row() as never);
    await recordRemediationAttempt(db, {
      id: 'rem-1',
      incidentId: 'inc-1',
      playbookId: 'P2',
      signer: SIGNER,
      chainId: CHAIN_IDS.sepolia,
      attemptedAt: T0,
      status: 'succeeded',
      txHash: `0x${'a'.repeat(64)}`,
    });

    const body = (await (await app()).inject({ url: '/api/incidents/inc-1' })).json();
    expect(body.evidence.facts.missingNonces).toEqual([47]);
    expect(body.events).toEqual([]);
    expect(body.explorerUrls[0]).toContain('sepolia.etherscan.io');
  });

  it('404s an unknown incident with a readable detail', async () => {
    const res = await (await app()).inject({ url: '/api/incidents/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    expect(res.json().detail).toContain('nope');
  });

  it('reports wei as a decimal string, never a number', async () => {
    await recordRemediationAttempt(db, {
      id: 'rem-1',
      incidentId: 'inc-1',
      playbookId: 'P2',
      signer: SIGNER,
      chainId: CHAIN_IDS.sepolia,
      attemptedAt: T0,
      gasSpentWei: 9_000_000_000_000_000_000n,
      status: 'succeeded',
    });
    const body = (await (await app()).inject({ url: '/api/stats' })).json();
    // A JSON number here would be silently wrong above 2^53.
    expect(body.remediations.gasWei).toBe('9000000000000000000');
    expect(typeof body.remediations.gasWei).toBe('string');
  });
});

describe('acknowledging', () => {
  it('moves the incident out of the open set and announces it', async () => {
    await saveIncident(db, row() as never);
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));

    const res = await (await app({ bus })).inject({
      method: 'POST',
      url: '/api/incidents/inc-1/acknowledge',
    });

    expect(res.json().status).toBe('acknowledged');
    expect(seen).toEqual(['incident.updated']);
  });
});

describe('remediating', () => {
  it('does not expose the route at all when the process cannot remediate', async () => {
    await saveIncident(db, row() as never);
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/incidents/inc-1/remediate',
    });
    expect(res.statusCode).toBe(404);
  });

  it('accepts with 202 when it will act', async () => {
    await saveIncident(db, row() as never);
    const remediate = vi.fn(async () => ({ accepted: true, playbookId: 'P2', attemptId: 'rem-1' }));
    const res = await (await app({ remediate })).inject({
      method: 'POST',
      url: '/api/incidents/inc-1/remediate',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true, playbookId: 'P2' });
  });

  it('returns a guard refusal as 200, not as an error', async () => {
    // Blackbox declining with a stated reason is correct behaviour. Shaping it
    // like a failure pushes the console into rendering it as a red toast.
    await saveIncident(db, row() as never);
    const remediate = vi.fn(async () => ({
      accepted: false,
      finalStatus: 'skipped_by_guard',
      guardsFailed: [{ guard: 'chain_allowlist', reason: 'chain 84532 is not on the allowlist' }],
    }));
    const res = await (await app({ remediate })).inject({
      method: 'POST',
      url: '/api/incidents/inc-1/remediate',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().guardsFailed[0].guard).toBe('chain_allowlist');
  });
});

describe('watching an arbitrary address', () => {
  it('registers an address and lists it', async () => {
    const server = await app();
    const created = await server.inject({
      method: 'POST',
      url: '/api/watched',
      payload: { signer: '0xA17CB6ADB58277E5B4A44B8C1ECB449BB6614E87', agentId: 'judge' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().signer).toBe('0xa17cb6adb58277e5b4a44b8c1ecb449bb6614e87');

    const listed = await server.inject({ url: '/api/watched' });
    expect(listed.json().items).toHaveLength(1);
  });

  it('rejects something that is not an address', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/watched',
      payload: { signer: 'my-wallet' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_address');
  });

  it('rejects a chain it has no configuration for', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/watched',
      payload: { signer: `0x${'a'.repeat(40)}`, chainId: 999 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_chain');
  });

  it('unwatching removes it from the active list', async () => {
    const server = await app();
    await server.inject({
      method: 'POST',
      url: '/api/watched',
      payload: { signer: `0x${'a'.repeat(40)}` },
    });
    await server.inject({ method: 'DELETE', url: `/api/watched/0x${'a'.repeat(40)}` });
    expect((await server.inject({ url: '/api/watched' })).json().items).toEqual([]);
  });
});

describe('diagnosing an arbitrary transaction', () => {
  it('is absent unless the process was given a diagnoser', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/diagnose',
      payload: { txHash: `0x${'a'.repeat(64)}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('explains any hash without anything being registered first', async () => {
    const diagnose = vi.fn(async () => ({ class: 'SIM_PASS_EXEC_REVERT', rca: { summary: 'x' } }));
    const res = await (await app({ diagnose })).inject({
      method: 'POST',
      url: '/api/diagnose',
      payload: { txHash: `0x${'a'.repeat(64)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().class).toBe('SIM_PASS_EXEC_REVERT');
    expect(diagnose).toHaveBeenCalledWith({
      txHash: `0x${'a'.repeat(64)}`,
      chainId: CHAIN_IDS.sepolia,
    });
  });

  it('rejects a malformed hash before doing any work', async () => {
    const diagnose = vi.fn();
    const res = await (await app({ diagnose })).inject({
      method: 'POST',
      url: '/api/diagnose',
      payload: { txHash: '0xdeadbeef' },
    });
    expect(res.statusCode).toBe(400);
    expect(diagnose).not.toHaveBeenCalled();
  });
});

describe('chaos', () => {
  const scenario = {
    id: 'C2',
    name: 'Nonce gap',
    induces: ['NONCE_GAP'],
    enabled: true,
    deterministic: true,
    note: '',
  };
  const chaos = {
    scenarios: () => [scenario, { ...scenario, id: 'C6', enabled: false, note: 'needs a fork' }],
    context: async () => ({
      chainId: CHAIN_IDS.sepolia,
      chainName: 'Ethereum Sepolia',
      isTestnet: true,
      signer: SIGNER,
      signerBalanceWei: '1',
      targets: {},
    }),
    run: vi.fn(async () => ({ runId: 'run-1', txHashes: [`0x${'a'.repeat(64)}`] })),
  };

  it('refuses a disabled scenario with the reason, rather than pretending to run it', async () => {
    const res = await (await app({ chaos })).inject({
      method: 'POST',
      url: '/api/chaos/run',
      payload: { scenario: 'C6' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe('needs a fork');
    expect(chaos.run).not.toHaveBeenCalled();
  });

  it('runs an enabled scenario and announces it', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));

    const res = await (await app({ chaos, bus })).inject({
      method: 'POST',
      url: '/api/chaos/run',
      payload: { scenario: 'C2' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().expectedIncidentClass).toBe('NONCE_GAP');
    expect(seen).toEqual(['chaos.started']);
  });

  it('404s an unknown scenario', async () => {
    const res = await (await app({ chaos })).inject({
      method: 'POST',
      url: '/api/chaos/run',
      payload: { scenario: 'C99' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('planning chaos for someone else to sign', () => {
  const OTHER = '0x00000000000000000000000000000000000000cc';
  const planner = async (over = {}) =>
    app({
      chaosPlan: {
        plan: async ({ scenario, signer }: { scenario: string; signer: string }) =>
          scenario === 'C9'
            ? { scenario, declined: 'no' }
            : { scenario, signer, steps: [{ order: 1 }] },
        // Stands in for the chain read: attribution comes back as the address
        // that actually signed, which is the point being tested below.
        observe: async ({ txHashes }: { txHashes: string[] }) => ({
          observed: txHashes.map((txHash, i) => ({ txHash, signer: OTHER, nonce: i })),
          ignored: [],
        }),
      },
      ...over,
    });

  it('404s when the process was not configured to plan', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/chaos/plan',
      payload: { scenario: 'C2', signer: SIGNER },
    });
    expect(res.statusCode).toBe(404);
  });

  it('registers the address so the loop runs without the caller reporting a hash', async () => {
    const res = await (await planner()).inject({
      method: 'POST',
      url: '/api/chaos/plan',
      payload: { scenario: 'C2', signer: SIGNER, chainId: CHAIN_IDS.sepolia },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().watching).toBe(true);
    expect(await db.select().from(watchedSigners)).toHaveLength(1);
  });

  it('does not register an address whose plan was declined', async () => {
    const res = await (await planner()).inject({
      method: 'POST',
      url: '/api/chaos/plan',
      payload: { scenario: 'C9', signer: SIGNER },
    });
    // A refusal is a stated outcome, not an error.
    expect(res.statusCode).toBe(200);
    expect(res.json().watching).toBe(false);
    expect(await db.select().from(watchedSigners)).toHaveLength(0);
  });

  it('refuses to plan a deliberate failure on a chain where gas is real money', async () => {
    const res = await (await planner()).inject({
      method: 'POST',
      url: '/api/chaos/plan',
      payload: { scenario: 'C2', signer: SIGNER, chainId: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mainnet_refused');
    expect(await db.select().from(watchedSigners)).toHaveLength(0);
  });

  it('takes reported hashes, since a queued transaction is in no block to scan', async () => {
    const hash = `0x${'d'.repeat(64)}`;
    const res = await (await planner()).inject({
      method: 'POST',
      url: '/api/chaos/observe',
      payload: { txHashes: [hash], chainId: CHAIN_IDS.sepolia },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().observed[0].txHash).toBe(hash);
  });

  it('watches whoever actually signed, not whoever reported the hash', async () => {
    await (await planner()).inject({
      method: 'POST',
      url: '/api/chaos/observe',
      payload: { txHashes: [`0x${'d'.repeat(64)}`], chainId: CHAIN_IDS.sepolia },
    });
    const rows = await db.select().from(watchedSigners);
    expect(rows.map((r) => r.signer.toLowerCase())).toEqual([OTHER]);
  });

  it('rejects an empty report rather than silently doing nothing', async () => {
    const res = await (await planner()).inject({
      method: 'POST',
      url: '/api/chaos/observe',
      payload: { txHashes: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an address that is not one', async () => {
    const res = await (await planner()).inject({
      method: 'POST',
      url: '/api/chaos/plan',
      payload: { scenario: 'C2', signer: 'vitalik.eth' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_address');
  });
});

describe('surviving an unauthenticated internet', () => {
  it('refuses a caller who exceeds the budget on a route that costs us a model call', async () => {
    const instance = await app({ diagnose: async () => ({ found: false }) });
    const hit = () =>
      instance.inject({
        method: 'POST',
        url: '/api/diagnose',
        payload: { txHash: `0x${'e'.repeat(64)}` },
      });
    // The limit is 10 a minute; the eleventh is the one that must be refused.
    for (let i = 0; i < 10; i++) expect((await hit()).statusCode).toBe(200);
    const refused = await hit();
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe('rate_limited');
  });

  it('will not let a second caller rename an address someone else registered', async () => {
    const instance = await app();
    await instance.inject({
      method: 'POST',
      url: '/api/watched',
      payload: { signer: SIGNER, label: 'the original', agentId: 'first' },
    });
    await instance.inject({
      method: 'POST',
      url: '/api/watched',
      payload: { signer: SIGNER, label: 'hijacked', agentId: 'attacker' },
    });
    const rows = await db.select().from(watchedSigners);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('the original');
    expect(rows[0]?.agentId).toBe('first');
  });

  it('bounds the strings a caller can store, since nothing else does', async () => {
    const instance = await app();
    await instance.inject({
      method: 'POST',
      url: '/api/watched',
      payload: { signer: SIGNER, label: 'x'.repeat(5_000), agentId: 'y'.repeat(5_000) },
    });
    const rows = await db.select().from(watchedSigners);
    expect(rows[0]?.label?.length).toBeLessThanOrEqual(64);
    expect(rows[0]?.agentId.length).toBeLessThanOrEqual(64);
  });
});

describe('config', () => {
  it('tells the console which controls this process can actually drive', async () => {
    const body = (await (await app({ chaos: undefined })).inject({ url: '/api/config' })).json();
    expect(body.capabilities).toEqual({
      remediate: false,
      chaos: false,
      signChaos: false,
      diagnose: false,
      signerHealth: false,
      proposeRemediation: false,
    });
    expect(body.remediation.budget.maxGasWeiPerHour).toBeTypeOf('string');
  });
});

describe('summarise', () => {
  it.each([
    ['NONCE_GAP', { missingNonces: [47], blockedActionCount: 1 }, 'Nonce 47 unfilled'],
    ['STUCK_TRANSACTION', { nonce: 5, pendingDurationMs: 252_000 }, 'pending 252s'],
    ['RETRY_STORM', { attemptCount: 4, totalGasBurned: '89000000000000' }, '0.000089 ETH'],
    ['SIGNER_GAS_STARVED', { signerBalance: '900000000000000', projectedActionsRemaining: 0 }, '0.000900 ETH'],
    ['SIM_PASS_EXEC_REVERT', { simulatedAtBlock: 10, includedAtBlock: 11 }, 'reverted at 11'],
  ])('writes a specific line for %s', (cls, facts, expected) => {
    const line = summarise({
      ...row({ class: cls, evidence: { eventIds: ['e0'], ruleId: 'R1', facts } }),
      resolvedAt: null,
      resolvedBy: null,
      rca: null,
      remediation: null,
    } as never);
    expect(line).toContain(expected);
  });
});

describe('the SSE contract', () => {
  it('carries the figures on stats.updated, not an empty nudge', () => {
    // The console's header strip is driven by this event. An empty payload
    // leaves it showing whatever it loaded at connect time, forever.
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.subscribe((e) => {
      if (e.type === 'stats.updated') received.push(e.data);
    });

    bus.publish({
      type: 'stats.updated',
      data: { openBySeverity: { critical: 1, warning: 0, info: 0 } },
    });
    expect(received[0]).toMatchObject({ openBySeverity: { critical: 1 } });
  });

  it('keeps publishing after one subscriber throws', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('socket closed mid-write');
    });
    bus.subscribe((e) => seen.push(e.type));

    expect(() => bus.publish({ type: 'incident.created', data: {} })).not.toThrow();
    expect(seen).toEqual(['incident.created']);
  });

  it('stops delivering once unsubscribed', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.subscribe((e) => seen.push(e.type));
    off();
    bus.publish({ type: 'incident.created', data: {} });
    expect(seen).toEqual([]);
    expect(bus.subscriberCount).toBe(0);
  });
});

describe('summary fact names match what the rules emit', () => {
  // A renamed fact shows up as "unknown" in the timeline, which reads like
  // missing data rather than a wrong key. These use the exact fact names from
  // packages/detector/src/rules.ts.
  const line = (cls: string, facts: Record<string, unknown>) =>
    summarise({
      ...row({ class: cls, evidence: { eventIds: ['e0'], ruleId: 'R1', facts } }),
      resolvedAt: null,
      resolvedBy: null,
      rca: null,
      remediation: null,
    } as never);

  it('R1 reads pendingDurationMs', () => {
    expect(line('STUCK_TRANSACTION', { nonce: 5, pendingDurationMs: 252_000 })).toContain('252s');
  });

  it('R6 reads projectedActionsRemaining', () => {
    const text = line('SIGNER_GAS_STARVED', {
      signerBalance: '38886020810000',
      projectedActionsRemaining: 0,
    });
    expect(text).toContain('covers 0 further');
    expect(text).not.toContain('unknown');
  });

  it('R7 reads deltaBps', () => {
    expect(line('ADVERSE_INCLUSION', { deltaBps: 410 })).toContain('410 bps');
  });

  it('R2 reads missingNonces and blockedActionCount', () => {
    expect(line('NONCE_GAP', { missingNonces: [47], blockedActionCount: 1 })).toContain(
      'Nonce 47 unfilled; 1 action',
    );
  });

  it('R5 reads attemptCount and totalGasBurned', () => {
    expect(line('RETRY_STORM', { attemptCount: 4, totalGasBurned: '89000000000000' })).toContain(
      '4 failed attempts',
    );
  });
});
