import { describe, expect, it, vi } from 'vitest';
import { KeeperHubClient, KeeperHubError } from './client.js';
import success from './fixtures/direct-execution-success.json' with { type: 'json' };
import runsPage from './fixtures/analytics-runs-page.json' with { type: 'json' };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const clientWith = (impl: typeof fetch) =>
  new KeeperHubClient({ orgKey: 'kh_test', fetchImpl: impl });

describe('contract-call response shapes', () => {
  // Regression: a read call returns {result} with no executionId. Parsing it as
  // an execution record threw against the live API.
  it('returns a read result without demanding an execution record', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({ result: '10754494377065882837' })));
    const res = await client.contractCall({
      network: 'sepolia',
      contractAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      functionName: 'totalSupply',
      functionArgs: '[]',
    });
    expect(res).toEqual({ kind: 'read', result: '10754494377065882837' });
  });

  it('returns an execution record for a write', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(success)));
    const res = await client.contractCall({
      network: 'sepolia',
      contractAddress: '0x0',
      functionName: 'transfer',
      functionArgs: '[]',
    });
    expect(res.kind).toBe('execution');
    if (res.kind === 'execution') expect(res.execution.executionId).toBe(success.executionId);
  });

  it('readContract refuses a call that actually executed', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(success)));
    await expect(
      client.readContract({
        network: 'sepolia',
        contractAddress: '0x0',
        functionName: 'transfer',
        functionArgs: '[]',
      }),
    ).rejects.toThrow(/Expected a read call/);
  });

  it('writeContract refuses a call that only read', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({ result: '1' })));
    await expect(
      client.writeContract({
        network: 'sepolia',
        contractAddress: '0x0',
        functionName: 'balanceOf',
        functionArgs: '[]',
      }),
    ).rejects.toThrow(/Expected a write call/);
  });
});

describe('failed executions are results, not transport errors', () => {
  it('does not throw when a call reverts', async () => {
    const reverted = {
      ...success,
      status: 'failed',
      transactionHash: null,
      receipts: [],
      error: 'Contract call failed: Error(ERC20: transfer amount exceeds balance)',
    };
    const client = clientWith(vi.fn(async () => jsonResponse(reverted)));
    const execution = await client.transfer({
      network: 'sepolia',
      recipientAddress: '0x0',
      amount: '0',
    });
    expect(execution.status).toBe('failed');
  });

  it('throws on a genuine auth failure', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({ error: 'Unauthorized' }, 401)));
    await expect(
      client.transfer({ network: 'sepolia', recipientAddress: '0x0', amount: '0' }),
    ).rejects.toBeInstanceOf(KeeperHubError);
  });
});

describe('step-up signature flow', () => {
  it('signs the challenge and resubmits it in the body', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const impl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      if (calls.length === 1) {
        return jsonResponse(
          {
            error: 'Confirm this action to continue.',
            code: 'signature_required',
            challenge: 'KeeperHub action confirmation\n\nAction: x\nNonce: abc',
            required: ['wallet'],
          },
          401,
        );
      }
      return jsonResponse({ id: 'k1', name: 'blackbox', keyPrefix: 'kh_x', key: 'kh_xsecret' });
    }) as unknown as typeof fetch;

    const client = clientWith(impl);
    const signed: string[] = [];
    const key = await client.createOrgKey('blackbox', async (m) => {
      signed.push(m);
      return '0xsig';
    });

    expect(key.key).toBe('kh_xsecret');
    expect(signed[0]).toContain('Nonce: abc');
    // The challenge is multi-line and cannot be a header, so it goes in the body.
    expect(calls[1]).toMatchObject({ name: 'blackbox', signature: '0xsig' });
    expect(calls[1]!['challenge']).toContain('Nonce: abc');
  });

  it('propagates a failure that is not a signature challenge', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({ code: 'rate_limited' }, 429)));
    await expect(client.createOrgKey('x', async () => '0xsig')).rejects.toThrow(/failed/);
  });
});

