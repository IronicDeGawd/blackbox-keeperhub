import { GoogleAuth } from 'google-auth-library';

/**
 * Gemini on Vertex AI, authenticated with Application Default Credentials.
 *
 * No API key anywhere: the token comes from whatever gcloud has already
 * authorised, which is one less secret in `.env.local` and one less thing to
 * leak. The trade is that the environment must be logged in — an unauthenticated
 * machine gets a clear error rather than a silent downgrade.
 *
 * Model availability was probed on 2026-08-10 against this project. Serving:
 * `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.5-flash`,
 * `gemini-2.5-flash-lite`, `gemini-2.5-flash`. Not serving: `gemini-3-flash`,
 * `gemini-3.1-flash`, `gemini-3-flash-lite`. The default is pinned to an
 * explicit version rather than the `-latest` alias, because the model id is
 * stored on every analysis as provenance and an alias that moves under you
 * makes two analyses claiming the same model incomparable. The 2.5 line is
 * scheduled for decommissioning in October.
 *
 * Two facts about this endpoint were established by probing it (2026-08-10):
 *
 * 1. Only the **global** endpoint answers. The regional host
 *    (`us-central1-aiplatform.googleapis.com` with `locations/us-central1`)
 *    returns an HTML 404 for these models — not a JSON error, an actual 404
 *    page, which is easy to mistake for a bad path.
 * 2. Flash models spend output tokens on thinking before they write
 *    anything. A request capped at 16 tokens came back `MAX_TOKENS` with a
 *    `content` object containing no `parts` at all and 13 thought tokens
 *    burned. A caller that assumes `parts[0].text` exists throws on a
 *    successful response, so the budget has to cover thinking as well as the
 *    answer, and the parse has to tolerate its absence.
 */

export type GenerateParams = {
  prompt: string;
  systemInstruction?: string;
  /** Enforced by the model, not just requested in the prompt. */
  responseSchema?: unknown;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type VertexOptions = {
  projectId: string;
  model?: string;
  /** Only `global` is known to serve these models; see above. */
  location?: string;
  fetchImpl?: typeof fetch;
  /** Injectable so tests never touch gcloud. */
  getAccessToken?: () => Promise<string>;
  timeoutMs?: number;
};

export class VertexError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VertexError';
  }
}

export class VertexGemini {
  private readonly model: string;
  private readonly location: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private auth: GoogleAuth | undefined;

  constructor(private readonly options: VertexOptions) {
    this.model = options.model ?? 'gemini-3.5-flash-lite';
    this.location = options.location ?? 'global';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get modelId(): string {
    return this.model;
  }

  private async token(): Promise<string> {
    if (this.options.getAccessToken) return this.options.getAccessToken();
    this.auth ??= new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const token = await this.auth.getAccessToken();
    if (!token) {
      throw new VertexError(
        'No Application Default Credentials available. Run `gcloud auth application-default login`.',
        401,
        false,
      );
    }
    return token;
  }

  private get url(): string {
    const host =
      this.location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${this.location}-aiplatform.googleapis.com`;
    return (
      `${host}/v1/projects/${this.options.projectId}/locations/${this.location}` +
      `/publishers/google/models/${this.model}:generateContent`
    );
  }

  async generate(params: GenerateParams): Promise<string> {
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
      generationConfig: {
        // Generous, because thinking tokens come out of this budget.
        maxOutputTokens: params.maxOutputTokens ?? 2048,
        temperature: params.temperature ?? 0.2,
        ...(params.responseSchema
          ? { responseMimeType: 'application/json', responseSchema: params.responseSchema }
          : {}),
      },
      ...(params.systemInstruction
        ? { systemInstruction: { parts: [{ text: params.systemInstruction }] } }
        : {}),
    };

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: params.signal ?? timeout,
    });

    const text = await res.text();
    if (!res.ok) {
      // 429 is routine here: the project runs on shared on-demand quota with no
      // provisioned throughput, so bursts get refused. It is a reason to fall
      // back, never a reason to fail the incident.
      throw new VertexError(
        `Vertex ${this.model} returned ${res.status}: ${text.slice(0, 300)}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new VertexError(`Vertex returned a non-JSON body: ${text.slice(0, 200)}`, 200, true);
    }

    const candidate = (parsed as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] })
      .candidates?.[0];
    const answer = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!answer) {
      throw new VertexError(
        `Vertex produced no text (finishReason ${candidate?.finishReason ?? 'unknown'}). ` +
          'A MAX_TOKENS finish with no parts means the budget was consumed by thinking.',
        200,
        true,
      );
    }
    return answer;
  }
}
