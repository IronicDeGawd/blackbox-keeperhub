import { keeperHubExecutionSchema, type KeeperHubExecution } from './types.js';

export type SignMessage = (message: string) => Promise<string>;

/** `/execute/contract-call` answers with a value for reads and a record for writes. */
export type ContractCallResult =
  | { kind: 'read'; result: unknown }
  | { kind: 'execution'; execution: KeeperHubExecution };

export type KeeperHubClientOptions = {
  baseUrl?: string;
  /** `kh_` organisation key. The `wfb_` webhook key will NOT work for execution. */
  orgKey?: string;
  /** Session cookie from `login()`. Needed for dashboard-scoped endpoints. */
  cookie?: string;
  fetchImpl?: typeof fetch;
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

  constructor(options: KeeperHubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.orgKey = options.orgKey;
    this.cookie = options.cookie;
    this.fetchImpl = options.fetchImpl ?? fetch;
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

  private async request<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: this.headers(),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
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
  }): Promise<KeeperHubExecution> {
    return this.execute('/execute/transfer', params);
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
  }): Promise<ContractCallResult> {
    const res = await this.request<Record<string, unknown>>('/execute/contract-call', {
      method: 'POST',
      body: params,
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
  ): Promise<KeeperHubExecution> {
    const res = await this.request<Record<string, unknown>>(path, { method: 'POST', body: params });
    // A reverting call is a legitimate result, not a transport error: it comes
    // back 200 with status "failed" and a decoded reason. Only a genuine
    // transport or auth failure should throw.
    if (res.status >= 400 && !isExecutionShaped(res.body)) {
      throw new KeeperHubError(`Execution at ${path} failed`, res.status, res.body);
    }
    return this.parseExecution(res.body);
  }

  async getExecutionStatus(executionId: string): Promise<KeeperHubExecution> {
    const res = await this.request<unknown>(`/execute/${executionId}/status`);
    if (res.status !== 200) {
      throw new KeeperHubError('getExecutionStatus failed', res.status, res.body);
    }
    return this.parseExecution(res.body);
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
