import type {
  AppConfig,
  ChaosContext,
  ChaosRun,
  DiagnoseResult,
  IncidentDetail,
  IncidentList,
  IncidentSummary,
  RemediateResponse,
  RemediationPlan,
  RemediationTxResult,
  Stats,
  WatchedAddress,
} from './types';

/**
 * The API client.
 *
 * Errors arrive as `{ error, detail, requestId }` and the `detail` line is
 * written to be shown to a person — "that transaction was sent by 0x…, but this
 * incident is about 0x…". ApiError carries it through so the UI can render it
 * verbatim instead of substituting something vaguer.
 *
 * A 404 is meaningful rather than exceptional: routes this process cannot serve
 * genuinely do not exist on it, which is why controls are gated on
 * `config.capabilities` before they are ever clicked.
 */

export const API_URL: string =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:4001';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly requestId: string | null;
  /** The parsed body, for responses that carry more than the envelope. */
  readonly body: unknown;

  constructor(status: number, code: string, detail: string, requestId: string | null, body: unknown) {
    super(detail || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.requestId = requestId;
    this.body = body;
  }
}

type Envelope = { error?: string; detail?: string; requestId?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    // A dead server and a refused connection look the same to fetch; say so
    // plainly rather than surfacing "Failed to fetch".
    throw new ApiError(
      0,
      'unreachable',
      `Could not reach the Blackbox API at ${API_URL}. Is it running?`,
      null,
      cause,
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const envelope = (body ?? {}) as Envelope;
    throw new ApiError(
      response.status,
      envelope.error ?? `http_${response.status}`,
      envelope.detail ?? `${response.status} ${response.statusText}`,
      envelope.requestId ?? null,
      body,
    );
  }

  return body as T;
}

export type IncidentFilters = {
  status?: string;
  class?: string;
  severity?: string;
  agentId?: string;
  signer?: string;
  chainId?: number;
  limit?: number;
};

function query(filters: IncidentFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const api = {
  config: (init?: RequestInit): Promise<AppConfig> => request<AppConfig>('/api/config', init),

  stats: (init?: RequestInit): Promise<Stats> => request<Stats>('/api/stats', init),

  incidents: (filters: IncidentFilters = {}, init?: RequestInit): Promise<IncidentList> =>
    request<IncidentList>(`/api/incidents${query(filters)}`, init),

  incident: (id: string, init?: RequestInit): Promise<IncidentDetail> =>
    request<IncidentDetail>(`/api/incidents/${encodeURIComponent(id)}`, init),

  acknowledge: (id: string): Promise<IncidentSummary> =>
    request<IncidentSummary>(`/api/incidents/${encodeURIComponent(id)}/acknowledge`, {
      method: 'POST',
    }),

  /** 202 accepted or 200 with guardsFailed. Both resolve; neither throws. */
  remediate: (id: string): Promise<RemediateResponse> =>
    request<RemediateResponse>(`/api/incidents/${encodeURIComponent(id)}/remediate`, {
      method: 'POST',
      body: '{}',
    }),

  remediationPlan: (id: string, init?: RequestInit): Promise<RemediationPlan> =>
    request<RemediationPlan>(`/api/incidents/${encodeURIComponent(id)}/remediation-plan`, init),

  /** Rejected with 422 when the sender or nonce does not match the plan. */
  submitRemediationTx: (id: string, txHash: string): Promise<RemediationTxResult> =>
    request<RemediationTxResult>(`/api/incidents/${encodeURIComponent(id)}/remediation-tx`, {
      method: 'POST',
      body: JSON.stringify({ txHash }),
    }),

  watched: (init?: RequestInit): Promise<{ items: WatchedAddress[] }> =>
    request<{ items: WatchedAddress[] }>('/api/watched', init),

  /** 400 invalid_address or 400 unsupported_chain, both with a readable detail. */
  watch: (body: {
    signer: string;
    chainId: number;
    label?: string;
    agentId?: string;
  }): Promise<{ signer: string; chainId: number; watching: boolean }> =>
    request('/api/watched', { method: 'POST', body: JSON.stringify(body) }),

  /** Stops discovery. Incidents already found are not removed. */
  unwatch: (signer: string, chainId: number): Promise<{ watching: boolean }> =>
    request(`/api/watched/${encodeURIComponent(signer)}?chainId=${chainId}`, {
      method: 'DELETE',
    }),

  diagnose: (txHash: string, chainId?: number): Promise<DiagnoseResult> =>
    request<DiagnoseResult>('/api/diagnose', {
      method: 'POST',
      body: JSON.stringify(chainId === undefined ? { txHash } : { txHash, chainId }),
    }),

  chaosScenarios: (init?: RequestInit): Promise<ChaosContext> =>
    request<ChaosContext>('/api/chaos/scenarios', init),

  /** 409 with the scenario's note as the detail when it cannot run. */
  chaosRun: (scenario: string): Promise<ChaosRun> =>
    request<ChaosRun>('/api/chaos/run', {
      method: 'POST',
      body: JSON.stringify({ scenario }),
    }),
};

export const streamUrl = (): string => `${API_URL}/api/stream`;
