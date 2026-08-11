/**
 * Typed access to the Blackbox API for the MCP tools.
 *
 * The MCP server is deliberately a thin adapter over the same REST API the
 * console uses, rather than a second implementation reaching into the database.
 * One place decides what an incident is and when remediation is allowed, and an
 * agent asking through MCP gets exactly the answers a human sees in the
 * console — including the same refusals.
 */

export class BlackboxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'BlackboxApiError';
  }
}

export type BlackboxClientOptions = {
  baseUrl?: string;
  /**
   * A Blackbox session token, for the tools that do more than read.
   *
   * Reading needs no account, so this is optional and most agents will never
   * set it. Watching an address or requesting a remediation needs the account
   * that owns the agent, and without a token those tools can only be refused —
   * so an agent expected to act must be given one, exactly as a person signing
   * in to the console is.
   */
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class BlackboxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly token: string | undefined;

  constructor(options: BlackboxClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:4000').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.token = options.token && options.token.trim() !== '' ? options.token.trim() : undefined;
  }

  /** Whether this client can do anything beyond reading. */
  get authenticated(): boolean {
    return this.token !== undefined;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (res.status >= 400) {
      const detail =
        typeof body === 'object' && body !== null && 'detail' in body
          ? String((body as { detail?: unknown }).detail)
          : `${res.status}`;
      throw new BlackboxApiError(detail, res.status, body);
    }
    return body as T;
  }

  listIncidents(params: Record<string, string | number | undefined>): Promise<{
    items: Record<string, unknown>[];
    total: number;
  }> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    const suffix = query.toString();
    return this.request(`/api/incidents${suffix ? `?${suffix}` : ''}`);
  }

  getIncident(id: string): Promise<Record<string, unknown>> {
    return this.request(`/api/incidents/${encodeURIComponent(id)}`);
  }

  diagnose(params: { txHash: string; chainId?: number }): Promise<Record<string, unknown>> {
    return this.request('/api/diagnose', { method: 'POST', body: params });
  }

  signerHealth(params: { signer: string; chainId?: number }): Promise<Record<string, unknown>> {
    const query = params.chainId ? `?chainId=${params.chainId}` : '';
    return this.request(`/api/signers/${encodeURIComponent(params.signer)}/health${query}`);
  }

  remediationPlan(incidentId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/incidents/${encodeURIComponent(incidentId)}/remediation-plan`);
  }

  remediate(incidentId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/incidents/${encodeURIComponent(incidentId)}/remediate`, {
      method: 'POST',
      body: {},
    });
  }

  watchAddress(params: {
    signer: string;
    chainId?: number;
    agentId?: string;
    label?: string;
  }): Promise<Record<string, unknown>> {
    return this.request('/api/watched', { method: 'POST', body: params });
  }

  config(): Promise<Record<string, unknown>> {
    return this.request('/api/config');
  }
}
