import { describe, expect, it, vi } from 'vitest';
import { KeeperHubClient, KeeperHubError } from './client.js';
import success from './fixtures/direct-execution-success.json' with { type: 'json' };

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
