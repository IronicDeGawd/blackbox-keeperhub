/**
 * Feature audit — the MCP surface, and a genuinely new tenant.
 *
 * Two things the first pass missed. The MCP server is how an *agent* uses
 * Blackbox rather than a person, so it deserves the same treatment as the HTTP
 * routes. And tenancy had only ever been proven against fixtures: this creates
 * a real second organisation on KeeperHub, with its own wallet and its own key,
 * and checks it cannot see or touch ours.
 */
import { describe, expect, it } from 'vitest';
import { KeeperHubClient, KeeperHubMcp } from '@blackbox/core';
import { BlackboxClient, callTool, toolSchemas, type ToolName } from '@blackbox/mcp';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const H = process.env['AUDIT_HOST'] ?? 'https://blackbox-kh.parakramlabs.com';
const log = (id: string, detail: unknown): void =>
  console.log(`AUDIT|${id}|${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);

const client = new BlackboxClient({ baseUrl: H });

describe('Blackbox as an MCP server', () => {
  it('exposes exactly the tools it means to', () => {
    log('mcp.tools', Object.keys(toolSchemas));
    expect(Object.keys(toolSchemas)).toHaveLength(6);
  });

  it('list_incidents', { timeout: 60_000 }, async () => {
    const result = await callTool(client, 'list_incidents', { limit: 5 });
    log('mcp.list_incidents', { isError: result.isError, text: result.text.slice(0, 120) });
    expect(result.isError).toBeFalsy();
  });

  it('get_signer_health', { timeout: 60_000 }, async () => {
    const result = await callTool(client, 'get_signer_health', {
      signer: '0xb9c58185d09d0acf3b237cd45c67345e32e628ba',
    });
    log('mcp.get_signer_health', result.text.slice(0, 140));
    expect(result.isError).toBeFalsy();
  });

  it('diagnose_execution', { timeout: 180_000 }, async () => {
    const result = await callTool(client, 'diagnose_execution', {
      txHash: '0x5f80b82d4aeb446b81b74e76bfd7ac4be7445ac7e6a5bed68738d2168252afa8',
      chainId: 11155111,
    });
    log('mcp.diagnose_execution', { isError: result.isError, text: result.text.slice(0, 200) });
    expect(result.isError).toBeFalsy();
  });

  it('watch_address', { timeout: 60_000 }, async () => {
    const result = await callTool(client, 'watch_address', {
      signer: '0x000000000000000000000000000000000000dEaD',
      chainId: 11155111,
      agentId: 'mcp-audit',
      label: 'mcp audit',
    });
    log('mcp.watch_address', result.text.slice(0, 140));
    expect(result.isError).toBeFalsy();
  });

  it('get_remediation_plan', { timeout: 60_000 }, async () => {
    const incidents = (await client.listIncidents({ limit: 5 })) as { items?: { id: string }[] };
    const id = incidents.items?.[0]?.id;
    if (!id) {
      log('mcp.get_remediation_plan', 'no incident available to plan for');
      return;
    }
    const result = await callTool(client, 'get_remediation_plan', { incidentId: id });
    log('mcp.get_remediation_plan', { isError: result.isError, text: result.text.slice(0, 200) });
  });

  /**
   * The one tool that spends money. An agent must not reach it by accident
   * while exploring, so the authorisation is required by the schema itself.
   */
  it('request_remediation refuses without explicit authorisation', async () => {
    const result = await callTool(client, 'request_remediation', { incidentId: 'inc-anything' });
    log('mcp.request_remediation.unauthorised', result.text.slice(0, 160));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('authorized');
  });

  it('rejects malformed arguments as a readable result, not a crash', async () => {
    const bad = await callTool(client, 'get_signer_health', { signer: 'not-an-address' });
    log('mcp.badArgs', bad.text.slice(0, 140));
    expect(bad.isError).toBe(true);
  });

  it('every tool has a description an agent can choose from', async () => {
    const { toolDescriptions } = await import('@blackbox/mcp');
    log('mcp.descriptions', Object.entries(toolDescriptions).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`));
    for (const name of Object.keys(toolSchemas) as ToolName[]) {
      expect(toolDescriptions[name]).toBeTruthy();
    }
  });
});

describe('KeeperHub as an MCP client', () => {
  it('lists their tools over MCP, live', { timeout: 120_000 }, async () => {
    const mcp = new KeeperHubMcp({ orgKey: process.env['KEEPERHUB_ORG_KEY']! });
    const tools = await mcp.listTools();
    log('keeperhubMcp.tools', { count: tools.length, sample: tools.slice(0, 8) });
    expect(tools.length).toBeGreaterThan(0);
  });

  it('calls one of their read tools', { timeout: 120_000 }, async () => {
    const mcp = new KeeperHubMcp({ orgKey: process.env['KEEPERHUB_ORG_KEY']! });
    const result = await mcp.callTool('list_executions', { limit: 3 });
    log('keeperhubMcp.call', JSON.stringify(result).slice(0, 200));
    expect(result).toBeTruthy();
  });
});

describe('a genuinely new user', () => {
  /**
   * Signing in to KeeperHub with an address that is not already linked creates
   * a new user *and* a new organisation — which is exactly what a second tenant
   * is. Everything below is that tenant's own, not a fixture.
   */
  it('creates its own org, signs into Blackbox, and cannot touch ours', { timeout: 180_000 }, async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    log('newUser.wallet', account.address);

    const kh = new KeeperHubClient();
    await kh.login({
      address: account.address,
      signMessage: (message) => account.signMessage({ message }),
    });
    const key = await kh.createOrgKey('blackbox-audit', (message) =>
      account.signMessage({ message }),
    );
    log('newUser.orgKey', { id: key.id, prefix: key.keyPrefix });

    // Sign into Blackbox with that brand-new organisation's key.
    const signIn = await fetch(`${H}/api/auth/keeperhub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgKey: key.key }),
    });
    const session = (await signIn.json()) as { token?: string; orgId?: string };
    log('newUser.blackboxSignIn', { status: signIn.status, orgId: session.orgId });
    expect(signIn.status).toBe(201);

    const auth = { Authorization: `Bearer ${session.token}` };

    // Their session is real, and owns nothing yet.
    const me = await (await fetch(`${H}/api/auth/session`, { headers: auth })).json();
    log('newUser.session', me);
    expect((me as { agents: string[] }).agents).toEqual([]);

    // A different organisation from ours.
    expect(session.orgId).not.toBe('7xqazg6qi91img6phh7gu');

    // They cannot claim an agent we own.
    const steal = await fetch(`${H}/api/watched`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        signer: '0x4444444444444444444444444444444444444444',
        chainId: 11155111,
        agentId: '0xb9c58185',
      }),
    });
    log('newUser.claimOurs', { status: steal.status, body: (await steal.json())['detail'] });
    expect(steal.status).toBe(403);

    // They can register and own something of their own.
    const theirs = await fetch(`${H}/api/watched`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        signer: account.address,
        chainId: 11155111,
        agentId: `audit-${account.address.slice(2, 10)}`,
      }),
    });
    log('newUser.claimTheirs', { status: theirs.status, owned: (await theirs.json())['owned'] });
    expect(theirs.status).toBe(201);

    // And they can read the public demo, which is what a visitor should see.
    const incidents = await (await fetch(`${H}/api/incidents?limit=3`, { headers: auth })).json();
    log('newUser.reads', { total: (incidents as { total: number }).total });

    await fetch(`${H}/api/auth/signout`, { method: 'POST', headers: auth });
  });
});
