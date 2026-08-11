/** Feature audit — the parts that only mean anything against the real API. */
import { describe, expect, it } from 'vitest';
import { KeeperHubClient } from '@blackbox/core';
import { installEventTrigger, installScheduledSweep } from './triggers.js';

const orgKey = process.env['KEEPERHUB_ORG_KEY']!;
const client = new KeeperHubClient({ orgKey });
const log = (id: string, detail: unknown): void =>
  console.log(`AUDIT|${id}|${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);

describe('KeeperHub, live', () => {
  it('lists the organisation runs', { timeout: 60_000 }, async () => {
    const page = await client.listRuns({ range: '30d', limit: 100 });
    const shapes = {
      total: page.runs.length,
      bySource: page.runs.reduce<Record<string, number>>((acc, r) => {
        acc[`${r.source}/${r.status}`] = (acc[`${r.source}/${r.status}`] ?? 0) + 1;
        return acc;
      }, {}),
      withVerifiedReceipt: page.runs.filter((r) =>
        (r.transactionHashes ?? []).some((t) => t.verified),
      ).length,
      preflightRejections: page.runs.filter(
        (r) => r.status === 'error' && (r.transactionHashes ?? []).length === 0,
      ).length,
    };
    log('live.listRuns', shapes);
    expect(page.runs.length).toBeGreaterThan(0);
  });

  it('reads the spend cap', { timeout: 30_000 }, async () => {
    const limits = await client.getSpendingLimits();
    log('live.spendCap', limits);
    expect(limits.dailyCapWei).toBeTruthy();
  });

  it('lists workflows', { timeout: 30_000 }, async () => {
    const workflows = await client.listWorkflows();
    log('live.workflows', workflows.map((w) => w.name));
    expect(Array.isArray(workflows)).toBe(true);
  });

  it('searches protocol actions', { timeout: 60_000 }, async () => {
    const result = (await client.searchProtocolActions()) as Record<string, unknown>;
    const keys = Array.isArray(result) ? `array(${result.length})` : Object.keys(result).slice(0, 8);
    log('live.protocolActions', keys);
    expect(result).toBeTruthy();
  });

  it('reads a contract through check-and-execute, without acting', { timeout: 60_000 }, async () => {
    // `simulate` so the audit never actually pauses anything.
    const breaker = process.env['CIRCUIT_BREAKER_ADDRESS']!;
    const result = await client.checkAndExecute({
      contractAddress: breaker,
      chainId: '11155111',
      functionName: 'paused',
      functionArgs: '[]',
      condition: { operator: 'eq', value: 'false' },
      action: { contractAddress: breaker, functionName: 'pause', functionArgs: '[]' },
      simulate: true,
    });
    log('live.checkAndExecute', {
      conditionMet: result.conditionMet,
      raw: JSON.stringify(result.raw).slice(0, 160),
    });
    expect(result).toBeTruthy();
  });

  it('installs a schedule trigger, and updates it in place', { timeout: 90_000 }, async () => {
    const first = await installScheduledSweep({
      client,
      baseUrl: 'https://blackbox-kh.parakramlabs.com',
      webhookSecret: 'whsec_audit_placeholder',
      intervalSeconds: 300,
    });
    const second = await installScheduledSweep({
      client,
      baseUrl: 'https://blackbox-kh.parakramlabs.com',
      webhookSecret: 'whsec_audit_placeholder',
      intervalSeconds: 300,
    });
    log('live.triggers.schedule', { first, second, reusedSameWorkflow: first.workflowId === second.workflowId });
    expect(second.created).toBe(false);
  });

  it('installs a contract-event trigger', { timeout: 90_000 }, async () => {
    const result = await installEventTrigger({
      client,
      baseUrl: 'https://blackbox-kh.parakramlabs.com',
      webhookSecret: 'whsec_audit_placeholder',
      contractAddress: process.env['CIRCUIT_BREAKER_ADDRESS']!,
      eventName: 'Paused',
      network: '11155111',
    });
    log('live.triggers.event', result);
    expect(result.workflowId).toBeTruthy();
  });

  it('refuses a schedule KeeperHub would reject', async () => {
    let refused = '';
    try {
      await installScheduledSweep({
        client,
        baseUrl: 'https://blackbox-kh.parakramlabs.com',
        webhookSecret: 'x',
        intervalSeconds: 30,
      });
    } catch (error) {
      refused = (error as Error).message;
    }
    log('live.triggers.tooFast', refused);
    expect(refused).toContain('60s');
  });
});
