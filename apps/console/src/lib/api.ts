import { authHeader, setSession, type Session } from './session';
import type {
  AppConfig,
  ChaosContext,
  ChaosPlan,
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
      headers: {
        'content-type': 'application/json',
        // Sent when there is one. Reading needs no account, so most requests
        // carry nothing; acting needs the organisation that owns the agent.
        ...authHeader(),
        ...(init?.headers ?? {}),
      },
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

  // --- identity ------------------------------------------------------------

  /**
   * Where to send the operator to connect their KeeperHub account.
   *
   * `connect=1` asks for more than a sign-in: it asks Blackbox to keep a
   * read-only credential so it can watch the workflows they pick. The lifetime
   * is theirs to choose, and the API clamps it to its own range.
   */
  connectUrl: (params: { returnTo?: string; days?: number } = {}): Promise<{
    url: string;
    connect?: { days: number; min: number; max: number; scope: string };
  }> => {
    const query = new URLSearchParams({ connect: '1' });
    if (params.returnTo) query.set('returnTo', params.returnTo);
    if (params.days !== undefined) query.set('days', String(params.days));
    return request(`/api/auth/keeperhub/start?${query.toString()}`);
  },

  /**
   * Prove an address by signing a message, and get a session for it.
   *
   * The account for an agent that holds its own key and belongs to no
   * KeeperHub organisation — which is every visitor demoing with their own
   * wallet. Two calls: ask for something to sign, then hand back the
   * signature.
   */
  walletChallenge: (address: string): Promise<{ nonce: string; message: string }> =>
    request('/api/auth/wallet/challenge', {
      method: 'POST',
      body: JSON.stringify({ address }),
    }),

  walletVerify: async (nonce: string, signature: string): Promise<Session> => {
    const result = await request<{ token: string; orgId: string; address: string }>(
      '/api/auth/wallet/verify',
      { method: 'POST', body: JSON.stringify({ nonce, signature }) },
    );
    setSession(result);
    return result;
  },

  /** Sign in by pasting an organisation key. Suits a script; a person connects. */
  signInWithKey: async (orgKey: string): Promise<Session> => {
    const result = await request<{ token: string; orgId: string }>('/api/auth/keeperhub', {
      method: 'POST',
      body: JSON.stringify({ orgKey }),
    });
    setSession(result);
    return result;
  },

  session: (init?: RequestInit): Promise<{ orgId: string; agents: string[] }> =>
    request('/api/auth/session', init),

  signOut: async (): Promise<void> => {
    try {
      await request('/api/auth/signout', { method: 'POST' });
    } finally {
      // Forgotten locally whatever the server said: a token we keep after
      // asking for it to be revoked is worse than one we simply drop.
      setSession(null);
    }
  },

  // --- the public demo ------------------------------------------------------

  demoState: (init?: RequestInit): Promise<{
    available: boolean;
    cooldownSeconds: number;
    scope: string;
    nextAllowedAt: string;
    ready: boolean;
    spendsGas: boolean;
  }> => request('/api/demo', init),

  /** 202 with the runs it started, or 429 while it is cooling down. */
  runDemo: (): Promise<{ ran: boolean; executionIds: string[]; workflowId: string }> =>
    request('/api/demo/run', { method: 'POST' }),

  diagnose: (txHash: string, chainId?: number): Promise<DiagnoseResult> =>
    request<DiagnoseResult>('/api/diagnose', {
      method: 'POST',
      body: JSON.stringify(chainId === undefined ? { txHash } : { txHash, chainId }),
    }),

  chaosScenarios: (init?: RequestInit): Promise<ChaosContext> =>
    request<ChaosContext>('/api/chaos/scenarios', init),

  /** 409 with the scenario's note as the detail when it cannot run. */
  /** Plan a failure for the caller's own wallet to sign. Needs no key here. */
  chaosPlan: (params: {
    scenario: string;
    signer: string;
    chainId: number;
  }): Promise<ChaosPlan> =>
    request<ChaosPlan>('/api/chaos/plan', { method: 'POST', body: JSON.stringify(params) }),

  /**
   * Report the hashes the wallet produced.
   *
   * Not politeness: a nonce-gap transaction is queued rather than mined, so it
   * appears in no block and scanning can never find it. The wallet is the only
   * party that knows it exists.
   */
  chaosObserve: (params: {
    txHashes: string[];
    chainId: number;
    runId?: string;
  }): Promise<{ observed: { txHash: string }[]; ignored: { txHash: string; reason: string }[] }> =>
    request('/api/chaos/observe', { method: 'POST', body: JSON.stringify(params) }),

  chaosRun: (scenario: string): Promise<ChaosRun> =>
    request<ChaosRun>('/api/chaos/run', {
      method: 'POST',
      body: JSON.stringify({ scenario }),
    }),
};

export const streamUrl = (): string => `${API_URL}/api/stream`;
