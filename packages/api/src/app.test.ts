import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { blackboxConfigSchema, CHAIN_IDS, type BlackboxConfig } from '@blackbox/core';
import {
  createDb,
  getKeeperhubConnection,
  keeperhubConnections,
  listWatchedWorkflows,
  watchedWorkflows,
  incidents,
  recordRemediationAttempt,
  remediationLedger,
  agentOwners,
  oauthAuthRequests,
  oauthClients,
  orgSessions,
  webhookSecrets,
  saveIncident,
  watchedSigners,
  type Database,
} from '@blackbox/store';
import { buildApp } from './app.js';
import { Identity } from './identity.js';
import { KeeperHubOAuth } from './oauth.js';
import { Connections } from './connections.js';
import { keyFrom } from './secrets.js';
import { Webhooks } from './webhooks.js';
import { WalletAuth } from './wallet-auth.js';
import { privateKeyToAccount } from 'viem/accounts';
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
  await db.delete(agentOwners);
  await db.delete(orgSessions);
  await db.delete(oauthAuthRequests);
  await db.delete(oauthClients);
  await db.delete(webhookSecrets);
  await db.delete(watchedWorkflows);
  await db.delete(keeperhubConnections);
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

  // So the console can say why a rule an operator expected is not listed for
  // their agent, instead of silently never firing it.
  it('publishes which rules can fire for each kind of agent', async () => {
    const body = (await (await app({})).inject({ url: '/api/config' })).json();
    expect(body.rules.signer).toContain('R2');
    // A managed wallet has no nonce queue of its own and pays no gas of its
    // own, so neither NONCE_GAP nor SIGNER_GAS_STARVED can happen to one.
    expect(body.rules.keeperhub).not.toContain('R2');
    expect(body.rules.keeperhub).not.toContain('R6');
    expect(body.rules.keeperhub).toContain('R4');
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

describe('ownership', () => {
  const verifier = (keys: string[]) => ({ listKeys: async () => keys.map((id) => ({ id })) });
  // Two organisations. Note the shared "k9": one org's key list is its own.
  const identityFor = (keys: string[]) => new Identity(db, verifier(keys));

  const signedIn = async (keys: string[]): Promise<{ identity: Identity; token: string }> => {
    const identity = identityFor(keys);
    const result = await identity.signIn('kh_test_key');
    if (!result.ok) throw new Error('sign-in failed in fixture');
    return { identity, token: result.token };
  };

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it('turns an organisation key into a session, and never stores the key', async () => {
    const identity = identityFor(['k2', 'k1']);
    const instance = await app({ identity });
    const res = await instance.inject({
      method: 'POST',
      url: '/api/auth/keeperhub',
      payload: { orgKey: 'kh_secret_value' },
    });
    expect(res.statusCode).toBe(201);
    // The identity is the lowest key id, so a second key of the same org lands
    // in the same tenant rather than a new one.
    expect(res.json().orgId).toBe('k1');

    const stored = await db.select().from(orgSessions);
    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain('kh_secret_value');
    expect(serialised).not.toContain(res.json().token);
  });

  it('refuses a webhook key, which reads fine and executes nothing', async () => {
    const res = await (await app({ identity: identityFor(['k1']) })).inject({
      method: 'POST',
      url: '/api/auth/keeperhub',
      payload: { orgKey: 'wfb_webhook' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a key KeeperHub does not accept', async () => {
    const identity = new Identity(db, {
      listKeys: async () => Promise.reject(new Error('401')),
    });
    const res = await (await app({ identity })).inject({
      method: 'POST',
      url: '/api/auth/keeperhub',
      payload: { orgKey: 'kh_wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  /** The point of all of it: another operator cannot spend gas on your agent. */
  it('lets only the owner remediate a claimed agent', async () => {
    const mine = await signedIn(['org-a']);
    const theirs = await signedIn(['org-b']);
    const instance = await app({
      identity: mine.identity,
      remediate: async () => ({ accepted: true, guards: [] }),
    });

    const registered = await instance.inject({
      method: 'POST',
      url: '/api/watched',
      headers: bearer(mine.token),
      payload: { signer: SIGNER, chainId: CHAIN_IDS.sepolia, agentId: 'mine' },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().owned).toBe(true);
    await saveIncident(db, row({ agentId: 'mine' }) as never);

    const byOwner = await instance.inject({
      method: 'POST',
      url: '/api/incidents/inc-1/remediate',
      headers: bearer(mine.token),
    });
    expect(byOwner.statusCode).toBe(202);

    const byStranger = await instance.inject({
      method: 'POST',
      url: '/api/incidents/inc-1/remediate',
      headers: bearer(theirs.token),
    });
    expect(byStranger.statusCode).toBe(403);

    const byAnonymous = await instance.inject({
      method: 'POST',
      url: '/api/incidents/inc-1/remediate',
    });
    expect(byAnonymous.statusCode).toBe(403);
  });

  // An unclaimed agent stays open, which is what keeps the public demo working.
  it('leaves an unclaimed agent actionable by anyone', async () => {
    await saveIncident(db, row({ agentId: 'demo' }) as never);
    const res = await (
      await app({ identity: identityFor(['k1']), remediate: async () => ({ accepted: true, guards: [] }) })
    ).inject({ method: 'POST', url: '/api/incidents/inc-1/remediate' });
    expect(res.statusCode).toBe(202);
  });

  it('refuses to register an address under an agent id another organisation owns', async () => {
    const mine = await signedIn(['org-a']);
    const theirs = await signedIn(['org-b']);
    const instance = await app({ identity: mine.identity });
    await instance.inject({
      method: 'POST',
      url: '/api/watched',
      headers: bearer(mine.token),
      payload: { signer: SIGNER, chainId: CHAIN_IDS.sepolia, agentId: 'mine' },
    });

    const res = await instance.inject({
      method: 'POST',
      url: '/api/watched',
      headers: bearer(theirs.token),
      payload: {
        signer: '0x1111111111111111111111111111111111111111',
        chainId: CHAIN_IDS.sepolia,
        agentId: 'mine',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toContain('another organisation');
  });

  it('shows a visitor the public agents and a signed-in operator their own too', async () => {
    const mine = await signedIn(['org-a']);
    const instance = await app({ identity: mine.identity, publicAgentIds: ['demo'] });
    await instance.inject({
      method: 'POST',
      url: '/api/watched',
      headers: bearer(mine.token),
      payload: { signer: SIGNER, chainId: CHAIN_IDS.sepolia, agentId: 'mine' },
    });
    await saveIncident(db, row({ id: 'inc-demo', agentId: 'demo' }) as never);
    await saveIncident(db, row({ id: 'inc-mine', agentId: 'mine', key: 'k2' }) as never);

    const anon = await instance.inject({ method: 'GET', url: '/api/incidents' });
    expect(anon.json().items.map((i: { id: string }) => i.id)).toEqual(['inc-demo']);

    const owner = await instance.inject({
      method: 'GET',
      url: '/api/incidents',
      headers: bearer(mine.token),
    });
    expect(owner.json().items.map((i: { id: string }) => i.id).sort()).toEqual([
      'inc-demo',
      'inc-mine',
    ]);
  });

  it('stops honouring a revoked session', async () => {
    const mine = await signedIn(['org-a']);
    const instance = await app({ identity: mine.identity });
    expect(
      (await instance.inject({ method: 'GET', url: '/api/auth/session', headers: bearer(mine.token) }))
        .statusCode,
    ).toBe(200);
    await instance.inject({ method: 'POST', url: '/api/auth/signout', headers: bearer(mine.token) });
    expect(
      (await instance.inject({ method: 'GET', url: '/api/auth/session', headers: bearer(mine.token) }))
        .statusCode,
    ).toBe(401);
  });
});

describe('connect with KeeperHub, over HTTP', () => {
  const metadata = {
    issuer: 'https://provider.test',
    authorization_endpoint: 'https://provider.test/oauth/authorize',
    token_endpoint: 'https://provider.test/api/oauth/token',
    registration_endpoint: 'https://provider.test/api/oauth/register',
  };
  const jwt = (claims: Record<string, unknown>) =>
    ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');

  const impl = (async (url: string) => {
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return new Response(JSON.stringify(metadata), { status: 200 });
    }
    if (url === metadata.registration_endpoint) {
      return new Response(JSON.stringify({ client_id: 'client-1' }), { status: 201 });
    }
    if (url === metadata.token_endpoint) {
      return new Response(JSON.stringify({ access_token: jwt({ sub: 'u1', org: 'org-9' }) }), {
        status: 200,
      });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  const instance = async () =>
    app({
      identity: new Identity(db, { listKeys: async () => [{ id: 'k1' }] }),
      oauth: new KeeperHubOAuth({
        db,
        baseUrl: 'https://blackbox.test',
        issuer: 'https://provider.test',
        fetchImpl: impl,
      }),
    });

  it('hands back a URL to send the operator to', async () => {
    const res = await (await instance()).inject({ url: '/api/auth/keeperhub/start' });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain('provider.test/oauth/authorize');
  });

  /** An open redirect here would hand a live session token to another site. */
  it('refuses a returnTo that leaves this deployment', async () => {
    const res = await (await instance()).inject({
      url: '/api/auth/keeperhub/start?returnTo=https://evil.test/steal',
    });
    expect(res.statusCode).toBe(400);
  });

  it('completes a sign-in and puts the token in the fragment, not the query', async () => {
    const server = await instance();
    const started = await server.inject({ url: '/api/auth/keeperhub/start?returnTo=/incidents' });
    // `URL` is shadowed by the connection string at the top of this file.
    const state = new globalThis.URL(started.json().url).searchParams.get('state');

    const res = await server.inject({
      url: `/api/auth/keeperhub/callback?code=abc&state=${state}`,
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers['location'] as string;
    // A query parameter would put a live credential in every access log between
    // here and the browser; a fragment is never sent to a server.
    expect(location.startsWith('/incidents#token=bb_')).toBe(true);
    expect(location.split('#')[0]).not.toContain('token');

    // And the session it minted actually works.
    const token = new URLSearchParams(location.split('#')[1]).get('token');
    const session = await server.inject({
      url: '/api/auth/session',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.json().orgId).toBe('org-9');
  });

  it('rejects a callback with no code', async () => {
    const res = await (await instance()).inject({ url: '/api/auth/keeperhub/callback?state=x' });
    expect(res.statusCode).toBe(400);
  });

  it('reports the provider declining rather than signing anyone in', async () => {
    const res = await (await instance()).inject({
      url: '/api/auth/keeperhub/callback?code=abc&state=never-issued',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toContain('expired or was already used');
  });

  /**
   * Connecting asks for more than signing in: it asks Blackbox to keep a
   * credential. A deployment that cannot keep one must say so, because signing
   * the operator in instead would promise a watch that never happens.
   */
  it('refuses to connect when this deployment cannot store a credential', async () => {
    const res = await (await instance()).inject({
      url: '/api/auth/keeperhub/start?connect=1',
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().detail).toContain('BLACKBOX_ENCRYPTION_KEY');
  });

  it('still signs people in without one', async () => {
    const res = await (await instance()).inject({ url: '/api/auth/keeperhub/start' });
    expect(res.statusCode).toBe(200);
  });
});

describe('connecting an account, over HTTP', () => {
  const metadata = {
    issuer: 'https://provider.test',
    authorization_endpoint: 'https://provider.test/oauth/authorize',
    token_endpoint: 'https://provider.test/api/oauth/token',
    registration_endpoint: 'https://provider.test/api/oauth/register',
  };
  const jwt = (claims: Record<string, unknown>) =>
    ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');

  const impl = ((withRefreshToken: boolean) =>
    (async (url: string) => {
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify(metadata), { status: 200 });
      }
      if (url === metadata.registration_endpoint) {
        return new Response(JSON.stringify({ client_id: 'client-1' }), { status: 201 });
      }
      if (url === metadata.token_endpoint) {
        return new Response(
          JSON.stringify({
            access_token: jwt({ sub: 'u1', org: 'org-9' }),
            ...(withRefreshToken ? { refresh_token: 'refresh-1' } : {}),
            scope: 'mcp:read',
          }),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch) as (withRefreshToken: boolean) => typeof fetch;

  const instance = async (withRefreshToken = true) => {
    const fetchImpl = impl(withRefreshToken);
    const oauth = new KeeperHubOAuth({
      db,
      baseUrl: 'https://blackbox.test',
      issuer: 'https://provider.test',
      fetchImpl,
    });
    return app({
      identity: new Identity(db, { listKeys: async () => [{ id: 'k1' }] }),
      oauth,
      connections: new Connections({ db, oauth, key: keyFrom('e'.repeat(64)) }),
    });
  };

  const connect = async (server: Awaited<ReturnType<typeof instance>>, query: string) => {
    const started = await server.inject({ url: `/api/auth/keeperhub/start?${query}` });
    const state = new globalThis.URL(started.json().url).searchParams.get('state');
    const callback = await server.inject({
      url: `/api/auth/keeperhub/callback?code=abc&state=${state}`,
    });
    return { started, callback };
  };

  it('states the lifetime and the scope before the operator leaves', async () => {
    const server = await instance();
    const started = await server.inject({ url: '/api/auth/keeperhub/start?connect=1&days=45' });
    expect(started.json().connect).toMatchObject({ days: 45, min: 7, max: 60, scope: 'mcp:read' });
  });

  it('clamps a lifetime outside the range rather than refusing', async () => {
    const server = await instance();
    const started = await server.inject({ url: '/api/auth/keeperhub/start?connect=1&days=900' });
    expect(started.json().connect.days).toBe(60);
  });

  it('stores the connection, active, with the chosen lifetime', async () => {
    const server = await instance();
    const { callback } = await connect(server, 'connect=1&days=7');
    expect(callback.statusCode).toBe(201);

    const row = await getKeeperhubConnection(db, 'org-9');
    expect(row?.status).toBe('active');
    expect(row?.scope).toBe('mcp:read');
    expect(row?.refreshTokenEnc).not.toContain('refresh-1');
    const life = (row!.expiresAt.getTime() - row!.connectedAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(life)).toBe(7);
  });

  it('watches nothing until the operator picks', async () => {
    const server = await instance();
    await connect(server, 'connect=1');
    expect(await listWatchedWorkflows(db, 'org-9')).toEqual([]);
  });

  /** Signing in keeps nothing, even though the same flow could have. */
  it('keeps no credential for a plain sign-in', async () => {
    const server = await instance();
    await connect(server, 'returnTo=/incidents');
    expect(await getKeeperhubConnection(db, 'org-9')).toBeNull();
  });

  it('refuses to pretend when the provider returns no refresh token', async () => {
    const server = await instance(false);
    const { callback } = await connect(server, 'connect=1');
    expect(callback.statusCode).toBe(502);
    expect(await getKeeperhubConnection(db, 'org-9')).toBeNull();
  });

  /** The intent lives on this server, so a doctored callback cannot add it. */
  it('cannot be turned into a connection by editing the link', async () => {
    const server = await instance();
    const started = await server.inject({ url: '/api/auth/keeperhub/start' });
    const state = new globalThis.URL(started.json().url).searchParams.get('state');
    await server.inject({
      url: `/api/auth/keeperhub/callback?code=abc&state=${state}&connect=1&days=60`,
    });
    expect(await getKeeperhubConnection(db, 'org-9')).toBeNull();
  });
});

describe('managing a connection, over HTTP', () => {
  const metadata = {
    issuer: 'https://provider.test',
    authorization_endpoint: 'https://provider.test/oauth/authorize',
    token_endpoint: 'https://provider.test/api/oauth/token',
    registration_endpoint: 'https://provider.test/api/oauth/register',
  };
  const jwt = (claims: Record<string, unknown>) =>
    ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');

  /** Their side: the token endpoint, plus the workflow list a picker needs. */
  const provider = (over: { workflowsStatus?: number } = {}) => {
    const impl = (async (url: string) => {
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify(metadata), { status: 200 });
      }
      if (url === metadata.registration_endpoint) {
        return new Response(JSON.stringify({ client_id: 'client-1' }), { status: 201 });
      }
      if (url === metadata.token_endpoint) {
        return new Response(
          JSON.stringify({
            access_token: jwt({ sub: 'u1', org: 'org-9', exp: Math.floor(Date.now() / 1000) + 900 }),
            refresh_token: 'refresh-next',
            scope: 'mcp:read',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/workflows')) {
        if (over.workflowsStatus) return new Response('nope', { status: over.workflowsStatus });
        return new Response(
          JSON.stringify([
            { id: 'wf-1', name: 'Rebalance', enabled: true },
            { id: 'wf-2', name: 'Harvest', enabled: false },
          ]),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    return impl;
  };

  const instance = async (over: { workflowsStatus?: number } = {}) => {
    const fetchImpl = provider(over);
    const oauth = new KeeperHubOAuth({
      db,
      baseUrl: 'https://blackbox.test',
      issuer: 'https://provider.test',
      fetchImpl,
    });
    return app({
      identity: new Identity(db, { listKeys: async () => [{ id: 'k1' }] }),
      oauth,
      connections: new Connections({ db, oauth, key: keyFrom('f'.repeat(64)) }),
      keeperHubApiUrl: 'https://provider.test/api',
      keeperHubFetch: fetchImpl,
    });
  };

  /** Connect through the real flow, so the session and the credential agree. */
  const connected = async (server: FastifyInstance, query = 'connect=1') => {
    const started = await server.inject({ url: `/api/auth/keeperhub/start?${query}` });
    const state = new globalThis.URL(started.json().url).searchParams.get('state');
    const callback = await server.inject({
      url: `/api/auth/keeperhub/callback?code=abc&state=${state}`,
    });
    return { authorization: `Bearer ${callback.json().token}` };
  };

  it('says nothing is connected before anyone connects', async () => {
    const server = await instance();
    const started = await server.inject({ url: '/api/auth/keeperhub/start' });
    const state = new globalThis.URL(started.json().url).searchParams.get('state');
    const cb = await server.inject({ url: `/api/auth/keeperhub/callback?code=abc&state=${state}` });
    const headers = { authorization: `Bearer ${cb.json().token}` };

    const res = await server.inject({ url: '/api/connections/keeperhub', headers });
    expect(res.json()).toMatchObject({ connected: false, watching: [] });
  });

  it('needs a session, since a connection belongs to an organisation', async () => {
    const server = await instance();
    expect((await server.inject({ url: '/api/connections/keeperhub' })).statusCode).toBe(401);
    expect(
      (await server.inject({ url: '/api/connections/keeperhub/workflows' })).statusCode,
    ).toBe(401);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/connections/keeperhub/workflows',
          payload: { workflows: ['wf-1'] },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('reports the connection, its lifetime, and what disconnecting can do', async () => {
    const server = await instance();
    const headers = await connected(server, 'connect=1&days=7');

    const res = await server.inject({ url: '/api/connections/keeperhub', headers });
    expect(res.json()).toMatchObject({
      connected: true,
      status: 'active',
      scope: 'mcp:read',
      revocation: 'local_only',
      watching: [],
    });
    expect(typeof res.json().expiresAt).toBe('string');
  });

  it('lists their workflows, marking the ones already watched', async () => {
    const server = await instance();
    const headers = await connected(server);

    await server.inject({
      method: 'POST',
      url: '/api/connections/keeperhub/workflows',
      headers,
      payload: { workflows: [{ id: 'wf-1', name: 'Rebalance' }] },
    });

    const res = await server.inject({ url: '/api/connections/keeperhub/workflows', headers });
    expect(res.json().workflows).toEqual([
      { id: 'wf-1', name: 'Rebalance', enabled: true, watched: true },
      { id: 'wf-2', name: 'Harvest', enabled: false, watched: false },
    ]);
  });

  it('reports their side being unavailable rather than an empty list', async () => {
    const server = await instance({ workflowsStatus: 500 });
    const headers = await connected(server);
    const res = await server.inject({ url: '/api/connections/keeperhub/workflows', headers });
    expect(res.statusCode).toBe(502);
  });

  it('will not choose workflows for an organisation that never connected', async () => {
    const server = await instance();
    const started = await server.inject({ url: '/api/auth/keeperhub/start' });
    const state = new globalThis.URL(started.json().url).searchParams.get('state');
    const cb = await server.inject({ url: `/api/auth/keeperhub/callback?code=abc&state=${state}` });

    const res = await server.inject({
      method: 'POST',
      url: '/api/connections/keeperhub/workflows',
      headers: { authorization: `Bearer ${cb.json().token}` },
      payload: { workflows: ['wf-1'] },
    });
    expect(res.statusCode).toBe(409);
  });

  it('takes plain ids as well as objects', async () => {
    const server = await instance();
    const headers = await connected(server);
    const res = await server.inject({
      method: 'POST',
      url: '/api/connections/keeperhub/workflows',
      headers,
      payload: { workflows: ['wf-1', { id: 'wf-2', name: 'Harvest' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().watching.map((w: { workflowId: string }) => w.workflowId)).toEqual([
      'wf-1',
      'wf-2',
    ]);
  });

  it('refuses an empty pick rather than silently watching nothing', async () => {
    const server = await instance();
    const headers = await connected(server);
    const res = await server.inject({
      method: 'POST',
      url: '/api/connections/keeperhub/workflows',
      headers,
      payload: { workflows: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('stops watching one, and says so when there was nothing to stop', async () => {
    const server = await instance();
    const headers = await connected(server);
    await server.inject({
      method: 'POST',
      url: '/api/connections/keeperhub/workflows',
      headers,
      payload: { workflows: ['wf-1'] },
    });

    const stopped = await server.inject({
      method: 'DELETE',
      url: '/api/connections/keeperhub/workflows/wf-1',
      headers,
    });
    expect(stopped.statusCode).toBe(200);
    expect((await server.inject({ url: '/api/connections/keeperhub', headers })).json().watching)
      .toEqual([]);

    const missing = await server.inject({
      method: 'DELETE',
      url: '/api/connections/keeperhub/workflows/wf-never',
      headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('disconnects, and does not claim to have revoked anything', async () => {
    const server = await instance();
    const headers = await connected(server);

    const res = await server.inject({ method: 'DELETE', url: '/api/connections/keeperhub', headers });
    expect(res.json().note).toContain('no way for us to revoke it there');
    expect((await server.inject({ url: '/api/connections/keeperhub', headers })).json()).toMatchObject(
      { connected: false },
    );
    expect(await getKeeperhubConnection(db, 'org-9')).toMatchObject({ refreshTokenEnc: '' });
  });

  /** One operator managing another's connection is the failure that matters. */
  it('manages the caller\'s own organisation and no other', async () => {
    const server = await instance();
    const headers = await connected(server);
    await server.inject({
      method: 'POST',
      url: '/api/connections/keeperhub/workflows',
      headers,
      payload: { workflows: ['wf-1'] },
    });

    // A second tenant: the same deployment, a different organisation. Its org
    // id comes from the key it signed in with, not from anything it can name.
    const signIn = await server.inject({
      method: 'POST',
      url: '/api/auth/keeperhub',
      payload: { orgKey: 'kh_someone_else' },
    });
    const other = { authorization: `Bearer ${signIn.json().token}` };
    const res = await server.inject({ url: '/api/connections/keeperhub', headers: other });
    expect(res.json()).toMatchObject({ connected: false, watching: [] });

    const steal = await server.inject({
      method: 'DELETE',
      url: '/api/connections/keeperhub/workflows/wf-1',
      headers: other,
    });
    expect(steal.statusCode).toBe(404);
    expect(await listWatchedWorkflows(db, 'org-9', { activeOnly: true })).toHaveLength(1);
  });
});

describe('scoping every read, not just the list', () => {
  const signedIn = async (orgKeyId: string) => {
    const identity = new Identity(db, { listKeys: async () => [{ id: orgKeyId }] });
    const result = await identity.signIn('kh_x');
    if (!result.ok) throw new Error('fixture sign-in failed');
    return { identity, token: result.token };
  };

  const setup = async () => {
    const mine = await signedIn('org-a');
    const server = await app({
      identity: mine.identity,
      publicAgentIds: ['demo'],
      remediate: async () => ({ accepted: true, guards: [] }),
      proposals: {
        plan: async () => ({ plan: 'fill-nonce' }),
        record: async () => ({ recorded: true }),
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/watched',
      headers: { authorization: `Bearer ${mine.token}` },
      payload: { signer: SIGNER, chainId: CHAIN_IDS.sepolia, agentId: 'mine' },
    });
    await saveIncident(db, row({ id: 'inc-mine', agentId: 'mine' }) as never);
    await saveIncident(db, row({ id: 'inc-demo', agentId: 'demo', key: 'k-demo' }) as never);
    return { server, token: mine.token };
  };

  /**
   * 404 rather than 403 on a read: a 403 confirms the id exists and belongs to
   * somebody, which is more than a stranger should learn by guessing.
   */
  it('hides another tenant’s incident behind a 404', async () => {
    const { server, token } = await setup();
    expect((await server.inject({ url: '/api/incidents/inc-mine' })).statusCode).toBe(404);
    expect(
      (
        await server.inject({
          url: '/api/incidents/inc-mine',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    // The public agent stays public.
    expect((await server.inject({ url: '/api/incidents/inc-demo' })).statusCode).toBe(200);
  });

  it('counts only what the caller may see in stats and agents', async () => {
    const { server, token } = await setup();
    const anon = await server.inject({ url: '/api/agents' });
    expect(anon.json().items.map((a: { agentId: string }) => a.agentId)).toEqual(['demo']);

    const owner = await server.inject({
      url: '/api/agents',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(owner.json().items.map((a: { agentId: string }) => a.agentId).sort()).toEqual([
      'demo',
      'mine',
    ]);

    const anonStats = await server.inject({ url: '/api/stats' });
    const ownerStats = await server.inject({
      url: '/api/stats',
      headers: { authorization: `Bearer ${token}` },
    });
    // Two open incidents visible to the owner, one to a visitor.
    const openCount = (body: { openBySeverity: Record<string, number> }): number =>
      Object.values(body.openBySeverity).reduce((a, b) => a + b, 0);
    expect(openCount(ownerStats.json())).toBeGreaterThan(openCount(anonStats.json()));
  });

  it('refuses to acknowledge or remediate another tenant’s incident', async () => {
    const { server, token } = await setup();
    // Not readable at all when anonymous, so it is not even findable.
    expect(
      (await server.inject({ method: 'POST', url: '/api/incidents/inc-mine/acknowledge' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await server.inject({ method: 'POST', url: '/api/incidents/inc-mine/remediate' })).statusCode,
    ).toBe(404);
    // The owner can do both.
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/incidents/inc-mine/acknowledge',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('scopes the remediation plan and the transaction a wallet signed', async () => {
    const { server, token } = await setup();
    expect(
      (await server.inject({ url: '/api/incidents/inc-mine/remediation-plan' })).statusCode,
    ).toBe(404);
    expect(
      (
        await server.inject({
          url: '/api/incidents/inc-mine/remediation-plan',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('inbound webhooks', () => {
  const sweeper = (result: { runsIngested: number; eventsInserted: number } | null) => {
    let calls = 0;
    return {
      count: () => calls,
      sweepKeeperHub: async () => {
        calls += 1;
        return result;
      },
    };
  };

  const signedIn = async () => {
    const identity = new Identity(db, { listKeys: async () => [{ id: 'org-a' }] });
    const result = await identity.signIn('kh_x');
    if (!result.ok) throw new Error('fixture sign-in failed');
    return { identity, token: result.token };
  };

  it('mints a secret for a signed-in operator and refuses a stranger', async () => {
    const mine = await signedIn();
    const swept = sweeper({ runsIngested: 0, eventsInserted: 0 });
    const server = await app({
      identity: mine.identity,
      webhooks: new Webhooks(db, swept),
    });

    expect(
      (await server.inject({ method: 'POST', url: '/api/webhooks/keeperhub/secret' })).statusCode,
    ).toBe(401);

    const res = await server.inject({
      method: 'POST',
      url: '/api/webhooks/keeperhub/secret',
      headers: { authorization: `Bearer ${mine.token}` },
      payload: { label: 'rebalance workflow' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    // No public URL configured, so no snippet is invented for one.
    expect(res.json().codeNode).toBeNull();

    // Stored as a hash: the secret itself is not recoverable from the table.
    const rows = await db.select().from(webhookSecrets);
    expect(JSON.stringify(rows)).not.toContain(res.json().secret);
  });

  it('sweeps when nudged with a valid secret, and refuses without one', async () => {
    const mine = await signedIn();
    const swept = sweeper({ runsIngested: 2, eventsInserted: 3 });
    const server = await app({ identity: mine.identity, webhooks: new Webhooks(db, swept) });
    const secret = (
      await server.inject({
        method: 'POST',
        url: '/api/webhooks/keeperhub/secret',
        headers: { authorization: `Bearer ${mine.token}` },
      })
    ).json().secret;

    expect((await server.inject({ method: 'POST', url: '/api/webhooks/keeperhub' })).statusCode).toBe(
      401,
    );
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/webhooks/keeperhub',
          headers: { authorization: 'Bearer whsec_wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(swept.count()).toBe(0);

    const ok = await server.inject({
      method: 'POST',
      url: '/api/webhooks/keeperhub',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(ok.json()).toMatchObject({ accepted: true, swept: true, runsIngested: 2 });
    expect(swept.count()).toBe(1);
  });

  /**
   * The security property worth having: a caller cannot submit data, only ask
   * us to read. A body claiming a fabricated run changes nothing.
   */
  it('ignores the body entirely, so a nudge cannot fabricate an incident', async () => {
    const mine = await signedIn();
    const swept = sweeper({ runsIngested: 0, eventsInserted: 0 });
    const server = await app({ identity: mine.identity, webhooks: new Webhooks(db, swept) });
    const secret = (
      await server.inject({
        method: 'POST',
        url: '/api/webhooks/keeperhub/secret',
        headers: { authorization: `Bearer ${mine.token}` },
      })
    ).json().secret;

    await server.inject({
      method: 'POST',
      url: '/api/webhooks/keeperhub',
      headers: { authorization: `Bearer ${secret}` },
      payload: { runs: [{ id: 'invented', status: 'error', agentId: 'someone-else' }] },
    });
    expect(await db.select().from(incidents)).toHaveLength(0);
  });

  // Arriving twice must not create a second incident. It causes a second sweep
  // of the same data, and events dedupe on (sourceId, attemptIndex).
  it('is idempotent: a repeated nudge just sweeps again', async () => {
    const mine = await signedIn();
    const swept = sweeper({ runsIngested: 1, eventsInserted: 0 });
    const server = await app({ identity: mine.identity, webhooks: new Webhooks(db, swept) });
    const secret = (
      await server.inject({
        method: 'POST',
        url: '/api/webhooks/keeperhub/secret',
        headers: { authorization: `Bearer ${mine.token}` },
      })
    ).json().secret;

    for (let i = 0; i < 3; i++) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/webhooks/keeperhub',
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(res.json().accepted).toBe(true);
    }
    expect(swept.count()).toBe(3);
    expect(await db.select().from(incidents)).toHaveLength(0);
  });

  it('says so rather than claiming a sweep when it watches no organisation', async () => {
    const mine = await signedIn();
    const server = await app({ identity: mine.identity, webhooks: new Webhooks(db, sweeper(null)) });
    const secret = (
      await server.inject({
        method: 'POST',
        url: '/api/webhooks/keeperhub/secret',
        headers: { authorization: `Bearer ${mine.token}` },
      })
    ).json().secret;

    const res = await server.inject({
      method: 'POST',
      url: '/api/webhooks/keeperhub',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().swept).toBe(false);
  });

  it('stops honouring a revoked secret', async () => {
    const mine = await signedIn();
    const webhooks = new Webhooks(db, sweeper({ runsIngested: 0, eventsInserted: 0 }));
    const server = await app({ identity: mine.identity, webhooks });
    const secret = (
      await server.inject({
        method: 'POST',
        url: '/api/webhooks/keeperhub/secret',
        headers: { authorization: `Bearer ${mine.token}` },
      })
    ).json().secret;

    await webhooks.revoke(secret);
    const res = await server.inject({
      method: 'POST',
      url: '/api/webhooks/keeperhub',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('signing in with a wallet', () => {
  const account = privateKeyToAccount(`0x${'33'.repeat(32)}`);

  const instance = async () =>
    app({
      identity: new Identity(db, { listKeys: async () => [{ id: 'org-a' }] }),
      walletAuth: new WalletAuth({ domain: 'blackbox.test' }),
      remediate: async () => ({ accepted: true, guards: [] }),
    });

  const signIn = async (server: FastifyInstance) => {
    const challenge = await server.inject({
      method: 'POST',
      url: '/api/auth/wallet/challenge',
      payload: { address: account.address },
    });
    const signature = await account.signMessage({ message: challenge.json().message });
    return server.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      payload: { nonce: challenge.json().nonce, signature },
    });
  };

  it('issues a challenge and turns a signature into a session', async () => {
    const server = await instance();
    const res = await signIn(server);
    expect(res.statusCode).toBe(201);
    expect(res.json().address).toBe(account.address.toLowerCase());
    // The tenant is the address: an agent holding its own key belongs to no
    // KeeperHub organisation.
    expect(res.json().orgId).toBe(`wallet:${account.address.toLowerCase()}`);

    const session = await server.inject({
      url: '/api/auth/session',
      headers: { authorization: `Bearer ${res.json().token}` },
    });
    expect(session.statusCode).toBe(200);
  });

  it('refuses an address that is not an address', async () => {
    const server = await instance();
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/wallet/challenge',
      payload: { address: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a signature that answers no challenge it issued', async () => {
    const server = await instance();
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      payload: { nonce: 'invented', signature: `0x${'ab'.repeat(65)}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toContain('unknown or was already used');
  });

  /**
   * The point of the whole thing: after proving the key, that wallet — and
   * nobody else — can act on the agents it signs for.
   */
  it('claims the agents that address already signs for', async () => {
    const server = await instance();
    // Registered anonymously first, exactly as a wallet-signed chaos run does.
    await server.inject({
      method: 'POST',
      url: '/api/watched',
      payload: {
        signer: account.address,
        chainId: CHAIN_IDS.sepolia,
        agentId: 'self-signed-demo',
      },
    });

    const res = await signIn(server);
    expect(res.json().agents).toContain('self-signed-demo');

    await saveIncident(db, row({ agentId: 'self-signed-demo' }) as never);
    // The owner may act.
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/incidents/inc-1/remediate',
          headers: { authorization: `Bearer ${res.json().token}` },
        })
      ).statusCode,
    ).toBe(202);
    // Anyone else may not, now that it is claimed.
    expect(
      (await server.inject({ method: 'POST', url: '/api/incidents/inc-1/remediate' })).statusCode,
    ).toBe(403);
  });
});

describe('audit finding 2 — claiming an address someone already watches', () => {
  const signedIn = async (orgKeyId: string) => {
    const identity = new Identity(db, { listKeys: async () => [{ id: orgKeyId }] });
    const result = await identity.signIn('kh_x');
    if (!result.ok) throw new Error('fixture sign-in failed');
    return { identity, token: result.token };
  };

  /**
   * The hole the audit found: an anonymous visitor watches an address first,
   * and its owner can then never take ownership of their own agent.
   */
  it('claims the agent even when the row already exists', async () => {
    const mine = await signedIn('org-a');
    const server = await app({ identity: mine.identity });

    // Anonymous first, exactly as a wallet-signed chaos run registers.
    await server.inject({
      method: 'POST',
      url: '/api/watched',
      payload: { signer: SIGNER, chainId: CHAIN_IDS.sepolia, agentId: 'already-there' },
    });

    const second = await server.inject({
      method: 'POST',
      url: '/api/watched',
      headers: { authorization: `Bearer ${mine.token}` },
      payload: { signer: SIGNER, chainId: CHAIN_IDS.sepolia, agentId: 'already-there' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().owned).toBe(true);

    // And the claim is real: a stranger is now refused.
    const theirs = await signedIn('org-b');
    const stranger = await server.inject({
      method: 'POST',
      url: '/api/watched',
      headers: { authorization: `Bearer ${theirs.token}` },
      payload: {
        signer: '0x2222222222222222222222222222222222222222',
        chainId: CHAIN_IDS.sepolia,
        agentId: 'already-there',
      },
    });
    expect(stranger.statusCode).toBe(403);
  });

  it('still refuses to rewrite the existing row', async () => {
    const mine = await signedIn('org-a');
    const server = await app({ identity: mine.identity });
    await server.inject({
      method: 'POST',
      url: '/api/watched',
      payload: { signer: SIGNER, chainId: CHAIN_IDS.sepolia, agentId: 'first', label: 'original' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/watched',
      headers: { authorization: `Bearer ${mine.token}` },
      payload: { signer: SIGNER, chainId: CHAIN_IDS.sepolia, agentId: 'first', label: 'rewritten' },
    });
    const rows = await db.select().from(watchedSigners);
    expect(rows[0]?.label).toBe('original');
  });
});

describe('audit findings 1 and 7', () => {
  const chaosPlan = {
    plan: async () => ({ scenario: 'C2', steps: [] }),
    observe: async () => ({ observed: [] }),
  };

  /** A deployment that can plan chaos must be able to list it. */
  it('serves the catalogue when only wallet-signed chaos is on', async () => {
    const res = await (await app({ chaosPlan })).inject({ url: '/api/chaos/scenarios' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([
      'C1',
      'C2',
      'C3',
      'C4',
      'C5',
      'C6',
    ]);
    // And it says which of them a wallet can actually sign.
    expect(res.json().items.filter((i: { signable: boolean }) => i.signable)).toHaveLength(4);
  });

  it('has no catalogue at all when neither is configured', async () => {
    expect((await (await app({})).inject({ url: '/api/chaos/scenarios' })).statusCode).toBe(404);
  });
});
