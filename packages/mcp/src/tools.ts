import { z } from 'zod';
import type { BlackboxClient } from './client.js';

/**
 * The tools Blackbox exposes to other agents.
 *
 * This is what turns a dashboard into infrastructure: an agent that has just
 * had a transaction fail can ask why, in its own reasoning loop, without a
 * human reading a timeline. Nothing here requires the asking agent to have
 * integrated Blackbox — `diagnose_execution` takes a bare transaction hash.
 *
 * Handlers are plain functions over the client so they can be tested without a
 * transport. The MCP server in `server.ts` is only wiring.
 */

export const toolSchemas = {
  diagnose_execution: z.object({
    txHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'a 32-byte transaction hash, 0x-prefixed'),
    chainId: z.number().int().positive().optional(),
  }),
  get_signer_health: z.object({
    signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 20-byte address, 0x-prefixed'),
    chainId: z.number().int().positive().optional(),
  }),
  list_incidents: z.object({
    status: z.enum(['open', 'diagnosing', 'remediating', 'resolved', 'acknowledged', 'failed']).optional(),
    class: z.string().optional(),
    severity: z.enum(['critical', 'warning', 'info']).optional(),
    agentId: z.string().optional(),
    signer: z.string().optional(),
    chainId: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  get_remediation_plan: z.object({
    incidentId: z.string().min(1),
  }),
  request_remediation: z.object({
    incidentId: z.string().min(1),
    /**
     * Explicit authorisation, required every time.
     *
     * This is the only tool that spends money, and an agent must not reach it
     * by accident while exploring. The guards in §6 still apply on the server;
     * this is the caller-side half of the same intent.
     */
    authorized: z.literal(true, {
      errorMap: () => ({
        message: 'set authorized: true to confirm this may spend real gas',
      }),
    }),
  }),
  watch_address: z.object({
    signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 20-byte address, 0x-prefixed'),
    chainId: z.number().int().positive().optional(),
    agentId: z.string().optional(),
    label: z.string().optional(),
  }),
} as const;

export type ToolName = keyof typeof toolSchemas;

export const toolDescriptions: Record<ToolName, string> = {
  diagnose_execution:
    'Explain why a transaction failed or is stuck. Takes any transaction hash on a supported ' +
    'chain — the sender need not be registered with Blackbox and need not have integrated ' +
    'anything. Returns the incident classification, the evidence that produced it, and a root ' +
    'cause analysis. A transaction with nothing wrong returns class: null and the facts checked.',
  get_signer_health:
    'Current health of a signing address: native balance, latest and pending nonce, any missing ' +
    'nonces wedging its queue, and its open incidents. Use before submitting if a previous ' +
    'transaction behaved oddly.',
  list_incidents:
    'List detected incidents, newest first, with optional filters. Each carries the rule that ' +
    'fired, a confidence, and whether it has been remediated.',
  get_remediation_plan:
    'The exact transaction that would fix an incident — to, value, data, nonce and fees — plus ' +
    'the guards that would allow or block Blackbox acting on it. Read-only: nothing is ' +
    'submitted. Use this to fix an incident with your own signer, which is the only way when ' +
    'the fix must occupy a specific nonce on an account Blackbox holds no key for.',
  request_remediation:
    'Ask Blackbox to remediate an incident itself, spending real gas. Requires authorized: ' +
    'true. Subject to the same guards as any automatic remediation, and a refusal comes back ' +
    'as a normal result naming the guard that blocked it.',
  watch_address:
    'Register an address for continuous monitoring. Blackbox discovers its transactions by ' +
    'scanning blocks, so nothing needs installing on the agent being watched.',
};

export type ToolResult = { text: string; data: unknown; isError?: boolean };

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export async function callTool(
  client: BlackboxClient,
  name: ToolName,
  rawArgs: unknown,
): Promise<ToolResult> {
  const parsed = toolSchemas[name].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    // Returned as a result rather than thrown: an agent can read this and fix
    // its call, where a transport-level error just ends the turn.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { text: `Invalid arguments for ${name} — ${detail}`, data: { error: detail }, isError: true };
  }

  const args = parsed.data as Record<string, unknown>;

  switch (name) {
    case 'diagnose_execution': {
      const result = await client.diagnose(args as { txHash: string; chainId?: number });
      return { text: summariseDiagnosis(result), data: result };
    }

    case 'get_signer_health': {
      const result = await client.signerHealth(args as { signer: string });
      const open = Array.isArray(result['openIncidents']) ? result['openIncidents'].length : 0;
      return {
        text:
          `${args['signer']} holds ${result['balanceWei']} wei, nonce ${result['latestNonce']} ` +
          `(pending ${result['pendingNonce']}), ${open} open incident(s).`,
        data: result,
      };
    }

    case 'list_incidents': {
      const result = await client.listIncidents(args as Record<string, string | number>);
      const lines = result.items.map(
        (i) => `${i['id']} ${i['class']} [${i['severity']}] ${i['status']} — ${i['summary']}`,
      );
      return {
        text: lines.length > 0 ? lines.join('\n') : 'No incidents match those filters.',
        data: result,
      };
    }

    case 'get_remediation_plan': {
      const result = await client.remediationPlan(String(args['incidentId']));
      return { text: summarisePlan(result), data: result };
    }

    case 'request_remediation': {
      const result = await client.remediate(String(args['incidentId']));
      const accepted = result['accepted'] === true;
      const guards = Array.isArray(result['guardsFailed']) ? result['guardsFailed'] : [];
      if (!accepted && guards.length > 0) {
        // Not an error: Blackbox declining with a stated reason is a real
        // answer, and the agent should be able to act on which guard blocked it.
        return {
          text:
            'Blackbox declined to remediate. Blocked by: ' +
            guards
              .map((g) => `${(g as { guard: string }).guard} (${(g as { reason: string }).reason})`)
              .join('; '),
          data: result,
        };
      }
      return {
        text: accepted
          ? `Remediated with ${result['playbookId']}. Transaction ${result['txHash'] ?? '(pending)'}.`
          : `Remediation did not succeed: ${result['finalStatus']}. ${result['reason'] ?? ''}`.trim(),
        data: result,
      };
    }

    case 'watch_address': {
      const result = await client.watchAddress(args as { signer: string });
      return {
        text: `Now watching ${result['signer']} on chain ${result['chainId']}. Its transactions will be discovered by block scanning.`,
        data: result,
      };
    }

    default: {
      const exhaustive: never = name;
      throw new Error(`unknown tool ${String(exhaustive)}`);
    }
  }
}

