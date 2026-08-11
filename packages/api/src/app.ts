import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { CHAINS, getChain, KeeperHubClient, type BlackboxConfig } from '@blackbox/core';
import { rulesFor } from '@blackbox/detector';
import {
  agentsOwnedBy,
  claimAgent,
  mayAct,
  type Caller,
  type Identity,
} from './identity.js';
import type { KeeperHubOAuth } from './oauth.js';
import { lifetimeDays, MAX_LIFETIME_DAYS, MIN_LIFETIME_DAYS, type Connections } from './connections.js';
import { codeNodeSnippet, type Webhooks } from './webhooks.js';
import type { WalletAuth } from './wallet-auth.js';
import {
  activeSigners,
  claimAgentForOrg,
  eventsByIds,
  listWatchedWorkflows,
  unwatchWorkflow,
  watchWorkflows,
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
import { PLANNABLE_SCENARIOS, plannableScenarios } from './chaos-plans.js';
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
  /**
   * Sign-in with a KeeperHub organisation key. Absent leaves every agent
   * unowned and every action open, which is the right default for a local run
   * and the wrong one for a deployment.
   */
  identity?: Identity;
  /**
   * "Connect KeeperHub" sign-in. Absent leaves only the paste-a-key path, which
   * suits a script and asks too much of a person.
   */
  oauth?: KeeperHubOAuth;
  /**
   * Stores connected KeeperHub accounts. Absent means sign-in still works and
   * "connect" is refused rather than quietly downgraded to a sign-in — an
   * operator who asked us to watch their workflows should not be told yes and
   * then watched nothing.
   */
  connections?: Connections;
  /** Overrides the KeeperHub API base, for tests and for a staging provider. */
  keeperHubApiUrl?: string;
  /** Injected transport for reads on a connection's behalf; tests use it. */
  keeperHubFetch?: typeof fetch;
  /**
   * Inbound nudges. Absent means the loop is the only thing that reads runs,
   * which is slower but not broken.
   */
  webhooks?: Webhooks;
  /**
   * Ownership proved by signature, for an agent that holds its own key and
   * belongs to no KeeperHub organisation.
   */
  walletAuth?: WalletAuth;
  /** This deployment's public address, used to write the code-node snippet. */
  publicUrl?: string;
  /**
   * Installs KeeperHub-side triggers that call this deployment. Absent means
   * the local tick is the only thing that drives detection.
   */
  /** Reported at `/api/config`; resolved once at startup. */
  triggerAvailability?: { available: boolean; reason?: string };
  triggers?: {
    installSchedule(
      orgId: string,
      params: { intervalSeconds?: number; cron?: string; timezone?: string },
    ): Promise<{ workflowId: string; created: boolean }>;
    installEvent(
      orgId: string,
      params: {
        contractAddress: string;
        eventName: string;
        network: string;
        contractABI?: string;
      },
    ): Promise<{ workflowId: string; created: boolean }>;
  };
  /**
   * Agents any visitor may read. Unset means all of them, which keeps a local
   * run and the public demo legible; set on a deployment that hosts more than
   * its own demo agents.
   */
  publicAgentIds?: readonly string[];
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
    /**
     * Whether KeeperHub can host a trigger for this organisation. Their code
     * action is Pro-only, so on a free plan the answer is no — better said here
     * than discovered by an operator pressing a button that 402s.
     */
    ...(options.triggerAvailability ? { triggers: options.triggerAvailability } : {}),
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

  app.get('/api/stats', async (request) => {
    const readable = await readableAgents(await callerOf(request));
    const result = await stats(db, new Date(), readable ?? undefined);
    return { ...result, updatedAt: result.updatedAt.toISOString() };
  });

  /**
   * Who is asking. Absent for anyone who has not signed in, which is most
   * callers and is fine — signing in is what makes an agent *yours*, not what
   * makes the product usable.
   */
  const callerOf = async (request: { headers: Record<string, unknown> }): Promise<Caller | null> => {
    if (!options.identity) return null;
    const header = String(request.headers['authorization'] ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    return options.identity.caller(token);
  };

  /**
   * Which agents this caller may read: the public set, plus anything they own.
   * Null means no restriction at all — the local default.
   */
  const readableAgents = async (caller: Caller | null): Promise<string[] | null> => {
    if (!options.publicAgentIds) return null;
    const owned = caller ? await agentsOwnedBy(db, caller.orgId) : [];
    return [...new Set([...options.publicAgentIds, ...owned])];
  };

  if (options.identity) {
    const identity = options.identity;

    /**
     * Exchange an organisation key for a session token.
     *
     * The key is used for one verifying request and never stored. Rate-limited
     * hard because it is the one route where guessing has a prize.
     */
    app.post('/api/auth/keeperhub', costly(5), async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const orgKey = typeof body['orgKey'] === 'string' ? body['orgKey'].trim() : '';
      // A webhook key reads fine and executes nothing, so accepting one would
      // hand back a session that cannot do what its holder expects.
      if (!orgKey.startsWith('kh_')) {
        return reply.code(400).send({
          error: 'bad_request',
          detail: 'A KeeperHub organisation key (kh_…) is required.',
          requestId: request.id,
        });
      }
      const label = typeof body['label'] === 'string' ? body['label'].slice(0, 64) : undefined;
      const result = await identity.signIn(orgKey, label);
      if (!result.ok) {
        return reply.code(401).send({
          error: 'unauthorized',
          detail:
            result.reason === 'no_keys'
              ? 'That key is valid but names no organisation we can pin it to.'
              : 'KeeperHub rejected that key.',
          requestId: request.id,
        });
      }
      return reply.code(201).send({ token: result.token, orgId: result.orgId });
    });

    if (options.oauth) {
      const oauth = options.oauth;

      /**
       * Where to send the operator to sign in.
       *
       * Returns the URL rather than redirecting, so a console can open it in a
       * popup and a script can print it. `returnTo` is restricted to a path on
       * this deployment: an open redirect here would hand a freshly minted
       * session token to somebody else's site.
       */
      app.get('/api/auth/keeperhub/start', costly(20), async (request, reply) => {
        const q = request.query as Record<string, string | undefined>;
        const returnTo = q['returnTo'];
        if (returnTo && !returnTo.startsWith('/')) {
          return reply.code(400).send({
            error: 'bad_request',
            detail: 'returnTo must be a path on this deployment.',
            requestId: request.id,
          });
        }

        /**
         * `connect=1` asks for more than a sign-in: it asks Blackbox to keep a
         * read-only credential so it can go on reading this organisation's
         * runs. Refused outright when this deployment cannot store one, since
         * silently signing them in instead would promise a watch that never
         * happens — which is exactly the gap this whole flow closes.
         */
        const wantsConnection = q['connect'] === '1' || q['connect'] === 'true';
        if (wantsConnection && !options.connections) {
          return reply.code(501).send({
            error: 'not_configured',
            detail:
              'This deployment cannot store a connection; set BLACKBOX_ENCRYPTION_KEY to enable it.',
            requestId: request.id,
          });
        }
        const days = wantsConnection ? lifetimeDays(Number(q['days'])) : undefined;

        try {
          const started = await oauth.start(returnTo, days);
          return {
            url: started.url,
            ...(days === undefined
              ? {}
              : {
                  connect: {
                    days,
                    min: MIN_LIFETIME_DAYS,
                    max: MAX_LIFETIME_DAYS,
                    /** Said plainly: this is what the credential can and cannot do. */
                    scope: 'mcp:read',
                  },
                }),
          };
        } catch (error) {
          return reply.code(502).send({
            error: 'provider_unavailable',
            detail: String((error as Error)?.message ?? error),
            requestId: request.id,
          });
        }
      });

      /**
       * Where KeeperHub sends the operator back.
       *
       * The session token goes in the URL *fragment*, which browsers do not
       * send to servers and proxies do not log. A query parameter would put a
       * live credential into every access log between here and them.
       */
      app.get('/api/auth/keeperhub/callback', async (request, reply) => {
        const q = request.query as Record<string, string | undefined>;
        if (q['error']) {
          return reply
            .code(400)
            .send({ error: 'denied', detail: q['error'], requestId: request.id });
        }
        const code = q['code'];
        const state = q['state'];
        if (!code || !state) {
          return reply.code(400).send({
            error: 'bad_request',
            detail: 'code and state are required.',
            requestId: request.id,
          });
        }

        const result = await oauth.complete({ code, state });
        if (!result.ok) {
          return reply.code(401).send({
            error: 'unauthorized',
            detail:
              result.reason === 'unknown_state'
                ? 'That sign-in has expired or was already used.'
                : 'KeeperHub declined the exchange.',
            requestId: request.id,
          });
        }

        /**
         * Store the credential *before* the session exists.
         *
         * Their refresh tokens rotate, so a session handed out for a
         * connection that failed to persist would be a caller believing their
         * workflows are watched when the only credential for them is gone.
         */
        if (result.connectDays !== null && options.connections) {
          if (!result.refreshToken) {
            return reply.code(502).send({
              error: 'no_refresh_token',
              detail: 'KeeperHub returned no refresh token, so the account cannot be connected.',
              requestId: request.id,
            });
          }
          try {
            await options.connections.connect({
              orgId: result.orgId,
              refreshToken: result.refreshToken,
              scope: result.scope,
              subject: result.subject,
              days: result.connectDays,
            });
          } catch (error) {
            return reply.code(500).send({
              error: 'connection_not_stored',
              detail: String((error as Error)?.message ?? error),
              requestId: request.id,
            });
          }
        }

        const session = await identity.signInWithOrg({
          orgId: result.orgId,
          subject: result.subject,
        });
        if (result.returnTo) {
          const fragment = `#token=${session.token}&orgId=${encodeURIComponent(session.orgId)}`;
          return reply.redirect(`${result.returnTo}${fragment}`);
        }
        return reply.code(201).send({ token: session.token, orgId: session.orgId });
      });
    }

    if (options.walletAuth) {
      const walletAuth = options.walletAuth;

      /**
       * Ask for something to sign.
       *
       * Rate-limited because it is unauthenticated by necessity — proving who
       * you are is what this is for — and every call costs a stored nonce.
       */
      app.post('/api/auth/wallet/challenge', costly(20), async (request, reply) => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const address = String(body['address'] ?? '');
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
          return reply.code(400).send({
            error: 'invalid_address',
            detail: `"${address}" is not a 20-byte hex address`,
            requestId: request.id,
          });
        }
        return walletAuth.issue(address as `0x${string}`);
      });

      /**
       * Prove it, and take ownership of the agents that address signs for.
       *
       * The address is recovered from the signature rather than read from the
       * request — a caller naming an address proves nothing about it. The
       * tenant is the address itself, since an agent holding its own key
       * belongs to no organisation.
       */
      app.post('/api/auth/wallet/verify', costly(20), async (request, reply) => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const nonce = String(body['nonce'] ?? '');
        const signature = String(body['signature'] ?? '');
        if (!nonce || !/^0x[0-9a-fA-F]+$/.test(signature)) {
          return reply.code(400).send({
            error: 'bad_request',
            detail: 'nonce and signature are required.',
            requestId: request.id,
          });
        }

        const result = await walletAuth.verify({
          nonce,
          signature: signature as `0x${string}`,
          ...(typeof body['address'] === 'string' ? { address: body['address'] } : {}),
        });
        if (!result.ok) {
          return reply.code(401).send({
            error: 'unauthorized',
            detail:
              result.reason === 'expired'
                ? 'That challenge has expired; ask for another.'
                : result.reason === 'unknown_nonce'
                  ? 'That challenge is unknown or was already used.'
                  : 'The signature does not match that challenge.',
            requestId: request.id,
          });
        }

        // One tenant per address. Every scoping check downstream already reads
        // an opaque org id, so a wallet needs no separate code path.
        const orgId = `wallet:${result.address}`;
        const session = await identity.signInWithOrg({
          orgId,
          subject: result.address,
          label: 'wallet',
        });

        /**
         * Claim what this address is actually the agent for: the conventional
         * id used when a wallet registers itself, plus any agent already
         * watching this exact signer. Claiming is best-effort — an agent
         * another tenant already owns stays theirs, and the session is still
         * valid for whatever else this address holds.
         */
        const claimed: string[] = [];
        const candidates = new Set<string>([result.address.slice(0, 10)]);
        for (const row of await activeSigners(db)) {
          if (row.signer.toLowerCase() === result.address.toLowerCase()) {
            candidates.add(row.agentId);
          }
        }
        for (const agentId of candidates) {
          if ((await claimAgent(db, { agentId, orgId })) !== 'owned_by_another') {
            claimed.push(agentId);
          }
        }

        return reply.code(201).send({
          token: session.token,
          orgId,
          address: result.address,
          agents: claimed,
        });
      });
    }

    app.post('/api/auth/signout', async (request) => {
      const header = String(request.headers['authorization'] ?? '');
      if (header.startsWith('Bearer ')) await identity.revoke(header.slice(7));
      return { signedOut: true };
    });

    /** What this session is, and what it owns. */
    app.get('/api/auth/session', async (request, reply) => {
      const caller = await callerOf(request);
      if (!caller) {
        return reply
          .code(401)
          .send({ error: 'unauthorized', detail: 'No session.', requestId: request.id });
      }
      return { orgId: caller.orgId, agents: await agentsOwnedBy(db, caller.orgId) };
    });

    if (options.connections) {
      const connections = options.connections;

      /**
       * Everything below manages the caller's own connection and nobody
       * else's: the organisation comes from the session, never from the
       * request, so there is no id to tamper with.
       */
      const requireCaller = async (
        request: { headers: Record<string, unknown>; id: string },
        reply: { code: (n: number) => { send: (b: unknown) => unknown } },
      ) => {
        const caller = await callerOf(request);
        if (!caller) {
          reply.code(401).send({
            error: 'unauthorized',
            detail: 'Sign in to manage a KeeperHub connection.',
            requestId: request.id,
          });
          return null;
        }
        return caller;
      };

      /** Is this organisation connected, since when, and in what state. */
      app.get('/api/connections/keeperhub', async (request, reply) => {
        const caller = await requireCaller(request, reply);
        if (!caller) return;

        const connection = await connections.get(caller.orgId);
        if (!connection || connection.status === 'disconnected') {
          return { connected: false, orgId: caller.orgId, watching: [] };
        }
        return {
          connected: connection.status === 'active',
          orgId: caller.orgId,
          status: connection.status,
          scope: connection.scope,
          connectedAt: connection.connectedAt.toISOString(),
          expiresAt: connection.expiresAt.toISOString(),
          lastRefreshedAt: connection.lastRefreshedAt?.toISOString() ?? null,
          lastSweptAt: connection.lastSweptAt?.toISOString() ?? null,
          lastError: connection.lastError,
          watching: await listWatchedWorkflows(db, caller.orgId, { activeOnly: true }),
          /**
           * Stated rather than implied: disconnecting deletes our copy of the
           * credential and cannot invalidate it on KeeperHub, because they
           * expose no endpoint that would.
           */
          revocation: 'local_only',
        };
      });

      /** Their workflows, for the operator to pick from. */
      app.get('/api/connections/keeperhub/workflows', costly(30), async (request, reply) => {
        const caller = await requireCaller(request, reply);
        if (!caller) return;

        const token = await connections.accessTokenFor(caller.orgId);
        if (!token.ok) {
          return reply.code(token.reason === 'unavailable' ? 502 : 409).send({
            error: token.reason,
            detail: token.detail,
            requestId: request.id,
          });
        }

        const watched = new Map(
          (await listWatchedWorkflows(db, caller.orgId)).map((w) => [w.workflowId, w]),
        );
        const client = new KeeperHubClient({
          accessToken: token.accessToken,
          ...(options.keeperHubApiUrl ? { baseUrl: options.keeperHubApiUrl } : {}),
          ...(options.keeperHubFetch ? { fetchImpl: options.keeperHubFetch } : {}),
        });
        try {
          const workflows = await client.listWorkflows();
          return {
            workflows: workflows.map((w) => ({
              id: w.id,
              name: w.name,
              enabled: w.enabled ?? null,
              watched: watched.get(w.id)?.active === true,
            })),
          };
        } catch (error) {
          return reply.code(502).send({
            error: 'provider_unavailable',
            detail: String((error as Error)?.message ?? error),
            requestId: request.id,
          });
        }
      });

      /**
       * Pick what to watch.
       *
       * Nothing is watched on connect, so this is the step that makes a
       * connection do anything at all.
       */
      app.post('/api/connections/keeperhub/workflows', async (request, reply) => {
        const caller = await requireCaller(request, reply);
        if (!caller) return;

        const connection = await connections.get(caller.orgId);
        if (!connection || connection.status === 'disconnected') {
          return reply.code(409).send({
            error: 'not_connected',
            detail: 'Connect a KeeperHub account before choosing workflows.',
            requestId: request.id,
          });
        }

        const body = (request.body ?? {}) as Record<string, unknown>;
        const raw = Array.isArray(body['workflows']) ? body['workflows'] : [];
        const workflows = raw
          .map((entry) =>
            typeof entry === 'string'
              ? { workflowId: entry }
              : {
                  workflowId: String((entry as Record<string, unknown>)?.['id'] ?? ''),
                  name:
                    typeof (entry as Record<string, unknown>)?.['name'] === 'string'
                      ? String((entry as Record<string, unknown>)['name'])
                      : null,
                },
          )
          .filter((w) => w.workflowId !== '');

        if (workflows.length === 0) {
          return reply.code(400).send({
            error: 'bad_request',
            detail: 'Name at least one workflow to watch.',
            requestId: request.id,
          });
        }

        const at = new Date();
        await watchWorkflows(db, { orgId: caller.orgId, workflows, at });

        /**
         * Claim each workflow's agent for this organisation.
         *
         * Picking a workflow to watch is already the act of saying it is
         * yours, so making the operator claim it again by hand would be asking
         * twice. A workflow another tenant already claimed stays theirs — that
         * is reported rather than overridden.
         */
        const contested: string[] = [];
        for (const workflow of workflows) {
          const outcome = await claimAgentForOrg(db, {
            agentId: `kh:${workflow.workflowId}`,
            orgId: caller.orgId,
            at,
          });
          if (outcome === 'owned_by_another') contested.push(workflow.workflowId);
        }

        return reply.code(201).send({
          watching: await listWatchedWorkflows(db, caller.orgId, { activeOnly: true }),
          ...(contested.length > 0 ? { contested } : {}),
        });
      });

      /** Stop watching one. Remembered, so re-picking it costs nothing. */
      app.delete('/api/connections/keeperhub/workflows/:id', async (request, reply) => {
        const caller = await requireCaller(request, reply);
        if (!caller) return;

        const id = String((request.params as Record<string, string>)['id'] ?? '');
        const stopped = await unwatchWorkflow(db, caller.orgId, id);
        if (!stopped) {
          return reply.code(404).send({
            error: 'not_found',
            detail: `"${id}" is not among the workflows this organisation watches.`,
            requestId: request.id,
          });
        }
        return { stopped: id };
      });

      /** Disconnect: forget the credential and stop reading. */
      app.delete('/api/connections/keeperhub', async (request, reply) => {
        const caller = await requireCaller(request, reply);
        if (!caller) return;

        await connections.disconnect(caller.orgId);
        return {
          disconnected: true,
          // Honest about the limit rather than implying more happened.
          note: 'Blackbox has deleted its copy. KeeperHub exposes no way for us to revoke it there.',
        };
      });
    }
  }

  if (options.webhooks) {
    const webhooks = options.webhooks;

    /**
     * Mint a secret for something outside to call us with.
     *
     * Shown once. Only its hash is stored, so a leaked database yields nothing
     * that can be replayed — the same reasoning as the session token, and for
     * the same kind of value.
     */
    app.post('/api/webhooks/keeperhub/secret', costly(5), async (request, reply) => {
      const caller = await callerOf(request);
      if (!caller) {
        return reply.code(401).send({
          error: 'unauthorized',
          detail: 'Sign in before minting a webhook secret.',
          requestId: request.id,
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const label = typeof body['label'] === 'string' ? body['label'].slice(0, 64) : undefined;
      const secret = await webhooks.mint(caller.orgId, label);
      return reply.code(201).send({
        secret,
        orgId: caller.orgId,
        // Said plainly, because the caller cannot come back for it.
        note: 'Store this now. Blackbox keeps only a hash of it.',
        // The code node an operator would otherwise have to write, with this
        // deployment's own address already in it.
        codeNode: options.publicUrl ? codeNodeSnippet(options.publicUrl) : null,
      });
    });

    /**
     * Tell Blackbox to go and look.
     *
     * Deliberately not a way to submit data. KeeperHub has no outbound webhook
     * of its own — a workflow calls us from a `code/run-code` node — so
     * anything in the body is written by whoever set that node up, and trusting
     * it would mean an attacker with a stolen secret could invent incidents.
     * Instead the body is ignored entirely: we authenticate the caller and then
     * read the runs from KeeperHub ourselves.
     *
     * That also makes it idempotent for free. A webhook that arrives twice, or
     * out of order, causes two sweeps of the same data, and events dedupe on
     * (sourceId, attemptIndex) — so a duplicate can never create a second
     * incident.
     */
    app.post('/api/webhooks/keeperhub', costly(60), async (request, reply) => {
      const header = String(request.headers['authorization'] ?? '');
      const provided = header.startsWith('Bearer ') ? header.slice(7) : undefined;
      const org = provided ? await webhooks.verify(provided) : null;
      if (!org) {
        return reply.code(401).send({
          error: 'unauthorized',
          detail: 'A valid webhook secret is required.',
          requestId: request.id,
        });
      }

      const swept = await webhooks.sweep();
      if (!swept) {
        // Authenticated, but this deployment watches no organisation — so
        // there was nothing to go and read. Saying so beats reporting a
        // successful sweep of nothing.
        return reply.code(202).send({ accepted: true, swept: false, orgId: org.orgId });
      }
      return { accepted: true, swept: true, orgId: org.orgId, ...swept };
    });
  }

  if (options.triggers) {
    const triggers = options.triggers;

    /**
     * Hand the loop to KeeperHub.
     *
     * Installs a workflow on their side that calls this deployment — on a
     * schedule, or when a contract emits an event. Requires a signed-in
     * operator because it writes to their organisation's workflow list.
     */
    app.post('/api/triggers/keeperhub', costly(10), async (request, reply) => {
      const caller = await callerOf(request);
      if (!caller) {
        return reply.code(401).send({
          error: 'unauthorized',
          detail: 'Sign in before installing a trigger.',
          requestId: request.id,
        });
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      const kind = String(body['kind'] ?? 'schedule');
      try {
        if (kind === 'schedule') {
          const result = await triggers.installSchedule(caller.orgId, {
            ...(body['intervalSeconds'] !== undefined
              ? { intervalSeconds: Number(body['intervalSeconds']) }
              : {}),
            ...(typeof body['cron'] === 'string' ? { cron: body['cron'] } : {}),
            ...(typeof body['timezone'] === 'string' ? { timezone: body['timezone'] } : {}),
          });
          return reply.code(201).send({ kind, ...result });
        }
        if (kind === 'event') {
          const contractAddress = String(body['contractAddress'] ?? '');
          if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
            return reply.code(400).send({
              error: 'invalid_address',
              detail: `"${contractAddress}" is not a 20-byte hex address`,
              requestId: request.id,
            });
          }
          const eventName = String(body['eventName'] ?? '');
          if (!eventName) {
            return reply.code(400).send({
              error: 'bad_request',
              detail: 'eventName is required for an event trigger.',
              requestId: request.id,
            });
          }
          const result = await triggers.installEvent(caller.orgId, {
            contractAddress,
            eventName,
            network: String(body['network'] ?? DEFAULT_CHAIN),
            ...(typeof body['contractABI'] === 'string'
              ? { contractABI: body['contractABI'] }
              : {}),
          });
          return reply.code(201).send({ kind, ...result });
        }
        // Their Block and Transfer triggers are real, but nothing in their
        // published source names the fields those configs expect. A workflow
        // built on a guess would look installed and never fire.
        return reply.code(400).send({
          error: 'unsupported_trigger',
          detail: `Blackbox can install "schedule" and "event" triggers. "${kind}" is not one it can configure correctly.`,
          requestId: request.id,
        });
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        const name = (error as Error)?.name;
        // Their plan gate is the operator's answer to give, not a fault on
        // either side — so it reads as 402 rather than as our failure.
        if (name === 'UpgradeRequired') {
          return reply
            .code(402)
            .send({ error: 'upgrade_required', detail: message, requestId: request.id });
        }
        const tooSmall = name === 'ScheduleIntervalTooSmall';
        return reply
          .code(tooSmall ? 400 : 502)
          .send({
            error: tooSmall ? 'interval_too_small' : 'provider_error',
            detail: message,
            requestId: request.id,
          });
      }
    });
  }

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
    // Filtered after the query rather than inside it: the visible set is small,
    // and doing it here keeps one rule in one place instead of threading a
    // tenant through every store function.
    const readable = await readableAgents(await callerOf(request));
    const visible = readable ? rows.filter((r) => readable.includes(r.agentId)) : rows;
    return {
      items: visible.map((row) => incidentSummary(row as IncidentRow)),
      nextCursor: null,
      total: visible.length,
    };
  });

  /**
   * Fetch an incident this caller is allowed to see.
   *
   * An incident they may not read answers 404, not 403: a 403 would confirm
   * that an id exists and belongs to somebody, which is more than a stranger
   * should learn from guessing. Acting on one they do not own is a different
   * question and answers 403, because by then they have named an agent they
   * can already see.
   */
  const readableIncident = async (
    request: { headers: Record<string, unknown> },
    id: string,
  ): Promise<NonNullable<Awaited<ReturnType<typeof getIncident>>> | null> => {
    const row = await getIncident(db, id);
    if (!row) return null;
    const readable = await readableAgents(await callerOf(request));
    if (readable && !readable.includes(row.agentId)) return null;
    return row;
  };

  app.get('/api/incidents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await readableIncident(request, id);
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
    const row = await readableIncident(request, id);
    if (!row) {
      return reply
        .code(404)
        .send({ error: 'not_found', detail: `Incident ${id} not found`, requestId: request.id });
    }
    // Acknowledging silences an alarm. On somebody else's agent that is not a
    // small rudeness — it is hiding a live failure from the people who own it.
    if (!(await mayAct(db, row.agentId, await callerOf(request)))) {
      return reply.code(403).send({
        error: 'forbidden',
        detail: `Agent ${row.agentId} belongs to another organisation.`,
        requestId: request.id,
      });
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
      const row = await readableIncident(request, id);
      if (!row) {
        return reply
          .code(404)
          .send({ error: 'not_found', detail: `Incident ${id} not found`, requestId: request.id });
      }

      /**
       * Remediation spends real gas on someone's agent. An unclaimed agent is
       * open — that is what keeps the public demo working — but a claimed one
       * answers only to the organisation that claimed it.
       */
      if (!(await mayAct(db, row.agentId, await callerOf(request)))) {
        return reply.code(403).send({
          error: 'forbidden',
          detail: `Agent ${row.agentId} belongs to another organisation.`,
          requestId: request.id,
        });
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
      if (!(await readableIncident(request, id))) {
        return reply
          .code(404)
          .send({ error: 'not_found', detail: `Incident ${id} not found`, requestId: request.id });
      }
      return proposals.plan(id);
    });

    // A transaction the owner's wallet signed, offered as the remediation.
    app.post('/api/incidents/:id/remediation-tx', async (request, reply) => {
      const { id } = request.params as { id: string };
      const incident = await readableIncident(request, id);
      if (!incident) {
        return reply
          .code(404)
          .send({ error: 'not_found', detail: `Incident ${id} not found`, requestId: request.id });
      }
      // Recording a remediation writes to somebody's history and closes their
      // incident. Only the owner may say what fixed their agent.
      if (!(await mayAct(db, incident.agentId, await callerOf(request)))) {
        return reply.code(403).send({
          error: 'forbidden',
          detail: `Agent ${incident.agentId} belongs to another organisation.`,
          requestId: request.id,
        });
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

  app.get('/api/agents', async (request) => {
    const readable = await readableAgents(await callerOf(request));
    const agents = await listAgents(db, readable ?? undefined);
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
    caller?: Caller | null;
  }): Promise<{
    registered: boolean;
    reason?: string;
    /** Distinguishes "not yours" from "we are full"; they are different answers. */
    code?: 'forbidden' | 'watch_limit';
    owned?: boolean;
  }> => {
    /**
     * Registering under an agent id someone else owns would put their incidents
     * and this address in one bucket, and every ownership check downstream
     * reads that bucket. Refused before anything is written.
     */
    if (!(await mayAct(db, params.agentId, params.caller ?? null))) {
      return {
        registered: false,
        code: 'forbidden',
        reason: `Agent ${params.agentId} belongs to another organisation.`,
      };
    }

    const rows = await activeSigners(db);
    const already = rows.find(
      (row) => row.signer.toLowerCase() === params.signer.toLowerCase() && row.chainId === params.chainId,
    );
    /**
     * Re-registering an address that is already watched does not rewrite the
     * row. The upsert underneath would happily replace the label and agent of a
     * row somebody else created, which is a free way to relabel another
     * participant's demo — or ours.
     *
     * The *claim* still happens, though. It is about the agent id the caller
     * named, not about the row: an operator registering an address that some
     * earlier anonymous visitor already watched would otherwise never take
     * ownership of their own agent, which was exactly the hole the audit found.
     */
    if (already) {
      const claimed = params.caller
        ? await claimAgent(db, { agentId: short(params.agentId), orgId: params.caller.orgId })
        : undefined;
      return {
        registered: true,
        ...(claimed ? { owned: claimed !== 'owned_by_another' } : {}),
      };
    }
    if (rows.length >= MAX_WATCHED) {
      return {
        registered: false,
        code: 'watch_limit',
        reason: `This deployment is already watching ${MAX_WATCHED} addresses, which is its ceiling`,
      };
    }
    const agentId = short(params.agentId);
    await watchSigner(db, {
      signer: params.signer,
      chainId: params.chainId,
      agentId,
      label: short(params.label),
      at: new Date(),
    });
    // Claimed on first registration by a signed-in caller. An anonymous
    // registration leaves the agent unowned and open, which is what the demo
    // relies on and what lets someone try this before signing in.
    const claimed = params.caller
      ? await claimAgent(db, { agentId, orgId: params.caller.orgId })
      : undefined;
    return { registered: true, ...(claimed ? { owned: claimed !== 'owned_by_another' } : {}) };
  };

  app.get('/api/watched', async (request) => {
    const rows = await activeSigners(db);
    const readable = await readableAgents(await callerOf(request));
    const visible = readable ? rows.filter((r) => readable.includes(r.agentId)) : rows;
    return {
      items: visible.map((row) => ({
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
      caller: await callerOf(request),
    });
    if (!result.registered) {
      const forbidden = result.code === 'forbidden';
      return reply
        .code(forbidden ? 403 : 429)
        .send({ error: result.code, detail: result.reason, requestId: request.id });
    }
    return reply.code(201).send({
      signer: signer.toLowerCase(),
      chainId,
      watching: true,
      // Present only for a signed-in caller: whether this agent is now theirs.
      ...(result.owned !== undefined ? { owned: result.owned } : {}),
    });
  });

  if (options.chaosPlan) {
    const chaosPlan = options.chaosPlan;

    /**
     * The catalogue, for a deployment that offers only wallet-signed chaos.
     *
     * Registered only when the harness itself is absent, so a process holding a
     * key still serves its own fuller version above. Without this, a visitor
     * could plan a scenario the API refused to list — which the audit caught.
     */
    if (!options.chaos) {
      app.get('/api/chaos/scenarios', async () => ({
        items: plannableScenarios(),
        signable: PLANNABLE_SCENARIOS,
        note: 'This deployment holds no key. You sign these with your own wallet.',
      }));
    }

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
          caller: await callerOf(request),
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

  app.delete('/api/watched/:signer', async (request, reply) => {
    const { signer } = request.params as { signer: string };
    const q = request.query as Record<string, string | undefined>;
    const chainId = Number(q['chainId'] ?? DEFAULT_CHAIN);
    const existing = (await activeSigners(db)).find(
      (r) => r.signer === signer.toLowerCase() && r.chainId === chainId,
    );
    if (existing && !(await mayAct(db, existing.agentId, await callerOf(request)))) {
      return reply.code(403).send({
        error: 'forbidden',
        detail: `Agent ${existing.agentId} belongs to another organisation.`,
        requestId: request.id,
      });
    }
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
  app.get('/api/stream', async (request, reply) => {
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

    /**
     * A live feed is still a read, and it was the one place scoping had no
     * effect: every subscriber received every incident as it happened,
     * whichever agent it belonged to.
     *
     * Resolved once, when the stream opens, rather than per event — a query
     * per subscriber per incident would turn a busy tick into a stampede. The
     * cost is that an agent claimed *during* a long-lived stream is not
     * included until the client reconnects, which a console does on every
     * navigation.
     */
    const readablePromise = readableAgents(await callerOf(request));

    const unsubscribe = bus.subscribe((event) => {
      void readablePromise.then((readable) => {
        const agentId = (event.data as { agentId?: unknown } | null)?.agentId;
        // An event that names no agent is infrastructure, not somebody's
        // failure, so it is not filtered by an agent it does not have.
        if (readable && typeof agentId === 'string' && !readable.includes(agentId)) return;
        send(event.type, event.data);
      });
    });
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
