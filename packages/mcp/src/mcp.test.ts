import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BlackboxClient } from './client.js';
import { buildMcpServer } from './server.js';
import { callTool, toolDescriptions, toolSchemas, type ToolName } from './tools.js';

const ok = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

const client = (fetchImpl: typeof fetch) =>
  new BlackboxClient({ baseUrl: 'http://api.test', fetchImpl });

describe('argument validation', () => {
  it('rejects a hash that is not 32 bytes, without calling the API', async () => {
    const fetchImpl = ok({});
    const result = await callTool(client(fetchImpl as never), 'diagnose_execution', {
      txHash: '0xdeadbeef',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/32-byte transaction hash/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an address that is not 20 bytes', async () => {
    const result = await callTool(client(ok({}) as never), 'get_signer_health', {
      signer: 'vitalik.eth',
    });
    expect(result.isError).toBe(true);
  });

  it('returns invalid arguments as a readable result, not a thrown error', async () => {
    // An agent can read this and fix its call; a thrown transport error just
    // ends the turn with nothing to reason about.
    await expect(
      callTool(client(ok({}) as never), 'list_incidents', { severity: 'catastrophic' }),
    ).resolves.toMatchObject({ isError: true });
  });
});

describe('diagnose_execution', () => {
  const hash = `0x${'a'.repeat(64)}`;

  it('explains a classified transaction with its root cause', async () => {
    const fetchImpl = ok({
      found: true,
      class: 'SIM_PASS_EXEC_REVERT',
      severity: 'critical',
      confidence: 0.95,
      ruleId: 'R4',
      rca: { summary: 'State changed between simulation and inclusion.', recommendation: 'Re-simulate immediately before submitting.' },
    });
    const result = await callTool(client(fetchImpl as never), 'diagnose_execution', { txHash: hash });

    expect(result.text).toContain('SIM_PASS_EXEC_REVERT');
    expect(result.text).toContain('State changed');
    expect(result.text).toContain('Recommended:');
    expect(result.isError).toBeUndefined();
  });

  it('says plainly when nothing is wrong, rather than returning nothing', async () => {
    const fetchImpl = ok({
      found: true,
      class: null,
      status: 'included',
      detail: 'No rule fired for this transaction.',
      checked: { latestNonce: 5, missingNonces: [] },
    });
    const result = await callTool(client(fetchImpl as never), 'diagnose_execution', { txHash: hash });
    expect(result.text).toContain('No rule fired');
    expect(result.text).toContain('latestNonce');
  });

  it('reports a transaction that does not exist', async () => {
    const fetchImpl = ok({ found: false, detail: 'No such transaction on this chain.' });
    const result = await callTool(client(fetchImpl as never), 'diagnose_execution', { txHash: hash });
    expect(result.text).toBe('No such transaction on this chain.');
  });
});

describe('request_remediation', () => {
  it('refuses to act without explicit authorisation', async () => {
    // The only tool that spends money. An agent must not reach it by accident
    // while exploring.
    const fetchImpl = ok({ accepted: true });
    const result = await callTool(client(fetchImpl as never), 'request_remediation', {
      incidentId: 'inc-1',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/authorized: true/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects authorized: false as firmly as an omission', async () => {
    const fetchImpl = ok({ accepted: true });
    const result = await callTool(client(fetchImpl as never), 'request_remediation', {
      incidentId: 'inc-1',
      authorized: false,
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a guard refusal as an answer, naming what blocked it', async () => {
    const fetchImpl = ok({
      accepted: false,
      finalStatus: 'skipped_by_guard',
      guardsFailed: [{ guard: 'budget', reason: '10 remediations in the last hour reaches the cap' }],
    });
    const result = await callTool(client(fetchImpl as never), 'request_remediation', {
      incidentId: 'inc-1',
      authorized: true,
    });
    // A refusal with a reason is a real answer, not an error.
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('budget');
    expect(result.text).toContain('reaches the cap');
  });

  it('reports the transaction when it acted', async () => {
    const fetchImpl = ok({ accepted: true, playbookId: 'P4', txHash: `0x${'b'.repeat(64)}` });
    const result = await callTool(client(fetchImpl as never), 'request_remediation', {
      incidentId: 'inc-1',
      authorized: true,
    });
    expect(result.text).toContain('P4');
    expect(result.text).toContain('0xbbbb');
  });
});

describe('get_remediation_plan', () => {
  it('describes the transaction and who must sign it', async () => {
    const fetchImpl = ok({
      playbookId: 'P2',
      signerRequired: '0xb9c5',
      chainId: 11155111,
      guards: { passed: ['budget'], failed: [] },
      transaction: {
        description: 'fill missing nonce 93',
        to: '0xb9c5',
        value: '0',
        nonce: 93,
        maxFeePerGas: '4191302983',
        maxPriorityFeePerGas: '2000000000',
      },
      declined: null,
    });
    const result = await callTool(client(fetchImpl as never), 'get_remediation_plan', {
      incidentId: 'inc-1',
    });
    expect(result.text).toContain('fill missing nonce 93');
    expect(result.text).toContain('Must be signed by 0xb9c5');
    expect(result.text).toContain('nonce=93');
  });

  it('passes on a refusal with its reason', async () => {
    const fetchImpl = ok({
      playbookId: 'P3',
      declined: { policy: 'skipped_by_policy', reason: 'Base Sepolia has no private mempool' },
      transaction: null,
      guards: { passed: [], failed: [] },
    });
    const result = await callTool(client(fetchImpl as never), 'get_remediation_plan', {
      incidentId: 'inc-1',
    });
    expect(result.text).toContain('no private mempool');
  });

  it('warns when Blackbox itself would be blocked from acting', async () => {
    const fetchImpl = ok({
      playbookId: 'P2',
      signerRequired: '0xb9c5',
      chainId: 11155111,
      guards: { passed: [], failed: [{ guard: 'signer_allowlist', reason: 'not on the allowlist' }] },
      transaction: { description: 'fill nonce 4', to: '0x1', value: '0', nonce: 4, maxFeePerGas: '1', maxPriorityFeePerGas: '1' },
      declined: null,
    });
    const result = await callTool(client(fetchImpl as never), 'get_remediation_plan', {
      incidentId: 'inc-1',
    });
    expect(result.text).toContain('signer_allowlist');
  });
});

describe('list_incidents', () => {
  it('renders one line per incident', async () => {
    const fetchImpl = ok({
      total: 2,
      items: [
        { id: 'inc-1', class: 'NONCE_GAP', severity: 'critical', status: 'open', summary: 'Nonce 47 unfilled' },
        { id: 'inc-2', class: 'RETRY_STORM', severity: 'critical', status: 'resolved', summary: '4 failed attempts' },
      ],
    });
    const result = await callTool(client(fetchImpl as never), 'list_incidents', { status: 'open' });
    expect(result.text.split('\n')).toHaveLength(2);
    expect(result.text).toContain('Nonce 47 unfilled');
  });

  it('says so when nothing matches', async () => {
    const result = await callTool(client(ok({ total: 0, items: [] }) as never), 'list_incidents', {});
    expect(result.text).toBe('No incidents match those filters.');
  });

  it('only sends filters that were supplied', async () => {
    const fetchImpl = ok({ total: 0, items: [] });
    await callTool(client(fetchImpl as never), 'list_incidents', { severity: 'critical' });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://api.test/api/incidents?severity=critical');
  });
});

describe('errors from the API', () => {
  const refusing = (status: number, body: Record<string, unknown>) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  /**
   * Answered, not thrown. A thrown error ends the agent's turn; a result it
   * can read lets it explain itself or try something else — which is the same
   * reasoning that already applied to argument validation.
   */
  it('returns the API detail as a readable result', async () => {
    const fetchImpl = refusing(404, { error: 'not_found', detail: 'Incident inc-9 not found' });
    const result = await callTool(client(fetchImpl as never), 'get_remediation_plan', {
      incidentId: 'inc-9',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Incident inc-9 not found');
    expect(result.data).toMatchObject({ status: 404 });
  });

  /** The refusal an unauthenticated agent will actually meet. */
  it('tells an unauthenticated agent what it is missing', async () => {
    const fetchImpl = refusing(401, {
      error: 'unauthorized',
      detail: 'Sign in to watch an address. Reading incidents needs no account.',
    });
    const result = await callTool(client(fetchImpl as never), 'watch_address', {
      signer: '0x000000000000000000000000000000000000dEaD',
      chainId: 11155111,
      agentId: 'demo',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Sign in to watch an address');
    expect(result.text).toContain('BLACKBOX_TOKEN');
  });

  it('does not offer that hint to an agent that already has a token', async () => {
    const fetchImpl = refusing(403, { error: 'forbidden', detail: 'Agent belongs to another org.' });
    const signedIn = new BlackboxClient({
      baseUrl: 'http://api.test',
      token: 'bb_test',
      fetchImpl: fetchImpl as never,
    });
    const result = await callTool(signedIn, 'watch_address', {
      signer: '0x000000000000000000000000000000000000dEaD',
      chainId: 11155111,
      agentId: 'demo',
    });

    expect(result.text).toContain('another org');
    expect(result.text).not.toContain('BLACKBOX_TOKEN');
  });

  it('answers rather than throwing when the transport itself fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const result = await callTool(client(fetchImpl as never), 'list_incidents', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('ECONNREFUSED');
  });
});

describe('acting as an account', () => {
  it('sends the token when it has one, and nothing when it does not', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ watching: true }), { status: 201 }));
    const anonymous = new BlackboxClient({ baseUrl: 'http://api.test', fetchImpl: fetchImpl as never });
    expect(anonymous.authenticated).toBe(false);

    const signedIn = new BlackboxClient({
      baseUrl: 'http://api.test',
      token: 'bb_secret',
      fetchImpl: fetchImpl as never,
    });
    expect(signedIn.authenticated).toBe(true);

    await callTool(anonymous, 'watch_address', {
      signer: '0x000000000000000000000000000000000000dEaD',
      chainId: 11155111,
      agentId: 'demo',
    });
    await callTool(signedIn, 'watch_address', {
      signer: '0x000000000000000000000000000000000000dEaD',
      chainId: 11155111,
      agentId: 'demo',
    });

    const headersOf = (i: number) =>
      (fetchImpl.mock.calls[i]?.[1] as { headers: Record<string, string> }).headers;
    expect(headersOf(0)['Authorization']).toBeUndefined();
    expect(headersOf(1)['Authorization']).toBe('Bearer bb_secret');
  });

  it('treats a blank token as no token, rather than sending "Bearer "', () => {
    expect(new BlackboxClient({ token: '   ' }).authenticated).toBe(false);
  });
});

describe('the MCP surface', () => {
  it('advertises every tool with a description', async () => {
    const server = buildMcpServer({ fetchImpl: ok({ total: 0, items: [] }) as never });
    const mcp = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'diagnose_execution',
      'get_remediation_plan',
      'get_signer_health',
      'list_incidents',
      'request_remediation',
      'watch_address',
    ]);
    for (const tool of tools) expect(tool.description?.length ?? 0).toBeGreaterThan(40);
    await mcp.close();
  });

  it('answers a real tool call over the protocol', async () => {
    const server = buildMcpServer({
      fetchImpl: ok({
        total: 1,
        items: [{ id: 'inc-1', class: 'NONCE_GAP', severity: 'critical', status: 'open', summary: 'Nonce 47 unfilled' }],
      }) as never,
    });
    const mcp = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

    const result = await mcp.callTool({ name: 'list_incidents', arguments: { status: 'open' } });
    const content = result.content as { type: string; text: string }[];
    expect(content[0]?.text).toContain('Nonce 47 unfilled');
    await mcp.close();
  });

  it('reports an unreachable Blackbox as a tool error the agent can read', async () => {
    const server = buildMcpServer({
      fetchImpl: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }) as never,
    });
    const mcp = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

    const result = await mcp.callTool({ name: 'list_incidents', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toContain('ECONNREFUSED');
    await mcp.close();
  });
});

describe('tool metadata', () => {
  it('documents every tool it exposes', () => {
    for (const name of Object.keys(toolSchemas) as ToolName[]) {
      expect(toolDescriptions[name]).toBeTruthy();
    }
  });
});
