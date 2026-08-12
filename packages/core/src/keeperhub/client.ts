import {
  keeperHubExecutionSchema,
  keeperHubRunPageSchema,
  type KeeperHubExecution,
  type KeeperHubRunPage,
  type KeeperHubRunStatus,
} from './types.js';
import { MAX_RETRY_WAIT_MS, rateLimitRemaining, retryAfterMs } from './rate-limit.js';

export type SignMessage = (message: string) => Promise<string>;

/** `/execute/contract-call` answers with a value for reads and a record for writes. */
export type ContractCallResult =
  | { kind: 'read'; result: unknown }
  | { kind: 'execution'; execution: KeeperHubExecution };

export type KeeperHubClientOptions = {
  baseUrl?: string;
  /** `kh_` organisation key. The `wfb_` webhook key will NOT work for execution. */
  orgKey?: string;
  /**
   * An OAuth access token, for reading on behalf of an operator who connected
   * their account. Sent as a bearer token exactly like an organisation key, but
   * named apart because it is a different thing: scoped to reading, short
   * lived, and belonging to somebody else.
   */
  accessToken?: string;
  /** Session cookie from `login()`. Needed for dashboard-scoped endpoints. */
  cookie?: string;
  fetchImpl?: typeof fetch;
  /**
   * How a rate-limited request waits. Injected so a test can prove the delay
   * without spending it.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
  /**
   * How many times a rate-limited request may come back. Two is enough to ride
   * out a window boundary and few enough that a sweep still ends.
   */
  maxRateLimitRetries?: number;
  /**
   * Somewhere to say that a request was throttled.
   *
   * All three levels are accepted because callers already hold loggers of
   * different shapes — the sweeper's has `info` and `error` and no `warn` —
   * and a type with only an optional `warn` would reject every one of them.
   */
  logger?: {
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    info?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
};

export class KeeperHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'KeeperHubError';
  }
}

const DEFAULT_BASE_URL = 'https://app.keeperhub.com/api';

