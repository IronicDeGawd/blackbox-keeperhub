import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { CHAINS, getChain, type BlackboxConfig } from '@blackbox/core';
import { rulesFor } from '@blackbox/detector';
import {
  activeSigners,
  eventsByIds,
  getIncident,
  ledgerForIncident,
  listAgents,
  listIncidents,
  saveIncident,
  stats,
  unwatchSigner,
  watchSigner,
  type Database,
} from '@blackbox/store';
import { EventBus } from './bus.js';
import { incidentDetail, incidentSummary, type IncidentRow } from './serialise.js';

/**
 * The console's API.
 *
 * Serves exactly the shapes in `docs/console-spec.md`, which the mock in
 * `tools/mock-api.mjs` already froze — a UI written against the mock has to
 * keep working when this replaces it, so the contract is not ours to drift.
 *
 * Two design points worth stating, because they are easy to get backwards:
 *
 * - A guard refusal is a 200, not an error. Blackbox declining to act with a
 *   stated reason is correct behaviour and part of the audit trail; shaping it
 *   like a failure would push the console into rendering it as a red toast
 *   instead of as the outcome it is.
 * - Anything that spends gas is opt-in at the server, not just guarded per
 *   request. `chaos` and `remediate` do not exist as routes unless the process
 *   was configured with the machinery to perform them.
 */

export type RemediateHandler = (incidentId: string) => Promise<{
  accepted: boolean;
  playbookId?: string;
  attemptId?: string;
  finalStatus?: string;
  guardsFailed?: { guard: string; reason: string }[];
}>;

export type ChaosScenario = {
  id: string;
  name: string;
  induces: string[];
  enabled: boolean;
  deterministic: boolean;
  note: string;
};

export type ChaosHandler = {
  scenarios(): ChaosScenario[];
  context(): Promise<{
    chainId: number;
    chainName: string;
    isTestnet: boolean;
    signer: string;
    signerBalanceWei: string;
    targets: Record<string, string | null>;
  }>;
  run(scenarioId: string): Promise<{ runId: string; txHashes: string[] }>;
};

export type SignerHealthHandler = (params: { signer: string; chainId: number }) => Promise<{
  balanceWei: string;
  latestNonce: number;
  pendingNonce: number;
  missingNonces: number[];
  runwayActions: number | null;
}>;

export type DiagnoseHandler = (params: { txHash: string; chainId: number }) => Promise<unknown>;

/**
 * Plan a remediation for someone else to sign, and verify what they signed.
 *
 * The route that opens nonce-precise remediation to an address whose key
 * Blackbox does not hold, which is every address but its own.
 */
export type ProposalHandler = {
  plan(incidentId: string): Promise<unknown>;
  accept(incidentId: string, txHash: string): Promise<{ accepted: boolean; reason?: string } & Record<string, unknown>>;
};

/**
 * Chaos the caller signs themselves.
 *
 * Distinct from `chaos` on purpose. That one needs a funded key Blackbox
 * holds, so it only exists where we are willing to spend. This one holds no
 * key and spends nothing: it returns unsigned transactions built for the
 * caller's own address, which is what makes it safe to expose publicly.
 */
export type ChaosPlanHandler = {
  plan(params: { scenario: string; signer: string; chainId: number }): Promise<
    { declined?: string } & Record<string, unknown>
  >;
  /**
   * Accept the hashes their wallet produced.
   *
   * Not optional politeness: a nonce-gap transaction is queued rather than
   * mined, so it appears in no block and block scanning can never find it.
   * The wallet is the only party that knows it exists.
   */
  observe(params: { txHashes: string[]; chainId: number; runId?: string }): Promise<{
    observed: { txHash: string; signer: string; nonce: number }[];
    ignored: { txHash: string; reason: string }[];
  }>;
};

export type AppOptions = {
  db: Database;
  config: BlackboxConfig;
  bus?: EventBus;
  /** Absent means the route 404s: this process cannot remediate. */
  remediate?: RemediateHandler;
  chaos?: ChaosHandler;
  /** Plans chaos for the caller's own wallet. Needs no key, so it is safe on a public URL. */
  chaosPlan?: ChaosPlanHandler;
  signerHealth?: SignerHealthHandler;
  /** Explains any transaction hash, for someone who has integrated nothing. */
  diagnose?: DiagnoseHandler;
  /** Propose-and-verify remediation, for a signer Blackbox has no key for. */
  proposals?: ProposalHandler;
  logger?: boolean;
  /** Request budget per caller. Absent means the defaults, which are not off. */
  rateLimits?: { perMinute?: number };
};

