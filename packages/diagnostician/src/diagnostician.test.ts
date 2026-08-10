import { describe, expect, it, vi } from 'vitest';
import { CHAIN_IDS, rootCauseAnalysisSchema, type Incident } from '@blackbox/core';
import { Diagnostician, extractJson, weakRecommendation, type LlmClient } from './diagnostician.js';
import { templateRca } from './templates.js';
import { buildPrompt, PROMPT_VERSION } from './prompt.js';
import { VertexGemini, VertexError } from './vertex.js';

const T0 = new Date('2026-08-10T12:00:00.000Z');
const SIGNER = '0xb9c58185d09D0aCf3b237cD45C67345E32e628BA' as `0x${string}`;

const incident = (over: Partial<Incident> = {}): Incident =>
  ({
    id: 'inc-1',
    class: 'NONCE_GAP',
    severity: 'critical',
    status: 'open',
    agentId: 'chaos',
    signer: SIGNER,
    chainId: CHAIN_IDS.sepolia,
    detectedAt: T0,
    firstEventAt: new Date(T0.getTime() - 60_000),
    confidence: 0.9,
    evidence: {
      eventIds: ['e0'],
      ruleId: 'R2',
      facts: {
        missingNonces: [47],
        highestSubmittedNonce: 48,
        blockedActionCount: 1,
        consecutiveGapPolls: 2,
      },
      corroboration: { latestNonce: 47, pendingNonce: 47 },
    },
    ...over,
  }) as Incident;

const goodOutput = JSON.stringify({
  summary: 'Nonce 47 was skipped, so nothing above it can execute.',
  contributingFactors: ['A submission at nonce 47 was never broadcast'],
  timeline: [{ at: T0.toISOString(), what: 'R2 fired' }],
  recommendation: 'Fill nonce 47 and reconcile nonces before signing.',
});

const stubLlm = (over: Partial<LlmClient> = {}): LlmClient => ({
  modelId: 'gemini-3.5-flash-lite',
  generate: vi.fn(async () => goodOutput),
  ...over,
});