function summariseDiagnosis(result: Record<string, unknown>): string {
  if (result['found'] === false) return String(result['detail'] ?? 'Transaction not found.');

  const cls = result['class'];
  if (!cls) {
    return (
      `No rule fired for this transaction (status ${result['status']}). ` +
      `${result['detail'] ?? ''} Checked: ${json(result['checked'])}`
    ).trim();
  }

  const rca = result['rca'] as { summary?: string; recommendation?: string } | null;
  return [
    `${cls} (${result['severity']}, confidence ${result['confidence']}, rule ${result['ruleId']}).`,
    rca?.summary ?? '',
    rca?.recommendation ? `Recommended: ${rca.recommendation}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function summarisePlan(plan: Record<string, unknown>): string {
  const declined = plan['declined'] as { reason?: string } | null;
  if (declined) return `No remediation available: ${declined.reason}`;

  const tx = plan['transaction'] as Record<string, unknown> | null;
  if (!tx) return 'No transaction planned for this incident.';

  const guards = plan['guards'] as { failed?: { guard: string; reason: string }[] };
  const blocked = guards?.failed?.length
    ? `\nBlackbox itself would be blocked by: ${guards.failed.map((g) => `${g.guard} (${g.reason})`).join('; ')}`
    : '';

  return (
    `${plan['playbookId']}: ${tx['description']}\n` +
    `Must be signed by ${plan['signerRequired']} on chain ${plan['chainId']}.\n` +
    `to=${tx['to']} value=${tx['value']} nonce=${tx['nonce'] ?? 'any'} ` +
    `maxFeePerGas=${tx['maxFeePerGas']} maxPriorityFeePerGas=${tx['maxPriorityFeePerGas']}` +
    blocked
  );
}
