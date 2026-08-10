import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { CHAINS, getChain, type BlackboxConfig } from '@blackbox/core';
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

export type AppOptions = {
  db: Database;
  config: BlackboxConfig;
  bus?: EventBus;
  /** Absent means the route 404s: this process cannot remediate. */
  remediate?: RemediateHandler;
  chaos?: ChaosHandler;
  signerHealth?: SignerHealthHandler;
  /** Explains any transaction hash, for someone who has integrated nothing. */
  diagnose?: DiagnoseHandler;
  logger?: boolean;
};

const DEFAULT_CHAIN = 11155111;

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { db, config } = options;
  const bus = options.bus ?? new EventBus();

  const app = Fastify({ logger: options.logger ?? false });
  await app.register(cors, { origin: true });

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
    // The console hides controls it cannot drive rather than showing buttons
    // that 404.
    capabilities: {
      remediate: Boolean(options.remediate),
      chaos: Boolean(options.chaos),
      diagnose: Boolean(options.diagnose),
      signerHealth: Boolean(options.signerHealth),
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

  app.post('/api/watched', async (request, reply) => {
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

    await watchSigner(db, {
      signer,
      chainId,
      agentId: String(body['agentId'] ?? signer.slice(0, 10)),
      ...(body['label'] ? { label: String(body['label']) } : {}),
      at: new Date(),
    });
    return reply.code(201).send({ signer: signer.toLowerCase(), chainId, watching: true });
  });

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
    app.post('/api/diagnose', async (request, reply) => {
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