export class KeeperHubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private orgKey: string | undefined;
  private cookie: string | undefined;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;
  private readonly maxRateLimitRetries: number;
  private readonly logger: KeeperHubClientOptions['logger'];

  constructor(options: KeeperHubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.orgKey = options.orgKey ?? options.accessToken;
    this.cookie = options.cookie;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl =
      options.sleepImpl ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.nowImpl = options.nowImpl ?? (() => Date.now());
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 2;
    this.logger = options.logger;
  }

  private get origin(): string {
    return new URL(this.baseUrl).origin;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      // Mutations without an Origin are rejected with `Invalid origin`.
      Origin: this.origin,
      Referer: `${this.origin}/`,
      ...extra,
    };
    if (this.orgKey) h['Authorization'] = `Bearer ${this.orgKey}`;
    if (this.cookie) h['Cookie'] = this.cookie;
    return h;
  }

  /**
   * Whether this call can safely be sent twice.
   *
   * A read always can. A write only can when it carries an idempotency key,
   * which is what makes the second send collapse onto the first rather than
   * execute again. Without one, a retry after a rate limit could pay twice —
   * so a rate-limited write is reported instead, and the caller decides.
   */
  private static repeatable(init: { method?: string; idempotencyKey?: string }): boolean {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return true;
    return init.idempotencyKey !== undefined;
  }

  private async request<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
    attempt = 0,
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: this.headers(
        init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {},
      ),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    /**
     * Rate limited, and told when to come back.
     *
     * Blackbox reads other people's organisations on a tick, so this is
     * somebody else's quota being spent. Honouring the header is the
     * difference between a sweep that pauses and one that gets the credential
     * throttled. A wait longer than the cap is refused rather than slept
     * through: the next tick will try anyway, and a sweep that stalls for
     * minutes holds up everything behind it.
     */
    if (res.status === 429 && attempt < this.maxRateLimitRetries) {
      const wait = retryAfterMs(res.headers, this.nowImpl());
      if (wait !== null && wait <= MAX_RETRY_WAIT_MS && KeeperHubClient.repeatable(init)) {
        // Drained so the connection is released before the wait.
        await res.text();
        // warn where there is one, otherwise info: being throttled is worth
        // recording even by a logger that has no warning level.
        (this.logger?.warn ?? this.logger?.info)?.('keeperhub rate limited, waiting as asked', {
          path,
          waitMs: wait,
          attempt: attempt + 1,
          remaining: rateLimitRemaining(res.headers),
        });
        await this.sleepImpl(wait);
        return this.request<T>(path, init, attempt + 1);
      }
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body: body as T, headers: res.headers };
  }

  /**
   * Sign in with Ethereum (EIP-4361). KeeperHub runs better-auth, and this
   * works headlessly — no browser and no wallet extension, which the app's own
   * wallet button requires.
   *
   * Signing in with an address that is not already linked creates a NEW user
   * and organisation rather than joining an existing one.
   */
  async login(params: {
    address: `0x${string}`;
    signMessage: SignMessage;
    chainId?: number;
    statement?: string;
    issuedAt?: Date;
  }): Promise<{ cookie: string; token: string; user: unknown }> {
    const chainId = params.chainId ?? 1;
    const nonceRes = await this.request<{ nonce?: string }>('/auth/siwe/nonce', {
      method: 'POST',
      body: { walletAddress: params.address, chainId },
    });
    const nonce = nonceRes.body?.nonce;
    if (!nonce) {
      throw new KeeperHubError('SIWE nonce request failed', nonceRes.status, nonceRes.body);
    }

    const message = [
      `${new URL(this.origin).host} wants you to sign in with your Ethereum account:`,
      params.address,
      '',
      params.statement ?? 'Sign in with Ethereum to KeeperHub.',
      '',
      `URI: ${this.origin}`,
      'Version: 1',
      `Chain ID: ${chainId}`,
      `Nonce: ${nonce}`,
      `Issued At: ${(params.issuedAt ?? new Date()).toISOString()}`,
    ].join('\n');

    const signature = await params.signMessage(message);
    const verify = await this.request<{ token?: string; user?: unknown }>('/auth/siwe/verify', {
      method: 'POST',
      body: { message, signature, walletAddress: params.address, chainId },
    });
    if (verify.status !== 200 || !verify.body?.token) {
      throw new KeeperHubError('SIWE verification failed', verify.status, verify.body);
    }

    const cookie = (verify.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0])
      .filter(Boolean)
      .join('; ');
    if (!cookie) throw new KeeperHubError('No session cookie returned', verify.status, verify.body);

    this.cookie = cookie;
    return { cookie, token: verify.body.token, user: verify.body.user };
  }

  /**
   * Call an endpoint that may demand a step-up wallet signature.
   *
   * A protected endpoint answers with a challenge; signing it and resubmitting
   * completes the action. Every request mints a fresh nonce that supersedes the
   * previous one, so the retry must be the very next call to that endpoint —
   * anything in between invalidates the challenge being held and eventually
   * trips a rate limiter that returns no `Retry-After`.
   */
  async signedRequest<T = unknown>(
    path: string,
    body: Record<string, unknown>,
    signMessage: SignMessage,
    method = 'POST',
  ): Promise<T> {
    const first = await this.request<{ code?: string; challenge?: string }>(path, {
      method,
      body,
    });
    if (first.status < 400) return first.body as T;
    if (first.body?.code !== 'signature_required' || !first.body.challenge) {
      throw new KeeperHubError(`Request to ${path} failed`, first.status, first.body);
    }

    const challenge = first.body.challenge;
    const signature = await signMessage(challenge);
    // The challenge is multi-line, so it cannot be carried in a header.
    const second = await this.request<T>(path, {
      method,
      body: { ...body, signature, challenge },
    });
    if (second.status >= 400) {
      throw new KeeperHubError(`Signed request to ${path} failed`, second.status, second.body);
    }
    return second.body;
  }

  /** Mint an organisation (`kh_`) key — the only type Direct Execution accepts. */
  async createOrgKey(
    name: string,
    signMessage: SignMessage,
  ): Promise<{ id: string; name: string; keyPrefix: string; key: string }> {
    return this.signedRequest('/keys', { name }, signMessage);
  }

  /** Mint a webhook (`wfb_`) key. Cannot execute; useful only for triggers. */
  async createWebhookKey(
    name: string,
    signMessage: SignMessage,
  ): Promise<{ id: string; name: string; keyPrefix: string; key: string }> {
    return this.signedRequest('/api-keys', { name }, signMessage);
  }

  useOrgKey(key: string): void {
    this.orgKey = key;
  }

  /**
   * Who this credential belongs to, and the address they execute as.
   *
   * A run record carries no address — KeeperHub submits from a shared relayer
   * into the organisation's smart account — so for an operator who connected
   * their own account this is where the signer comes from. Asking them to type
   * it in would be asking them to know something we can look up.
   */
  async getUser(): Promise<{ id: string; walletAddress: `0x${string}` | null }> {
    const res = await this.request<{ id?: string; walletAddress?: string }>('/user');
    if (res.status !== 200) throw new KeeperHubError('getUser failed', res.status, res.body);
    const address = res.body?.walletAddress;
    return {
      id: String(res.body?.id ?? ''),
      walletAddress: /^0x[0-9a-fA-F]{40}$/.test(String(address))
        ? (String(address).toLowerCase() as `0x${string}`)
        : null,
    };
  }

  async listChains(): Promise<unknown[]> {
    const res = await this.request<unknown[]>('/chains');
    if (res.status !== 200) throw new KeeperHubError('listChains failed', res.status, res.body);
    return res.body;
  }

  async transfer(params: {
    network: string;
    recipientAddress: string;
    amount: string;
    tokenAddress?: string;
    gasLimitMultiplier?: string;
    /**
     * Safe to retry with. Must identify the work rather than the attempt, so a
     * reconstructed retry sends the same key and replays instead of spending
     * twice. Replay lasts 24 hours.
     */
    idempotencyKey?: string;
  }): Promise<KeeperHubExecution> {
    const { idempotencyKey, ...body } = params;
    return this.execute('/execute/transfer', body, idempotencyKey);
  }

  /**
   * Pre-flight a write without signing or sending anything.
   *
   * The documented sequence is simulate, check, then execute with the same
   * body — it catches bad addresses, ABI mistakes, insufficient balance and
   * reverts before any gas is spent. A simulation that would revert answers
   * HTTP 400 with `wouldRevert: true`, which is a result rather than an error.
   */
  async simulate(
    path: '/execute/transfer' | '/execute/contract-call',
    params: Record<string, unknown>,
  ): Promise<{ success: boolean; wouldRevert: boolean; detail?: string }> {
    const res = await this.request<Record<string, unknown>>(path, {
      method: 'POST',
      body: { ...params, simulate: true },
    });
    const body = res.body ?? {};
    // The reason is on `revertReason` for a simulated revert; `error` carries a
    // transport or validation failure. Either is worth passing on verbatim.
    const detail =
      typeof body['revertReason'] === 'string'
        ? body['revertReason']
        : typeof body['error'] === 'string'
          ? body['error']
          : undefined;
    return {
      success: body['success'] === true,
      wouldRevert: body['wouldRevert'] === true,
      ...(detail ? { detail } : {}),
    };
  }

  /**
   * `/execute/contract-call` serves two different response shapes. A read
   * function returns its value immediately as `{ result }` with no execution
   * record at all; a write returns the full execution record. The endpoint does
   * not distinguish them in the request, so the result is a tagged union rather
   * than a shape the caller has to guess at.
   */
  async contractCall(params: {
    network: string;
    contractAddress: string;
    functionName: string;
    /** JSON array encoded as a string, per the API. */
    functionArgs: string;
    abi?: string;
    value?: string;
    gasLimitMultiplier?: string;
    idempotencyKey?: string;
  }): Promise<ContractCallResult> {
    const { idempotencyKey, ...body } = params;
    const res = await this.request<Record<string, unknown>>('/execute/contract-call', {
      method: 'POST',
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (res.status >= 400 && !isExecutionShaped(res.body)) {
      throw new KeeperHubError('Execution at /execute/contract-call failed', res.status, res.body);
    }
    if (!isExecutionShaped(res.body)) {
      return { kind: 'read', result: (res.body as { result?: unknown })?.result ?? null };
    }
    return { kind: 'execution', execution: this.parseExecution(res.body) };
  }

  /** Convenience for read functions; throws if the call turned out to be a write. */
  async readContract(params: Parameters<KeeperHubClient['contractCall']>[0]): Promise<unknown> {
    const res = await this.contractCall(params);
    if (res.kind !== 'read') {
      throw new KeeperHubError(
        `Expected a read call but ${params.functionName} submitted a transaction`,
        200,
        res.execution,
      );
    }
    return res.result;
  }

  /** Convenience for write functions; throws if the call turned out to be a read. */
  async writeContract(
    params: Parameters<KeeperHubClient['contractCall']>[0],
  ): Promise<KeeperHubExecution> {
    const res = await this.contractCall(params);
    if (res.kind !== 'execution') {
      throw new KeeperHubError(
        `Expected a write call but ${params.functionName} returned a value without executing`,
        200,
        res.result,
      );
    }
    return res.execution;
  }

  private async execute(
    path: string,
    params: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<KeeperHubExecution> {
    const res = await this.request<Record<string, unknown>>(path, {
      method: 'POST',
      body: params,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    // A reverting call is a legitimate result, not a transport error: it comes
    // back 200 with status "failed" and a decoded reason. Only a genuine
    // transport or auth failure should throw.
    if (res.status >= 400 && !isExecutionShaped(res.body)) {
      throw new KeeperHubError(`Execution at ${path} failed`, res.status, res.body);
    }
    return this.parseExecution(res.body);
  }

  // --- workflows ------------------------------------------------------------
  // Routes per docs.keeperhub.com/api/workflows: creation is
  // `POST /api/workflows/create` and updates are `PATCH /api/workflows/{id}`.

  async listWorkflows(): Promise<{ id: string; name: string; enabled?: boolean }[]> {
    const res = await this.request<{ id: string; name: string; enabled?: boolean }[]>('/workflows');
    if (res.status !== 200) throw new KeeperHubError('listWorkflows failed', res.status, res.body);
    return res.body ?? [];
  }

  async createWorkflow(definition: {
    name: string;
    description?: string;
    nodes: unknown[];
    edges: unknown[];
    /** Accepted on create, so a workflow can go live in one round trip. */
    enabled?: boolean;
  }): Promise<{ id: string }> {
    const res = await this.request<{ id: string }>('/workflows/create', {
      method: 'POST',
      body: definition,
    });
    if (res.status >= 400) {
      throw new KeeperHubError('createWorkflow failed', res.status, res.body);
    }
    return res.body;
  }

  /** Update nodes, edges or `enabled`. The only route that actually persists them. */
  async patchWorkflow(id: string, definition: Record<string, unknown>): Promise<void> {
    const res = await this.request(`/workflows/${id}`, { method: 'PATCH', body: definition });
    if (res.status >= 400) {
      throw new KeeperHubError('patchWorkflow failed', res.status, res.body);
    }
  }

  async executeWorkflow(
    id: string,
    input: Record<string, unknown> = {},
  ): Promise<{ executionId: string; status: string }> {
    const res = await this.request<{ executionId: string; status: string }>(
      `/workflows/${id}/execute`,
      { method: 'POST', body: { input } },
    );
    if (res.status >= 400 || !res.body?.executionId) {
      throw new KeeperHubError('executeWorkflow failed', res.status, res.body);
    }
    return res.body;
  }

  /**
   * Per-node results for one workflow run.
   *
   * This is where a transaction hash appears — the execute call answers only
   * with an id and `running`, so a caller that needs the hash has to come back
   * here for it.
   */
  async getWorkflowExecution(executionId: string): Promise<{
    status: string;
    error: string | null;
    logs: {
      nodeId: string;
      nodeType: string;
      status: string;
      output?: { transactionHash?: string; gasUsed?: string; sponsored?: boolean } | null;
    }[];
  }> {
    const res = await this.request<{
      execution: { status: string; error: string | null };
      logs?: unknown[];
    }>(`/workflows/executions/${executionId}/logs`);
    if (res.status !== 200) {
      throw new KeeperHubError('getWorkflowExecution failed', res.status, res.body);
    }
    return {
      status: res.body.execution.status,
      error: res.body.execution.error,
      logs: (res.body.logs ?? []) as never[],
    };
  }

  /**
   * List runs for the organisation — workflow and direct alike.
   *
   * The only listing endpoint KeeperHub has. `/api/executions` does not exist
   * (it answers 404), and `/execute/{id}/status` needs an id you already know,
   * so this is what turns Blackbox from a submitter that watches its own calls
   * into a monitor that sees everything an org ran.
   *
   * `range` defaults to 24h *on the server*, so it is passed explicitly here:
   * omitting it silently hides anything older than a day, which looks exactly
   * like an org with no activity.
   */
  async listRuns(
    params: {
      cursor?: string;
      limit?: number;
      status?: KeeperHubRunStatus;
      source?: 'workflow' | 'direct';
      /** `1h` | `24h` | `7d` | `30d`. Anything else is ignored by the server. */
      range?: string;
    } = {},
  ): Promise<KeeperHubRunPage> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.status) query.set('status', params.status);
    if (params.source) query.set('source', params.source);
    query.set('range', params.range ?? '7d');

    const res = await this.request<unknown>(`/analytics/runs?${query.toString()}`);
    if (res.status !== 200) throw new KeeperHubError('listRuns failed', res.status, res.body);
    const parsed = keeperHubRunPageSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new KeeperHubError(
        `Unrecognised runs page: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        200,
        res.body,
      );
    }
    return parsed.data;
  }

  /**
   * Read a value, test it, and act only if the test holds — all on their side.
   *
   * The difference from doing the same three steps here is atomicity of intent:
   * our guards run in this process a block or more before the transaction
   * lands, so the state they checked can move underneath them. This one checks
   * and acts in the same call, which is what a circuit breaker actually needs.
   *
   * `functionArgs` is a JSON array encoded as a string on both the check and
   * the action, per their API.
   */
  async checkAndExecute(params: {
    contractAddress: string;
    chainId: string;
    functionName: string;
    functionArgs: string;
    abi?: string;
    condition: { operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; value: string };
    action: {
      contractAddress: string;
      functionName: string;
      functionArgs: string;
      abi?: string;
      gasLimitMultiplier?: string;
    };
    simulate?: boolean;
    idempotencyKey?: string;
  }): Promise<{ conditionMet: boolean; execution: KeeperHubExecution | null; raw: unknown }> {
    const { idempotencyKey, ...body } = params;
    const res = await this.request<Record<string, unknown>>('/execute/check-and-execute', {
      method: 'POST',
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (res.status >= 400 && !isExecutionShaped(res.body)) {
      throw new KeeperHubError('check-and-execute failed', res.status, res.body);
    }
    const body_ = res.body ?? {};
    /**
     * Their answer carries the verdict as `conditionResult.met`, alongside the
     * value it actually observed:
     *
     *   {"success":true,"status":"simulated","executed":false,
     *    "conditionResult":{"met":false,"observedValue":"true", …}}
     *
     * An earlier reading of this looked for a top-level `conditionMet`, which
     * never exists — so a condition that *held* would have been reported as
     * not held whenever no execution record came back, which is exactly what
     * happens in a simulation. A condition that did not hold is a result, not
     * a failure: nothing ran and nothing went wrong.
     */
    const verdict = body_['conditionResult'] as { met?: unknown } | undefined;
    const conditionMet =
      verdict?.met === true || (verdict === undefined && isExecutionShaped(body_));
    const observed = (verdict as { observedValue?: unknown } | undefined)?.observedValue;
    return {
      conditionMet,
      ...(typeof observed === 'string' ? { observedValue: observed } : {}),
      execution: isExecutionShaped(body_) ? this.parseExecution(body_) : null,
      raw: body_,
    };
  }

  /**
   * Run a published protocol action — Aave, Morpho, Compound and the rest.
   *
   * Lets a playbook express "repay this position" instead of assembling
   * calldata for a protocol we would otherwise have to encode ourselves and
   * keep correct as it upgrades.
   */
  async executeProtocolAction(
    actionType: string,
    params: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const [integration, slug] = actionType.split('/');
    if (!integration || !slug) {
      throw new KeeperHubError(
        `actionType must be "protocol/action-slug"; got "${actionType}"`,
        400,
        actionType,
      );
    }
    const res = await this.request<unknown>(`/execute/${integration}/${slug}`, {
      method: 'POST',
      body: params,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (res.status >= 400) {
      throw new KeeperHubError(`Protocol action ${actionType} failed`, res.status, res.body);
    }
    return res.body;
  }

  /** Discover protocol actions and the parameters each one needs. */
  async searchProtocolActions(protocol?: string): Promise<unknown> {
    const query = new URLSearchParams({ includeChains: 'false' });
    if (protocol) query.set('category', protocol);
    const res = await this.request<unknown>(`/mcp/schemas?${query.toString()}`);
    if (res.status !== 200) {
      throw new KeeperHubError('searchProtocolActions failed', res.status, res.body);
    }
    return res.body;
  }

  /**
   * Sign a payment and hold it, rather than broadcasting it.
   *
   * The only primitive here that acts *before* harm. Everything else Blackbox
   * does is compensation — pause it, replace it, fill the gap — and all of that
   * happens after the money moved. A held payment can simply be cancelled.
   */
  async tempoSignAndHold(params: Record<string, unknown>): Promise<unknown> {
    const res = await this.request<unknown>('/tempo/held-payments', {
      method: 'POST',
      body: params,
    });
    if (res.status >= 400) {
      throw new KeeperHubError('tempoSignAndHold failed', res.status, res.body);
    }
    return res.body;
  }

  async tempoCancelHold(paymentId: string): Promise<unknown> {
    const res = await this.request<unknown>(`/tempo/held-payments/${paymentId}/cancel`, {
      method: 'POST',
    });
    if (res.status >= 400) {
      throw new KeeperHubError('tempoCancelHold failed', res.status, res.body);
    }
    return res.body;
  }

  async tempoReleaseHold(paymentId: string): Promise<unknown> {
    const res = await this.request<unknown>(`/tempo/held-payments/${paymentId}/release`, {
      method: 'POST',
    });
    if (res.status >= 400) {
      throw new KeeperHubError('tempoReleaseHold failed', res.status, res.body);
    }
    return res.body;
  }

  /**
   * The organisation's plan, and whether it may still start a trial.
   *
   * Read because features are gated by it: the code action a trigger needs is
   * Pro-only, and finding that out at install time means offering a button that
   * fails. The trial terms come from here too, live rather than assumed.
   */
  async getSubscription(): Promise<{
    plan: string;
    status?: string;
    trial?: { eligible: boolean; days: number; tier: string };
  }> {
    const res = await this.request<Record<string, unknown>>('/billing/subscription');
    if (res.status !== 200) {
      throw new KeeperHubError('getSubscription failed', res.status, res.body);
    }
    const body = res.body ?? {};
    const sub = (body['subscription'] ?? {}) as { plan?: unknown; status?: unknown };
    const trial = body['trial'] as { eligible?: unknown; days?: unknown; tier?: unknown } | undefined;
    return {
      plan: typeof sub.plan === 'string' ? sub.plan : 'free',
      ...(typeof sub.status === 'string' ? { status: sub.status } : {}),
      ...(trial
        ? {
            trial: {
              eligible: trial.eligible === true,
              days: Number(trial.days ?? 0),
              tier: String(trial.tier ?? ''),
            },
          }
        : {}),
    };
  }

  /**
   * The organisation's daily execution budget and what it has spent today.
   *
   * `dailyCapWei` is null when no cap is configured. That is not a cap of zero
   * and must not be read as one — it means the organisation has no limit, and
   * an alert about reaching a limit that does not exist would be nonsense.
   */
  async getSpendingLimits(): Promise<{
    dailyCapWei: string | null;
    dailyUsedWei: string | null;
    dailySolanaCapLamports: string | null;
    dailySolanaUsedLamports: string | null;
  }> {
    const res = await this.request<Record<string, unknown>>('/analytics/spend-cap');
    if (res.status !== 200) {
      throw new KeeperHubError('getSpendingLimits failed', res.status, res.body);
    }
    const body = res.body ?? {};
    const str = (key: string): string | null =>
      typeof body[key] === 'string' ? (body[key] as string) : null;
    return {
      dailyCapWei: str('dailyCapWei'),
      dailyUsedWei: str('dailyUsedWei'),
      dailySolanaCapLamports: str('dailySolanaCapLamports'),
      dailySolanaUsedLamports: str('dailySolanaUsedLamports'),
    };
  }

  async getExecutionStatus(executionId: string): Promise<KeeperHubExecution> {
    return (await this.getExecutionStatusWithHint(executionId)).execution;
  }

  /**
   * Status, plus how long the server wants you to wait before asking again.
   *
   * `X-Poll-Interval-Hint` is in seconds and `0` means the execution is
   * terminal. Honouring it beats picking an interval: too fast wastes rate
   * limit, too slow makes every remediation look slower than it was.
   */
  async getExecutionStatusWithHint(
    executionId: string,
  ): Promise<{ execution: KeeperHubExecution; pollAfterMs: number | null }> {
    const res = await this.request<unknown>(`/execute/${executionId}/status`);
    if (res.status !== 200) {
      throw new KeeperHubError('getExecutionStatus failed', res.status, res.body);
    }
    const hint = res.headers.get('X-Poll-Interval-Hint');
    const seconds = hint === null ? null : Number(hint);
    return {
      execution: this.parseExecution(res.body),
      pollAfterMs:
        seconds === null || Number.isNaN(seconds) ? null : seconds === 0 ? 0 : seconds * 1000,
    };
  }

  /**
   * The transaction hash a caller can trust.
   *
   * `receipts` are re-fetched from the chain, so `verified` and `receiptStatus`
   * describe what actually happened; `transactionHash` on the record is
   * self-reported by the write path. Prefer a verified receipt, and fall back
   * only when there is none.
   */
  static verifiedHash(execution: KeeperHubExecution): string | null {
    const verified = (execution.receipts ?? []).find((r) => r.verified && r.hash);
    return verified?.hash ?? execution.transactionHash ?? null;
  }

  private parseExecution(body: unknown): KeeperHubExecution {
    const parsed = keeperHubExecutionSchema.safeParse(body);
    if (!parsed.success) {
      throw new KeeperHubError(
        `Unrecognised execution record: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        200,
        body,
      );
    }
    return parsed.data;
  }
}

function isExecutionShaped(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'executionId' in body;
}
