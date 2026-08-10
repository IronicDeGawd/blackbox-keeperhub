import { rcaLlmOutputSchema, type Incident, type RootCauseAnalysis } from '@blackbox/core';
import { templateRca } from './templates.js';
import { buildPrompt, RCA_RESPONSE_SCHEMA, SYSTEM_INSTRUCTION, PROMPT_VERSION } from './prompt.js';

/**
 * Explains an incident.
 *
 * The model writes the narrative; the rules decide what happened. That split is
 * deliberate — classification stays deterministic and auditable, and the LLM is
 * confined to prose over facts it was handed. It is never asked *whether* this
 * is a nonce gap, only to explain the nonce gap the detector already proved.
 *
 * It cannot fail. Every path that does not produce validated model output falls
 * back to the template, so an incident always carries an explanation. The
 * result says which one it is: `model` is the model id, or the literal string
 * `template`.
 */

export type LlmClient = {
  modelId: string;
  generate(params: {
    prompt: string;
    systemInstruction?: string;
    responseSchema?: unknown;
    maxOutputTokens?: number;
  }): Promise<string>;
};

export type DiagnosticianOptions = {
  /** Absent means template-only, which is a supported way to run. */
  llm?: LlmClient;
  now?: () => Date;
  /** One retry is worth it for a rate limit; more is just latency. */
  attempts?: number;
  logger?: { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
};

export type DiagnosisResult = {
  rca: RootCauseAnalysis;
  /** How the analysis was produced, for the UI's provenance label. */
  source: 'model' | 'template';
  /** Why the model was not used, when it was not. Shown to operators. */
  fallbackReason?: string;
};

export class Diagnostician {
  private readonly now: () => Date;

  constructor(private readonly options: DiagnosticianOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async diagnose(incident: Incident): Promise<DiagnosisResult> {
    const { llm } = this.options;
    if (!llm) {
      return {
        rca: templateRca(incident, this.now(), PROMPT_VERSION),
        source: 'template',
        fallbackReason: 'no model configured',
      };
    }

    const attempts = this.options.attempts ?? 2;
    let lastError = '';

    for (let i = 0; i < attempts; i++) {
      try {
        const raw = await llm.generate({
          prompt: buildPrompt(incident),
          systemInstruction: SYSTEM_INSTRUCTION,
          responseSchema: RCA_RESPONSE_SCHEMA,
          maxOutputTokens: 2048,
        });

        // Validated, not trusted. A model that returns plausible prose in the
        // wrong shape must not reach the UI as a half-populated panel.
        const parsed = rcaLlmOutputSchema.safeParse(extractJson(raw));
        if (!parsed.success) {
          lastError = `model output failed validation: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')}`;
          continue;
        }

        const weak = weakRecommendation(parsed.data.recommendation);
        if (weak) {
          // The instruction not to write these is in the system prompt and in
          // the schema description, and the model wrote one anyway on the first
          // live run. Asking is not enforcement. A retry usually fixes it; the
          // template is better than shipping "implement a mechanism to monitor".
          lastError = `recommendation was not actionable: ${weak}`;
          continue;
        }

        return {
          rca: {
            ...parsed.data,
            model: llm.modelId,
            generatedAt: this.now(),
            promptVersion: PROMPT_VERSION,
          },
          source: 'model',
        };
      } catch (error) {
        lastError = (error as Error).message;
        this.options.logger?.error('diagnosis attempt failed', {
          incidentId: incident.id,
          attempt: i,
          error,
        });
      }
    }

    return {
      rca: templateRca(incident, this.now(), PROMPT_VERSION),
      source: 'template',
      fallbackReason: lastError || 'model produced no usable output',
    };
  }
}

/**
 * Pull the JSON object out of a model response.
 *
 * The response schema makes clean JSON the norm, but a model that ignores it
 * and wraps the object in a fenced code block should not cost an incident its
 * explanation.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

/**
 * Reject a recommendation that restates the problem as a wish.
 *
 * "Implement a mechanism to detect X" tells an on-call engineer nothing they
 * did not already know from the incident class. The template's version always
 * names a specific change, so falling back is a genuine improvement rather than
 * a degradation.
 */
export function weakRecommendation(recommendation: string): string | null {
  const patterns: [RegExp, string][] = [
    [/implement (a |an |some )?(mechanism|system|process|solution|logic)/i, 'names no specific change'],
    [/^\s*(add|set up|introduce) (monitoring|alerting|observability)/i, 'asks for monitoring rather than a fix'],
    [/\b(consider|you (may|might|could) want to)\b/i, 'hedges instead of recommending'],
    [/\bensure that\b.*\bproperly\b/i, 'is a platitude'],
  ];
  for (const [pattern, why] of patterns) {
    if (pattern.test(recommendation)) return why;
  }
  return null;
}
