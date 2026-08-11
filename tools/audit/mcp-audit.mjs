/**
 * MCP audit, run against the built output.
 *
 * A test file cannot import both @blackbox/mcp and @blackbox/core — no package
 * depends on both — so this imports the two dist builds directly and runs as a
 * plain script. Run it from packages/mcp with KEEPERHUB_ORG_KEY set.
 */
import { BlackboxClient, callTool, toolSchemas, toolDescriptions } from '/project/blackbox/packages/mcp/dist/index.js';
import { KeeperHubMcp } from '/project/blackbox/packages/core/dist/index.js';

const H = process.env.AUDIT_HOST ?? 'https://blackbox-kh.parakramlabs.com';
let pass = 0, fail = 0;
const res = (id, expect, actual, ok) => {
  if (ok) { pass++; console.log(`PASS|${id}|${expect}|${actual}`); }
  else { fail++; console.log(`FAIL|${id}|${expect}|${actual}`); }
};
const client = new BlackboxClient({ baseUrl: H });

res('mcp.tools', '6 tools exposed', Object.keys(toolSchemas).join(','), Object.keys(toolSchemas).length === 6);
res('mcp.descriptions', 'every tool describes itself', 'all present',
  Object.keys(toolSchemas).every((n) => Boolean(toolDescriptions[n])));

let r = await callTool(client, 'list_incidents', { limit: 5 });
res('mcp.list_incidents', 'reads without an account', r.text.slice(0, 60), !r.isError);

r = await callTool(client, 'get_signer_health', { signer: '0xb9c58185d09d0acf3b237cd45c67345e32e628ba' });
res('mcp.get_signer_health', 'answers', r.text.slice(0, 60), !r.isError);

r = await callTool(client, 'get_signer_health', { signer: 'not-an-address' });
res('mcp.badArgs', 'a readable error, not a crash', r.text.slice(0, 60), r.isError === true);

try {
  r = await callTool(client, 'watch_address', {
    signer: '0x000000000000000000000000000000000000dEaD', chainId: 11155111, agentId: 'mcp-audit', label: 'mcp audit',
  });
  res('mcp.watch_address.unauthenticated', 'a readable tool error', r.text.slice(0, 60), r.isError === true);
} catch (error) {
  res('mcp.watch_address.unauthenticated', 'a readable tool error, not a thrown one',
    `THREW ${error.status ?? ''} ${String(error.message).slice(0, 50)}`, false);
}
try {
  r = await callTool(client, 'diagnose_execution', { txHash: '0x' + 'ab'.repeat(32), chainId: 11155111 });
  res('mcp.diagnose.unknown-hash', 'answers rather than throwing', r.text.slice(0, 60), true);
} catch (error) {
  res('mcp.diagnose.unknown-hash', 'answers rather than throwing', `THREW ${String(error.message).slice(0, 50)}`, false);
}

r = await callTool(client, 'request_remediation', { incidentId: 'inc-anything' });
res('mcp.request_remediation.unauthorised', 'refuses without explicit authorisation', r.text.slice(0, 60),
  r.isError === true && r.text.includes('authorized'));

const incidents = await client.listIncidents({ limit: 5 });
const id = incidents.items?.[0]?.id;
if (id) {
  r = await callTool(client, 'get_remediation_plan', { incidentId: id });
  res('mcp.get_remediation_plan', 'answers for a real incident', r.text.slice(0, 60), !r.isError);
}

const mcp = new KeeperHubMcp({ orgKey: process.env.KEEPERHUB_ORG_KEY });
const tools = await mcp.listTools();
res('keeperhubMcp.tools', 'their tools list', `count=${tools.length}`, tools.length > 0);
const call = await mcp.callTool('list_executions', { limit: 3 });
res('keeperhubMcp.call', 'a read tool answers', JSON.stringify(call).slice(0, 50), Boolean(call));

console.log(`TOTAL|${pass} passed|${fail} failed`);
