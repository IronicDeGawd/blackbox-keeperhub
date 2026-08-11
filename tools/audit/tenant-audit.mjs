/**
 * A second tenant, made from a fresh wallet, against the live deployment.
 * Proves the ownership rules hold for somebody who is not us.
 */
import { KeeperHubClient } from '@blackbox/core';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const H = process.env.AUDIT_HOST ?? 'https://blackbox-kh.parakramlabs.com';
let pass = 0, fail = 0;
const res = (id, expect, actual, ok) => {
  if (ok) { pass++; console.log(`PASS|${id}|${expect}|${actual}`); }
  else { fail++; console.log(`FAIL|${id}|${expect}|${actual}`); }
};

const account = privateKeyToAccount(generatePrivateKey());
const kh = new KeeperHubClient();
await kh.login({ address: account.address, signMessage: (m) => account.signMessage({ message: m }) });
const key = await kh.createOrgKey('blackbox-audit-2', (m) => account.signMessage({ message: m }));

const signIn = await fetch(`${H}/api/auth/keeperhub`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ orgKey: key.key }),
});
const session = await signIn.json();
res('tenant.signin', '201 with its own org', `${signIn.status} ${session.orgId}`, signIn.status === 201);
const auth = { Authorization: `Bearer ${session.token}` };

const me = await (await fetch(`${H}/api/auth/session`, { headers: auth })).json();
res('tenant.owns-nothing', 'arrives owning nothing', JSON.stringify(me.agents), Array.isArray(me.agents) && me.agents.length === 0);

// Reading: allowed.
const incidents = await (await fetch(`${H}/api/incidents?limit=3`, { headers: auth })).json();
res('tenant.reads', 'may read the public demo', `total=${incidents.total}`, incidents.total >= 0);
const target = incidents.items?.[0];

// Acting on our agent: refused.
const steal = await fetch(`${H}/api/incidents/${target.id}/remediate`, { method: 'POST', headers: auth });
res('tenant.cannot-remediate-ours', '403', String(steal.status), steal.status === 403);
const ack = await fetch(`${H}/api/incidents/${target.id}/acknowledge`, { method: 'POST', headers: auth });
res('tenant.cannot-acknowledge-ours', '403', String(ack.status), ack.status === 403);

// Claiming our agent id: refused.
const claim = await fetch(`${H}/api/watched`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
  body: JSON.stringify({ signer: '0x3333333333333333333333333333333333333333', chainId: 11155111, agentId: '0xb9c58185' }),
});
res('tenant.cannot-claim-ours', '403', String(claim.status), claim.status === 403);

// Their own connection: empty, and no sight of ours.
const conn = await (await fetch(`${H}/api/connections/keeperhub`, { headers: auth })).json();
res('tenant.own-connection', 'connected:false, watching nothing', JSON.stringify(conn.connected) + ' ' + JSON.stringify(conn.watching), conn.connected === false);

// Picking workflows without connecting: refused.
const pick = await fetch(`${H}/api/connections/keeperhub/workflows`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
  body: JSON.stringify({ workflows: ['2sv4uyij98y5lehgt3955'] }),
});
res('tenant.cannot-pick-ours', '409 — not connected', String(pick.status), pick.status === 409);

// Their own agent: allowed.
const own = await fetch(`${H}/api/watched`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
  body: JSON.stringify({ signer: account.address, chainId: 11155111, agentId: `audit2-${account.address.slice(2, 10)}` }),
});
res('tenant.owns-its-own', '201', String(own.status), own.status === 201);

// The demo button: available to them too, subject to the shared cooldown.
const demo = await fetch(`${H}/api/demo`, { headers: auth });
res('tenant.sees-demo', '200', String(demo.status), demo.status === 200);

await fetch(`${H}/api/auth/signout`, { method: 'POST', headers: auth });
console.log(`TOTAL|${pass} passed|${fail} failed`);
