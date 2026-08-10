import type { Incident } from '@blackbox/core';

/** Bumped whenever the prompt changes, and stored on every analysis. */
export const PROMPT_VERSION = '2026-08-10.3';

export const SYSTEM_INSTRUCTION = [
  'You explain onchain transaction failures to an engineer who is on call.',
  '',
  'The classification has already been made mechanically by a rule engine, and it is correct.',
  'Do not question it, re-classify it, or hedge about what kind of incident this is.',
  '',
  'Your job is to explain the MECHANISM: the protocol-level reason these facts produce this',
  'failure. The engineer can already see the facts. Restating them is worthless to them.',
  '',
  // The first live run against Gemini produced exactly this failure: a summary
  // that said "nonce 41 was missing, which prevented subsequent transactions"
  // and a recommendation to "implement a mechanism to monitor nonces". Both are
  // the evidence read back with different grammar. The instructions below exist
  // because the model will do that by default unless told not to.
  'Never write a summary of the form "X was detected, which caused Y". That is the input,',
  'restated. Write instead why the protocol behaves this way, what it means for the agent,',
  'and what it costs.',
  '',
  'Rules:',
  '- Use only the facts provided. Never invent a number, hash, block, or timestamp.',
  '- If something is not in the evidence, say it is not known rather than guessing.',
  '- Name specific values, but explain what they imply — a number with no consequence is noise.',
  '- Do not name the rule id in the summary. The engineer is looking at it.',
  '- Contributing factors are conditions in the agent that allowed this, not observations.',
  '- The recommendation is one concrete change to the agent. Not "monitor it", not "add',
  '  alerting", not "implement a mechanism" — say what to change and when it runs.',
  '- No apologies, no filler, no preamble.',
].join('\n');

/**
 * The protocol mechanism behind each class.
 *
 * Grounding, not scripting: the model is given the rule that makes these facts
 * a failure, and asked to apply it to the specific numbers. Without it the
 * first live run produced summaries that restated the evidence, because
 * "explain the mechanism" assumes the mechanism is known.
 */
const MECHANISM: Record<string, string> = {
  NONCE_GAP:
    'Ethereum executes an account\'s transactions in strict nonce order. A transaction at a ' +
    'nonce above an unused one is *queued*, not pending, and can never be mined until the hole ' +
    'is filled. It does not expire on its own, and it blocks every later transaction from the ' +
    'same signer indefinitely.',
  STUCK_TRANSACTION:
    'A pending transaction competes for block space on its effective tip. If the market moves ' +
    'above its bid it simply waits, holding its nonce and blocking everything behind it. Only a ' +
    'replacement at the same nonce, priced at least 12.5% higher, can displace it.',
  GAS_UNDERPRICED:
    'EIP-1559 charges the block base fee and pays the validator the priority tip. A maxFeePerGas ' +
    'below the current base fee cannot be included at all; a bid with no meaningful tip has no ' +
    'reason to be picked. A bid correct at submission becomes uncompetitive as the base fee ' +
    'rises under it.',
  SIM_PASS_EXEC_REVERT:
    'eth_call simulates against one block\'s state. Inclusion happens at least one block later, ' +
    'against different state. Any precondition that another transaction can change between those ' +
    'two moments makes the simulation result stale, and the gas is spent before the revert.',
  RETRY_STORM:
    'A deterministic revert reverts identically on every attempt: the same calldata against the ' +
    'same state fails the same way. Retrying it cannot succeed, and each attempt that clears ' +
    'pre-flight still pays for the gas it consumed before reverting.',
  SIGNER_GAS_STARVED:
    'Every transaction is paid for by its sender in native currency. A signer whose balance no ' +
    'longer covers gasLimit x maxFeePerGas cannot submit anything at all, including the ' +
    'transaction that would fix whatever it was doing.',
  ADVERSE_INCLUSION:
    'A public mempool transaction is visible before it is mined, and block builders order by ' +
    'fee, not arrival. A price-sensitive call can therefore be surrounded by transactions that ' +
    'move the price against it, and it still succeeds — at terms the caller never agreed to.',
};

/**
 * The shape the model must return, enforced by Vertex rather than requested in
 * prose. `timeline.at` is an ISO 8601 string; the schema coerces it to a Date
 * on the way in.
 */