const DEFAULT_CHAIN = 11155111;

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { db, config } = options;
  const bus = options.bus ?? new EventBus();

  // 64 KB. Nothing this API accepts is large, and the default megabyte is an
  // invitation on an endpoint anyone can reach.
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024 });
  await app.register(cors, { origin: true });

  // Deliberately unauthenticated — a judge should need no account — so the
  // budget has to be enforced per caller instead of per user. The tight limits
  // below sit on the routes that cost us money rather than cycles: a model
  // call, a fan-out of RPC lookups, a row that the scanner then revisits every
  // tick for the rest of the deployment's life.
  const limits = options.rateLimits ?? {};
  await app.register(rateLimit, {
    global: true,
    max: limits.perMinute ?? 120,
    timeWindow: '1 minute',
  });

  /** Applied to the routes where one request buys a disproportionate amount of our work. */
  const costly = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: 'not_found',
      detail: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    }),
  );

  app.setErrorHandler((error: unknown, request, reply) => {
    request.log.error(error);
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode) || 500
        : 500;
    // Being refused for asking too often is not an internal error, and a
    // console that renders it as one would tell the user the server is broken
    // when it is working exactly as intended.
    if (status === 429) {
      return reply.code(429).send({
        error: 'rate_limited',
        detail: 'Too many requests to this route; wait a minute and try again',
        requestId: request.id,
      });
    }
    reply.code(status).send({
      error: 'internal_error',
      detail: error instanceof Error ? error.message : String(error),
      requestId: request.id,
    });
  });

  app.get('/api/health', async () => ({ ok: true, at: new Date().toISOString() }));

  app.get('/api/config', async () => ({
    chains: Object.values(CHAINS).map((chain) => ({
      chainId: chain.chainId,
      name: chain.name,
      testnet: chain.isTestnet,
      privateMempool: chain.privateMempool,
      explorerTxUrl: chain.explorerTxUrl('{hash}'),
    })),
    remediation: {
      dryRun: config.remediation.dryRun,
      minConfidence: config.remediation.minConfidence,
      maxAttempts: config.remediation.maxAttempts,
      signerAllowlist: config.remediation.signerAllowlist,
      chainAllowlist: config.remediation.chainAllowlist,
      budget: {
        maxRemediationsPerHour: config.remediation.budget.maxRemediationsPerHour,
        maxGasWeiPerHour: config.remediation.budget.maxGasWeiPerHour.toString(),
      },
    },
    /**
     * Which rules can fire for which kind of agent.
     *
     * A KeeperHub agent runs on a managed wallet whose nonces and gas the
     * platform owns, so the rules built on those have nothing to say about it.
     * Publishing this stops the console offering a detection that cannot
     * happen, and lets an operator see why a rule they expected is absent.
     */
    rules: {
      keeperhub: rulesFor('keeperhub'),
      signer: rulesFor('signer'),
    },
    // The console hides controls it cannot drive rather than showing buttons
    // that 404.
    capabilities: {
      remediate: Boolean(options.remediate),
      chaos: Boolean(options.chaos),
      signChaos: Boolean(options.chaosPlan),
      diagnose: Boolean(options.diagnose),
      signerHealth: Boolean(options.signerHealth),
      proposeRemediation: Boolean(options.proposals),
    },
  }));

  app.get('/api/stats', async () => {
    const result = await stats(db);
    return { ...result, updatedAt: result.updatedAt.toISOString() };
  });

  app.get('/api/incidents', async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const limit = q['limit'] ? Math.min(Number(q['limit']), 200) : 50;
    const rows = await listIncidents(db, {
      limit,
      ...(q['status'] ? { status: q['status'] } : {}),
      ...(q['class'] ? { class: q['class'] } : {}),
      ...(q['severity'] ? { severity: q['severity'] } : {}),
      ...(q['agentId'] ? { agentId: q['agentId'] } : {}),
      ...(q['signer'] ? { signer: q['signer'] } : {}),
      ...(q['chainId'] ? { chainId: Number(q['chainId']) } : {}),
      ...(q['since'] ? { since: new Date(q['since']) } : {}),
    });
    return {
      items: rows.map((row) => incidentSummary(row as IncidentRow)),
      nextCursor: null,
      total: rows.length,
    };
  });

  app.get('/api/incidents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await getIncident(db, id);
    if (!row) {
      return reply
        .code(404)
        .send({ error: 'not_found', detail: `Incident ${id} not found`, requestId: request.id });
    }
    const evidence = row.evidence as { eventIds?: string[] } | null;
    const [events, ledger] = await Promise.all([
      eventsByIds(db, evidence?.eventIds ?? []),
      ledgerForIncident(db, id),
    ]);
    return incidentDetail(row as IncidentRow, events, ledger);
  });

  app.post('/api/incidents/:id/acknowledge', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await getIncident(db, id);
    if (!row) {
      return reply
        .code(404)
        .send({ error: 'not_found', detail: `Incident ${id} not found`, requestId: request.id });
    }
    await saveIncident(db, { ...row, status: 'acknowledged' });
    const summary = incidentSummary({ ...row, status: 'acknowledged' } as IncidentRow);
    bus.publish({ type: 'incident.updated', data: summary });
    return summary;
  });

  if (options.remediate) {
    const remediate = options.remediate;
    app.post('/api/incidents/:id/remediate', async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = await getIncident(db, id);
      if (!row) {
        return reply
          .code(404)
          .send({ error: 'not_found', detail: `Incident ${id} not found`, requestId: request.id });
      }

      const result = await remediate(id);
      // A refusal is an outcome, not an error: 200 with the guards that blocked
      // it, so the console renders the reason as prominently as a success.
      return reply.code(result.accepted ? 202 : 200).send({ incidentId: id, ...result });
    });
  }

  if (options.proposals) {
    const proposals = options.proposals;

    // What transaction would fix this, and who has to sign it. Read-only.
    app.get('/api/incidents/:id/remediation-plan', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await getIncident(db, id))) {
        return reply
          .code(404)
          .send({ error: 'not_found', detail: `Incident ${id} not found`, requestId: request.id });
      }
      return proposals.plan(id);
    });

    // A transaction the owner's wallet signed, offered as the remediation.
    app.post('/api/incidents/:id/remediation-tx', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await getIncident(db, id))) {
        return reply
          .code(404)
          .send({ error: 'not_found', detail: `Incident ${id} not found`, requestId: request.id });
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      const txHash = String(body['txHash'] ?? '');
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return reply.code(400).send({
          error: 'invalid_tx_hash',
          detail: `"${txHash}" is not a 32-byte transaction hash`,
          requestId: request.id,
        });
      }

      const result = await proposals.accept(id, txHash);
      if (!result.accepted) {
        // A hash that does not match the plan is a rejected claim, not a server
        // error: the caller is told exactly which check failed.
        return reply.code(422).send({
          error: 'transaction_rejected',
          detail: result.reason ?? 'The transaction does not match this incident.',
          requestId: request.id,
        });
      }

      const updated = await getIncident(db, id);
      if (updated) bus.publish({ type: 'incident.updated', data: incidentSummary(updated as IncidentRow) });
      bus.publish({ type: 'remediation.succeeded', data: { incidentId: id, txHash, ...result } });
      return result;
    });
  }

  app.get('/api/agents', async () => {
    const agents = await listAgents(db);
    const watched = await activeSigners(db);
    return {
      items: agents.map((agent) => ({
        ...agent,
        label: watched.find((w) => w.agentId === agent.agentId)?.label ?? null,
        selfRemediation: agent.agentId !== 'blackbox',
      })),
    };
  });

  // --- watching an arbitrary address ---------------------------------------
  // The route that makes this usable by someone who did not build it: register
  // any address and its transactions are discovered by block scanning.

  /**
   * A watched address is a standing cost, not a one-off write.
   *
   * The block scanner loads every active signer on every tick and matches it
   * against every transaction in every new block, for as long as the
   * deployment lives. Anyone can register anything here, so the registry needs
   * a ceiling and a rule about who may rename what.
   */
  const MAX_WATCHED = 500;
  const short = (value: unknown, max = 64): string => String(value ?? '').slice(0, max);

  const registerWatch = async (params: {
    signer: string;
    chainId: number;
    agentId: string;
    label: string;
  }): Promise<{ registered: boolean; reason?: string }> => {
    const rows = await activeSigners(db);
    const already = rows.find(
      (row) => row.signer.toLowerCase() === params.signer.toLowerCase() && row.chainId === params.chainId,
    );
    // Re-registering an address that is already watched is a no-op rather than
    // an update. The upsert underneath would happily rewrite the label and
    // agent of a row somebody else created, which is a free way to relabel
    // another participant's demo — or ours.
    if (already) return { registered: true };
    if (rows.length >= MAX_WATCHED) {
      return {
        registered: false,
        reason: `This deployment is already watching ${MAX_WATCHED} addresses, which is its ceiling`,
      };
    }
    await watchSigner(db, {
      signer: params.signer,
      chainId: params.chainId,
      agentId: short(params.agentId),
      label: short(params.label),
      at: new Date(),
    });
    return { registered: true };
  };

  app.get('/api/watched', async () => {
    const rows = await activeSigners(db);
    return {
      items: rows.map((row) => ({
        signer: row.signer,
        chainId: row.chainId,
        agentId: row.agentId,
        label: row.label,
        registeredAt: row.registeredAt.toISOString(),
      })),
    };
  });

  app.post('/api/watched', costly(20), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const signer = String(body['signer'] ?? '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(signer)) {
      return reply.code(400).send({
        error: 'invalid_address',
        detail: `"${signer}" is not a 20-byte hex address`,
        requestId: request.id,
      });
    }
    const chainId = Number(body['chainId'] ?? DEFAULT_CHAIN);
    try {
      getChain(chainId);
    } catch {
      return reply.code(400).send({
        error: 'unsupported_chain',
        detail: `Chain ${chainId} is not configured`,
        requestId: request.id,
      });
    }

    const result = await registerWatch({
      signer,
      chainId,
      agentId: String(body['agentId'] ?? signer.slice(0, 10)),
      label: String(body['label'] ?? ''),
    });
    if (!result.registered) {
      return reply.code(429).send({ error: 'watch_limit', detail: result.reason, requestId: request.id });
    }
    return reply.code(201).send({ signer: signer.toLowerCase(), chainId, watching: true });
  });

  if (options.chaosPlan) {
    const chaosPlan = options.chaosPlan;

    // Deliberately a sibling of /api/chaos/run rather than a mode of it. The
    // two differ in who pays and who signs, which is the whole distinction
    // worth exposing: this one can run on a public URL because it can spend
    // nothing.
    app.post('/api/chaos/plan', costly(20), async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const signer = String(body['signer'] ?? '');
      if (!/^0x[0-9a-fA-F]{40}$/.test(signer)) {
        return reply.code(400).send({
          error: 'invalid_address',
          detail: `"${signer}" is not a 20-byte hex address`,
          requestId: request.id,
        });
      }
      const chainId = Number(body['chainId'] ?? DEFAULT_CHAIN);
      let chain;
      try {
        chain = getChain(chainId);
      } catch {
        return reply.code(400).send({
          error: 'unsupported_chain',
          detail: `Chain ${chainId} is not configured`,
          requestId: request.id,
        });
      }
      // Chaos costs the caller real gas. Planning it against a chain where
      // that is real money is not ours to offer, whatever they asked for.
      if (!chain.isTestnet) {
        return reply.code(400).send({
          error: 'mainnet_refused',
          detail: `${chain.name} is not a testnet; Blackbox will not plan a deliberate failure there`,
          requestId: request.id,
        });
      }

      const scenario = String(body['scenario'] ?? '');
      const plan = await chaosPlan.plan({ scenario, signer, chainId });

      // Registering the address is what makes the rest happen on its own: the
      // block scanner picks their transactions up without them reporting a
      // hash, so the loop they are about to trigger runs unattended. Skipped
      // on a declined plan, which registers an address for nothing.
      let watching = false;
      if (!plan.declined) {
        const result = await registerWatch({
          signer,
          chainId,
          agentId: String(body['agentId'] ?? signer.slice(0, 10)),
          label: String(body['label'] ?? 'self-signed chaos'),
        });
        watching = result.registered;
        // Worth saying out loud rather than handing back a plan that will be
        // signed and then watched by nobody.
        if (!result.registered) return { ...plan, watching, declined: result.reason };
      }

      // A scenario this deployment cannot plan is a stated refusal, not an
      // error — same treatment as a guard declining a remediation.
      return { ...plan, watching };
    });

    app.post('/api/chaos/observe', costly(10), async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const txHashes = Array.isArray(body['txHashes']) ? (body['txHashes'] as string[]) : [];
      if (txHashes.length === 0) {
        return reply.code(400).send({
          error: 'no_transactions',
          detail: 'Send the hashes your wallet returned as `txHashes`',
          requestId: request.id,
        });
      }
      const chainId = Number(body['chainId'] ?? DEFAULT_CHAIN);
      const result = await chaosPlan.observe({
        txHashes: txHashes.slice(0, 20),
        chainId,
        ...(body['runId'] ? { runId: String(body['runId']) } : {}),
      });

      // Every reported transaction is attributed to whoever actually signed
      // it, read from the chain — so each sender is registered on the strength
      // of their own signature, not on the caller's say-so.
      for (const { signer } of result.observed) {
        await registerWatch({
          signer,
          chainId,
          agentId: signer.slice(0, 10),
          label: 'self-signed chaos',
        });
      }
      return result;
    });
  }

  app.delete('/api/watched/:signer', async (request) => {
    const { signer } = request.params as { signer: string };
    const q = request.query as Record<string, string | undefined>;
    const chainId = Number(q['chainId'] ?? DEFAULT_CHAIN);
    await unwatchSigner(db, signer, chainId);
    return { signer: signer.toLowerCase(), chainId, watching: false };
  });

  if (options.signerHealth) {
    const signerHealth = options.signerHealth;
    app.get('/api/signers/:signer/health', async (request) => {
      const { signer } = request.params as { signer: string };
      const q = request.query as Record<string, string | undefined>;
      const chainId = Number(q['chainId'] ?? DEFAULT_CHAIN);
      const [health, open] = await Promise.all([
        signerHealth({ signer, chainId }),
        listIncidents(db, { signer, chainId, status: 'open' }),
      ]);
      return {
        signer,
        chainId,
        ...health,
        openIncidents: open.map((row) => incidentSummary(row as IncidentRow)),
      };
    });
  }

  if (options.diagnose) {
    const diagnose = options.diagnose;
    // Explain any transaction, with nothing registered and nothing installed.
    app.post('/api/diagnose', costly(10), async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const txHash = String(body['txHash'] ?? '');
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return reply.code(400).send({
          error: 'invalid_tx_hash',
          detail: `"${txHash}" is not a 32-byte transaction hash`,
          requestId: request.id,
        });
      }
      return diagnose({ txHash, chainId: Number(body['chainId'] ?? DEFAULT_CHAIN) });
    });
  }

  if (options.chaos) {
    const chaos = options.chaos;
    app.get('/api/chaos/scenarios', async () => ({
      ...(await chaos.context()),
      items: chaos.scenarios(),
    }));

    app.post('/api/chaos/run', async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const id = String(body['scenario'] ?? '');
      const scenario = chaos.scenarios().find((s) => s.id === id);
      if (!scenario) {
        return reply.code(404).send({
          error: 'not_found',
          detail: `Unknown scenario ${id}`,
          requestId: request.id,
        });
      }
      if (!scenario.enabled) {
        return reply.code(409).send({
          error: 'scenario_unavailable',
          detail: scenario.note,
          requestId: request.id,
        });
      }

      const started = await chaos.run(id);
      bus.publish({ type: 'chaos.started', data: { ...started, scenario: id } });
      return reply.code(202).send({
        ...started,
        scenario: id,
        expectedIncidentClass: scenario.induces[0],
      });
    });
  }

  // --- SSE ------------------------------------------------------------------
  app.get('/api/stream', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('hello', { at: new Date().toISOString(), chainId: DEFAULT_CHAIN });
    const unsubscribe = bus.subscribe((event) => send(event.type, event.data));
    // Proxies drop an idle connection; a comment frame is not an event and the
    // client ignores it.
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  return app;
}
