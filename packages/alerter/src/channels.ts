import type { Alert } from './alert.js';
import type { Channel } from './alerter.js';

/**
 * Post the alert as JSON to a URL the operator controls.
 *
 * The channel with no dependencies: it works without a KeeperHub key, without
 * an integration configured, and it is what anyone wiring Blackbox into their
 * own paging system actually wants. Discord and Slack both accept an incoming
 * webhook, so this covers them too when the operator has one.
 */
export function webhookChannel(options: {
  name?: string;
  url: string;
  fetchImpl?: typeof fetch;
  /** Rendered instead of the raw alert — Discord and Slack want `content`/`text`. */
  render?: (alert: Alert) => unknown;
}): Channel {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: options.name ?? 'webhook',
    async deliver(alert) {
      const res = await fetchImpl(options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options.render ? options.render(alert) : serialise(alert)),
      });
      if (!res.ok) {
        throw new Error(`webhook ${options.url} answered ${res.status}`);
      }
    },
  };
}

/** Discord's incoming-webhook shape, so `render` does not have to be written by hand. */
export const discordRender = (alert: Alert): unknown => ({
  content: `**${alert.kind.replace('_', ' ')}** · ${alert.summary}${alert.links
    .map((l) => `\n${l.label}: ${l.url}`)
    .join('')}`,
});

/** Slack's, likewise. */
export const slackRender = (alert: Alert): unknown => ({
  text: `*${alert.kind.replace('_', ' ')}* · ${alert.summary}${alert.links
    .map((l) => `\n<${l.url}|${l.label}>`)
    .join('')}`,
});

/**
 * Deliver by email through a KeeperHub workflow.
 *
 * Their SendGrid action accepts `useKeeperHubApiKey: true`, so this is the one
 * delivery path that needs no credentials from the operator at all — not a
 * SendGrid account, not a Discord integration, nothing but the org key Blackbox
 * already holds. That makes it the sensible default for an operator who has not
 * configured anything.
 *
 * A workflow is created once and re-executed per alert. Creating one per alert
 * would leave an org's workflow list full of single-use rows, which is somebody
 * else's dashboard we would be making a mess of.
 */
export function keeperHubEmailChannel(options: {
  name?: string;
  to: string;
  client: {
    createWorkflow(definition: {
      name: string;
      nodes: unknown[];
      edges: unknown[];
      enabled?: boolean;
    }): Promise<{ id: string }>;
    executeWorkflow(id: string, input?: Record<string, unknown>): Promise<{ executionId: string }>;
    listWorkflows(): Promise<{ id: string; name: string }[]>;
  };
  /** Named so it is obvious in their console who created it and why. */
  workflowName?: string;
}): Channel {
  const workflowName = options.workflowName ?? 'blackbox/alerts/email';
  let workflowId: string | undefined;

  const ensureWorkflow = async (): Promise<string> => {
    if (workflowId) return workflowId;
    // Reuse across restarts: the workflow outlives this process.
    const existing = (await options.client.listWorkflows()).find((w) => w.name === workflowName);
    if (existing) {
      workflowId = existing.id;
      return workflowId;
    }
    const created = await options.client.createWorkflow({
      name: workflowName,
      nodes: [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 0, y: 0 },
          data: { label: 'Manual', config: { triggerType: 'manual' } },
        },
        {
          id: 'step-1',
          type: 'action',
          position: { x: 0, y: 160 },
          data: {
            label: 'Send Email Alert',
            config: {
              actionType: 'sendgrid/send-email',
              useKeeperHubApiKey: true,
              emailTo: options.to,
              emailSubject: '{{subject}}',
              emailBody: '{{body}}',
            },
          },
        },
      ],
      edges: [{ id: 'e-trigger-1-step-1', source: 'trigger-1', target: 'step-1' }],
      enabled: true,
    });
    workflowId = created.id;
    return workflowId;
  };

  return {
    name: options.name ?? 'email',
    async deliver(alert) {
      const id = await ensureWorkflow();
      await options.client.executeWorkflow(id, {
        subject: `Blackbox: ${alert.summary}`,
        body: [
          alert.summary,
          '',
          `incident ${alert.incidentId} · ${alert.class} · ${alert.severity}`,
          `agent ${alert.agentId} · signer ${alert.signer} · chain ${alert.chainId}`,
          ...alert.links.map((l) => `${l.label}: ${l.url}`),
        ].join('\n'),
      });
    },
  };
}

/** Last resort, and the default when nothing is configured: say it in the log. */
export function logChannel(
  logger: { info: (m: string, d?: unknown) => void },
  name = 'default',
): Channel {
  return {
    name,
    async deliver(alert) {
      logger.info(`alert: ${alert.summary}`, {
        incidentId: alert.incidentId,
        kind: alert.kind,
        severity: alert.severity,
      });
    },
  };
}

function serialise(alert: Alert): unknown {
  return { ...alert, firedAt: alert.firedAt.toISOString() };
}