export const RCA_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Two to four sentences explaining the mechanism of the failure.',
    },
    contributingFactors: {
      type: 'array',
      items: { type: 'string' },
      description: 'Each a specific condition that allowed this to happen.',
    },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          at: { type: 'string', description: 'ISO 8601 timestamp taken from the evidence.' },
          what: { type: 'string' },
        },
        required: ['at', 'what'],
      },
    },
    recommendation: {
      type: 'string',
      description:
        'One concrete change to the agent, naming what to change and when it runs. ' +
        'Must NOT be of the form "implement a mechanism to...", "monitor...", or "add alerting". ' +
        'Those describe wanting the problem solved rather than solving it.',
    },
  },
  required: ['summary', 'contributingFactors', 'timeline', 'recommendation'],
} as const;

/**
 * Fact keys whose values are wei. Formatting them here rather than hoping the
 * model does it: the first live run put `89178982332071` in the prose, which is
 * unreadable and is arithmetic the model should never have been asked to do.
 */
const WEI_KEYS = new Set([
  'totalGasBurned',
  'signerBalance',
  'medianRecentCost',
  'submittedMaxFee',
  'submittedMaxFeePerGas',
  'baseFeeAtDetection',
  'effectiveGasPrice',
]);

function eth(wei: unknown): string | null {
  try {
    const value = BigInt(String(wei));
    const whole = value / 10n ** 18n;
    const frac = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 9);
    return `${whole}.${frac} ETH`;
  } catch {
    return null;
  }
}

const line = (key: string, value: unknown): string => {
  if (WEI_KEYS.has(key) && value !== null && value !== undefined) {
    const formatted = eth(value);
    if (formatted) return `  ${key}: ${formatted} (${format(value)} wei)`;
  }
  return `  ${key}: ${format(value)}`;
};

function format(value: unknown): string {
  if (value === null || value === undefined) return 'not recorded';
  if (Array.isArray(value)) return `[${value.map((v) => format(v)).join(', ')}]`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Turn an incident into a prompt.
 *
 * Everything measured goes in verbatim, labelled, with the thresholds beside
 * the facts they bound — a model told "consecutiveGapPolls: 2, threshold: 2"
 * writes a far more specific explanation than one told "a gap persisted".
 */
export function buildPrompt(incident: Incident): string {
  const parts: string[] = [
    `Incident class: ${incident.class}`,
    `Detected by rule: ${incident.evidence.ruleId} at confidence ${incident.confidence}`,
    `Severity: ${incident.severity}`,
    `Chain id: ${incident.chainId}`,
    `Agent: ${incident.agentId}`,
    `Signer: ${incident.signer}`,
    `First related event: ${incident.firstEventAt.toISOString()}`,
    `Detected at: ${incident.detectedAt.toISOString()}`,
    '',
    'Evidence the rule fired on:',
    ...Object.entries(incident.evidence.facts).map(([k, v]) => line(k, v)),
  ];

  const corroboration = incident.evidence.corroboration;
  if (corroboration && Object.keys(corroboration).length > 0) {
    parts.push(
      '',
      'Independent chain readings taken at detection time:',
      ...Object.entries(corroboration).map(([k, v]) => line(k, v)),
    );
  }

  if (incident.evidence.suppressedRules?.length) {
    parts.push(
      '',
      `Also fired but suppressed as less specific: ${incident.evidence.suppressedRules.join(', ')}`,
    );
  }

  if (incident.remediation) {
    parts.push(
      '',
      `Blackbox ran playbook ${incident.remediation.playbookId}, outcome ${incident.remediation.finalStatus}.`,
      ...incident.remediation.attempts.map(
        (a) =>
          `  attempt ${a.attemptIndex}: ${a.status}` +
          (a.txHash ? ` tx ${a.txHash}` : '') +
          (a.failureReason ? ` — ${a.failureReason}` : ''),
      ),
    );
  }

  const mechanism = MECHANISM[incident.class];
  if (mechanism) parts.push('', 'How this class of failure works:', `  ${mechanism}`);

  parts.push(
    '',
    'Apply that mechanism to the specific values above. Explain what actually happened to this',
    'agent, what it cost, and the one change that would stop it recurring.',
  );
  return parts.join('\n');
}