describe('Diagnostician', () => {
  it('returns validated model output, tagged with the model that wrote it', async () => {
    const result = await new Diagnostician({ llm: stubLlm(), now: () => T0 }).diagnose(incident());
    expect(result.source).toBe('model');
    expect(result.rca.model).toBe('gemini-3.5-flash-lite');
    expect(result.rca.promptVersion).toBe(PROMPT_VERSION);
    expect(result.rca.summary).toContain('Nonce 47');
    expect(rootCauseAnalysisSchema.safeParse(result.rca).success).toBe(true);
  });

  it('falls back to the template when the model errors, and says why', async () => {
    const llm = stubLlm({
      generate: vi.fn(async () => {
        throw new VertexError('Vertex gemini-3.5-flash-lite returned 429: quota', 429, true);
      }),
    });
    const result = await new Diagnostician({ llm, now: () => T0, attempts: 2 }).diagnose(incident());
    expect(result.source).toBe('template');
    expect(result.rca.model).toBe('template');
    expect(result.fallbackReason).toContain('429');
    expect(llm.generate).toHaveBeenCalledTimes(2);
  });

  it('falls back when the model returns the wrong shape', async () => {
    // Plausible prose in the wrong shape must never reach the UI as a
    // half-populated panel.
    const llm = stubLlm({ generate: vi.fn(async () => JSON.stringify({ summary: 'just this' })) });
    const result = await new Diagnostician({ llm, now: () => T0 }).diagnose(incident());
    expect(result.source).toBe('template');
    expect(result.fallbackReason).toMatch(/failed validation/);
  });

  it('retries once and accepts a good second answer', async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(goodOutput);
    const result = await new Diagnostician({ llm: stubLlm({ generate }), now: () => T0 }).diagnose(
      incident(),
    );
    expect(result.source).toBe('model');
  });

  it('runs template-only when no model is configured', async () => {
    const result = await new Diagnostician({ now: () => T0 }).diagnose(incident());
    expect(result.source).toBe('template');
    expect(result.fallbackReason).toBe('no model configured');
    expect(result.rca.summary).toContain('47');
  });

  it('never throws, whatever the model does', async () => {
    const llm = stubLlm({ generate: vi.fn(async () => 'not json at all') });
    await expect(
      new Diagnostician({ llm, now: () => T0 }).diagnose(incident()),
    ).resolves.toMatchObject({ source: 'template' });
  });
});

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a fenced block', () => {
    expect(extractJson('here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses an object with prose around it', () => {
    expect(extractJson('Sure. {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it('returns null when there is no object', () => {
    expect(extractJson('no json here')).toBeNull();
  });
});

describe('templateRca', () => {
  const classes = [
    'NONCE_GAP',
    'STUCK_TRANSACTION',
    'GAS_UNDERPRICED',
    'SIM_PASS_EXEC_REVERT',
    'RETRY_STORM',
    'SIGNER_GAS_STARVED',
    'ADVERSE_INCLUSION',
  ] as const;

  it.each(classes)('writes a usable analysis for %s with no model at all', (cls) => {
    const rca = templateRca(incident({ class: cls }), T0, PROMPT_VERSION);
    expect(rootCauseAnalysisSchema.safeParse(rca).success).toBe(true);
    // The floor is not "non-empty", it is "worth reading at 3am".
    expect(rca.summary.length).toBeGreaterThan(40);
    expect(rca.recommendation.length).toBeGreaterThan(40);
    expect(rca.model).toBe('template');
  });

  it('formats wei as ETH rather than printing a raw integer', () => {
    const rca = templateRca(
      incident({
        class: 'SIGNER_GAS_STARVED',
        evidence: {
          eventIds: ['e0'],
          ruleId: 'R6',
          facts: { signerBalance: '900000000000000', medianRecentCost: '1200000000000000', runwayActions: 0 },
        },
      }),
      T0,
      PROMPT_VERSION,
    );
    expect(rca.summary).toContain('0.000900 ETH');
    expect(rca.summary).not.toContain('900000000000000');
  });

  it('includes the resolution in the timeline once resolved', () => {
    const rca = templateRca(incident({ resolvedAt: T0 }), T0, PROMPT_VERSION);
    expect(rca.timeline.map((t) => t.what)).toContain('Incident resolved');
  });
});

describe('buildPrompt', () => {
  it('passes every measured fact through verbatim', () => {
    const prompt = buildPrompt(incident());
    expect(prompt).toContain('missingNonces: [47]');
    expect(prompt).toContain('consecutiveGapPolls: 2');
    expect(prompt).toContain('R2');
  });

  it('includes what Blackbox did when it has remediated', () => {
    const prompt = buildPrompt(
      incident({
        remediation: {
          playbookId: 'P2',
          finalStatus: 'succeeded',
          attempts: [
            {
              attemptIndex: 0,
              startedAt: T0,
              guardsPassed: [],
              guardsFailed: [],
              status: 'succeeded',
              txHash: `0x${'a'.repeat(64)}`,
            },
          ],
        },
      }),
    );
    expect(prompt).toContain('playbook P2');
    expect(prompt).toContain(`tx 0x${'a'.repeat(64)}`);
  });

  it('marks absent values as unrecorded rather than omitting them', () => {
    const prompt = buildPrompt(
      incident({ evidence: { eventIds: ['e0'], ruleId: 'R2', facts: { nonce: null } } }),
    );
    expect(prompt).toContain('nonce: not recorded');
  });
});

describe('VertexGemini', () => {
  const ok = (body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  it('calls the global host, which is the only one that serves these models', async () => {
    const fetchImpl = ok({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    const client = new VertexGemini({
      projectId: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    });
    await client.generate({ prompt: 'x' });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-3.5-flash-lite:generateContent',
    );
  });

  it('marks 429 as retryable, since the project runs on shared quota', async () => {
    const fetchImpl = vi.fn(async () => new Response('quota', { status: 429 }));
    const client = new VertexGemini({
      projectId: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    });
    await expect(client.generate({ prompt: 'x' })).rejects.toMatchObject({ retryable: true });
  });

  it('does not mark a 400 as retryable', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }));
    const client = new VertexGemini({
      projectId: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    });
    await expect(client.generate({ prompt: 'x' })).rejects.toMatchObject({ retryable: false });
  });

  it('explains a MAX_TOKENS finish with no parts instead of throwing on undefined', async () => {
    // Observed live: thinking consumed the whole budget and `content` came back
    // with no `parts` at all, on a 200.
    const fetchImpl = ok({ candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS' }] });
    const client = new VertexGemini({
      projectId: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    });
    await expect(client.generate({ prompt: 'x' })).rejects.toThrow(/consumed by thinking/);
  });

  it('asks the model to enforce the response schema rather than only requesting it', async () => {
    const fetchImpl = ok({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });
    const client = new VertexGemini({
      projectId: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    });
    await client.generate({ prompt: 'x', responseSchema: { type: 'object' } });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toEqual({ type: 'object' });
  });
});

describe('prompt grounding', () => {
  it('supplies the protocol mechanism, not just the facts', () => {
    // The first live run restated the evidence because "explain the mechanism"
    // assumes the mechanism is known. It is now given.
    const prompt = buildPrompt(incident());
    expect(prompt).toContain('strict nonce order');
    expect(prompt).toContain('queued');
  });

  it('has a mechanism for every incident class', () => {
    for (const cls of [
      'NONCE_GAP',
      'STUCK_TRANSACTION',
      'GAS_UNDERPRICED',
      'SIM_PASS_EXEC_REVERT',
      'RETRY_STORM',
      'SIGNER_GAS_STARVED',
      'ADVERSE_INCLUSION',
    ] as const) {
      expect(buildPrompt(incident({ class: cls }))).toContain('How this class of failure works:');
    }
  });
});

describe('weakRecommendation', () => {
  it.each([
    'Implement a mechanism to identify deterministic reverts and prevent further retries.',
    'Add monitoring for nonce gaps on this signer.',
    'Consider replacing the transaction at a higher fee.',
    'Ensure that nonces are properly reconciled.',
  ])('rejects %s', (text) => {
    expect(weakRecommendation(text)).not.toBeNull();
  });

  it.each([
    'Read the pending nonce immediately before signing, and fill nonce 47 to unblock the queue.',
    'Stop retrying after two identical reverts and pause the breaker.',
  ])('accepts %s', (text) => {
    expect(weakRecommendation(text)).toBeNull();
  });

  it('falls back to the template when the model keeps writing platitudes', async () => {
    const llm = stubLlm({
      generate: vi.fn(async () =>
        JSON.stringify({
          summary: 'A deterministic revert repeated four times.',
          contributingFactors: ['retries are unconditional'],
          timeline: [{ at: T0.toISOString(), what: 'R5 fired' }],
          recommendation: 'Implement a mechanism to detect deterministic reverts.',
        }),
      ),
    });
    const result = await new Diagnostician({ llm, now: () => T0 }).diagnose(incident());
    expect(result.source).toBe('template');
    expect(result.fallbackReason).toMatch(/not actionable/);
  });
});

describe('wei formatting in the prompt', () => {
  it('gives the model ETH alongside the raw value, so it never does the arithmetic', () => {
    const prompt = buildPrompt(
      incident({
        class: 'RETRY_STORM',
        evidence: { eventIds: ['e0'], ruleId: 'R5', facts: { totalGasBurned: '89178982332071' } },
      }),
    );
    expect(prompt).toContain('0.000089178 ETH');
    expect(prompt).toContain('89178982332071 wei');
  });
});