describe('org key vs webhook key', () => {
  it('mints organisation keys at /keys and webhook keys at /api-keys', async () => {
    const paths: string[] = [];
    const impl = vi.fn(async (url: string) => {
      paths.push(new URL(url).pathname);
      return jsonResponse({ id: '1', name: 'n', keyPrefix: 'p', key: 'k' });
    }) as unknown as typeof fetch;
    const client = clientWith(impl);
    await client.createOrgKey('a', async () => '0x');
    await client.createWebhookKey('b', async () => '0x');
    expect(paths).toEqual(['/api/keys', '/api/api-keys']);
  });
});

describe('listRuns', () => {
  const capture = () => {
    const urls: string[] = [];
    const impl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse(runsPage);
    }) as unknown as typeof fetch;
    return { urls, impl };
  };

  it('reads the live page shape', async () => {
    const { impl } = capture();
    const page = await clientWith(impl).listRuns();
    expect(page.runs).toHaveLength(runsPage.runs.length);
    // A direct run carries only a hash; a workflow run carries a verified receipt.
    const workflow = page.runs.find((r) => r.source === 'workflow' && r.status === 'success');
    expect(workflow?.transactionHashes?.[0]?.verified).toBe(true);
    const direct = page.runs.find((r) => r.source === 'direct' && r.status === 'success');
    expect(direct?.transactionHashes?.[0]?.verified).toBeUndefined();
  });

  // The server defaults to 24h, which silently hides everything older.
  it('always sends an explicit range', async () => {
    const { urls, impl } = capture();
    const client = clientWith(impl);
    await client.listRuns();
    await client.listRuns({ range: '30d', cursor: '2026-08-10T00:00:00.000Z', limit: 100 });
    expect(new URL(urls[0]!).searchParams.get('range')).toBe('7d');
    const second = new URL(urls[1]!).searchParams;
    expect(second.get('range')).toBe('30d');
    expect(second.get('cursor')).toBe('2026-08-10T00:00:00.000Z');
    expect(second.get('limit')).toBe('100');
  });

  it('refuses a page it cannot recognise', async () => {
    const impl = vi.fn(async () => jsonResponse({ runs: [{ id: 1 }] })) as unknown as typeof fetch;
    await expect(clientWith(impl).listRuns()).rejects.toThrow(/Unrecognised runs page/);
  });
});

describe('check-and-execute', () => {
  /**
   * Their real answer, captured live. The verdict is nested — an earlier
   * reading looked for a top-level `conditionMet`, which does not exist, so a
   * condition that held would have been reported as not held in any simulation.
   */
  it('reads the verdict from conditionResult, not a top-level field', async () => {
    const held = clientWith(
      vi.fn(async () =>
        jsonResponse({
          success: true,
          status: 'simulated',
          executed: false,
          conditionResult: { met: true, observedValue: 'false', targetValue: 'false', operator: 'eq' },
        }),
      ),
    );
    const result = await held.checkAndExecute({
      contractAddress: '0x0',
      chainId: '11155111',
      functionName: 'paused',
      functionArgs: '[]',
      condition: { operator: 'eq', value: 'false' },
      action: { contractAddress: '0x0', functionName: 'pause', functionArgs: '[]' },
    });
    expect(result.conditionMet).toBe(true);
    expect(result.observedValue).toBe('false');
  });

  it('reports a condition that did not hold as a result, not a failure', async () => {
    const notHeld = clientWith(
      vi.fn(async () =>
        jsonResponse({
          success: true,
          status: 'simulated',
          executed: false,
          conditionResult: { met: false, observedValue: 'true' },
        }),
      ),
    );
    const result = await notHeld.checkAndExecute({
      contractAddress: '0x0',
      chainId: '11155111',
      functionName: 'paused',
      functionArgs: '[]',
      condition: { operator: 'eq', value: 'false' },
      action: { contractAddress: '0x0', functionName: 'pause', functionArgs: '[]' },
    });
    expect(result.conditionMet).toBe(false);
    expect(result.observedValue).toBe('true');
  });
});
