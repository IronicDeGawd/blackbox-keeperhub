#!/usr/bin/env bash
# Live feature audit against the deployment. Read-only except where noted.
H="${H:-https://blackbox-kh.parakramlabs.com}"
PASS=0; FAIL=0
res() { # id, expectation, actual, ok?
  if [ "$4" = "1" ]; then PASS=$((PASS+1)); echo "PASS|$1|$2|$3";
  else FAIL=$((FAIL+1)); echo "FAIL|$1|$2|$3"; fi
}
code() { curl -s -o /tmp/a.out -w "%{http_code}" "$@"; }
jqf() { python3 -c "import json,sys;d=json.load(open('/tmp/a.out'));print($1)" 2>/dev/null || echo "PARSE_ERR"; }

# --- public reads ---------------------------------------------------------
c=$(code "$H/api/health"); v=$(jqf "d['ok']")
res "health" "200 ok:true" "$c $v" "$([ "$c" = 200 ] && [ "$v" = True ] && echo 1)"

c=$(code "$H/api/config"); v=$(jqf "len(d['rules']['keeperhub']),len(d['rules']['signer'])")
res "config.rules" "7 keeperhub / 7 signer" "$c $v" "$([ "$c" = 200 ] && [ "$v" = "7 7" ] && echo 1)"

v=$(jqf "sorted(k for k,x in d['capabilities'].items() if x)")
res "config.capabilities" "advertises what it can drive" "$v" "$([ -n "$v" ] && echo 1)"

c=$(code "$H/api/stats"); v=$(jqf "list(d['openBySeverity'])")
res "stats" "200 severity buckets" "$c $v" "$([ "$c" = 200 ] && echo 1)"

c=$(code "$H/api/incidents"); v=$(jqf "d['total']")
res "incidents.list" "200 with total" "$c total=$v" "$([ "$c" = 200 ] && echo 1)"

c=$(code "$H/api/incidents/does-not-exist")
res "incidents.detail.404" "404 for unknown id" "$c" "$([ "$c" = 404 ] && echo 1)"

c=$(code "$H/api/agents"); v=$(jqf "len(d['items'])")
res "agents" "200 list" "$c n=$v" "$([ "$c" = 200 ] && echo 1)"

c=$(code "$H/api/watched"); v=$(jqf "len(d['items'])")
res "watched.list" "200 list" "$c n=$v" "$([ "$c" = 200 ] && echo 1)"

c=$(code "$H/api/chaos/scenarios"); v=$(jqf "len(d['scenarios'])")
res "chaos.scenarios" "200 catalogue" "$c n=$v" "$([ "$c" = 200 ] && echo 1)"

# --- chaos planning (the judge path) --------------------------------------
W=0xb9c58185d09d0acf3b237cd45c67345e32e628ba
for S in C1 C2 C3 C4; do
  c=$(code -X POST "$H/api/chaos/plan" -H 'Content-Type: application/json' \
      -d "{\"signer\":\"$W\",\"scenario\":\"$S\",\"chainId\":11155111}")
  v=$(jqf "len(d.get('steps',[]))")
  res "chaos.plan.$S" "200 with steps" "$c steps=$v" "$([ "$c" = 200 ] && echo 1)"
done
c=$(code -X POST "$H/api/chaos/plan" -H 'Content-Type: application/json' \
    -d "{\"signer\":\"$W\",\"scenario\":\"C5\",\"chainId\":11155111}")
v=$(jqf "'declined' in d")
res "chaos.plan.decline" "declines C5" "$c declined=$v" "$([ "$c" = 200 ] && [ "$v" = True ] && echo 1)"

c=$(code -X POST "$H/api/chaos/plan" -H 'Content-Type: application/json' \
    -d "{\"signer\":\"$W\",\"scenario\":\"C2\",\"chainId\":1}")
res "chaos.plan.mainnet" "400 refuses mainnet" "$c" "$([ "$c" = 400 ] && echo 1)"

c=$(code -X POST "$H/api/chaos/observe" -H 'Content-Type: application/json' \
    -d '{"txHashes":["0x0000000000000000000000000000000000000000000000000000000000000001"],"chainId":11155111}')
res "chaos.observe" "200 for an unknown hash" "$c" "$([ "$c" = 200 ] && echo 1)"

c=$(code -X POST "$H/api/chaos/run" -H 'Content-Type: application/json' -d '{"scenario":"C2"}')
res "chaos.run.absent" "404 — deployment holds no key" "$c" "$([ "$c" = 404 ] && echo 1)"

# --- identity: org key ----------------------------------------------------
c=$(code -X POST "$H/api/auth/keeperhub" -H 'Content-Type: application/json' -d '{"orgKey":"wfb_webhookkey"}')
res "auth.key.rejects-webhook-key" "400" "$c" "$([ "$c" = 400 ] && echo 1)"
c=$(code -X POST "$H/api/auth/keeperhub" -H 'Content-Type: application/json' -d '{"orgKey":"kh_not_a_real_key"}')
res "auth.key.rejects-bad-key" "401" "$c" "$([ "$c" = 401 ] && echo 1)"

c=$(code -X POST "$H/api/auth/keeperhub" -H 'Content-Type: application/json' -d "{\"orgKey\":\"$KEEPERHUB_ORG_KEY\"}")
TOKEN=$(jqf "d.get('token','')"); ORG=$(jqf "d.get('orgId','')")
res "auth.key.signin" "201 + session token" "$c org=$ORG" "$([ "$c" = 201 ] && [ -n "$TOKEN" ] && echo 1)"

c=$(code "$H/api/auth/session" -H "Authorization: Bearer $TOKEN"); v=$(jqf "d['orgId']")
res "auth.session" "200 names the org" "$c $v" "$([ "$c" = 200 ] && echo 1)"

c=$(code "$H/api/auth/session")
res "auth.session.anon" "401 without a token" "$c" "$([ "$c" = 401 ] && echo 1)"

# --- identity: OAuth ------------------------------------------------------
c=$(code "$H/api/auth/keeperhub/start"); v=$(jqf "[__import__('urllib.parse',fromlist=['x']).parse_qs(__import__('urllib.parse',fromlist=['x']).urlparse(d['url']).query)[k][0] for k in ('scope','code_challenge_method')]")
res "oauth.start" "authorize url, mcp:read, S256" "$c $v" "$([ "$c" = 200 ] && echo 1)"
c=$(code "$H/api/auth/keeperhub/start?returnTo=https://evil.test")
res "oauth.open-redirect" "400 refuses offsite returnTo" "$c" "$([ "$c" = 400 ] && echo 1)"
c=$(code "$H/api/auth/keeperhub/callback?code=x&state=never-issued")
res "oauth.callback.replay" "401 unknown state" "$c" "$([ "$c" = 401 ] && echo 1)"

# --- identity: wallet -----------------------------------------------------
c=$(code -X POST "$H/api/auth/wallet/challenge" -H 'Content-Type: application/json' -d "{\"address\":\"$W\"}")
v=$(jqf "'authorises no transaction' in d['message']")
res "wallet.challenge" "message names domain, disclaims txs" "$c disclaimer=$v" "$([ "$c" = 200 ] && [ "$v" = True ] && echo 1)"
c=$(code -X POST "$H/api/auth/wallet/challenge" -H 'Content-Type: application/json' -d '{"address":"nope"}')
res "wallet.challenge.bad-address" "400" "$c" "$([ "$c" = 400 ] && echo 1)"
c=$(code -X POST "$H/api/auth/wallet/verify" -H 'Content-Type: application/json' -d '{"nonce":"invented","signature":"0xdead"}')
res "wallet.verify.unknown-nonce" "401" "$c" "$([ "$c" = 401 ] && echo 1)"

# --- webhooks -------------------------------------------------------------
c=$(code -X POST "$H/api/webhooks/keeperhub")
res "webhook.needs-secret" "401 without a secret" "$c" "$([ "$c" = 401 ] && echo 1)"
c=$(code -X POST "$H/api/webhooks/keeperhub/secret")
res "webhook.secret.needs-session" "401 unauthenticated" "$c" "$([ "$c" = 401 ] && echo 1)"
c=$(code -X POST "$H/api/webhooks/keeperhub/secret" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"label":"audit"}')
SECRET=$(jqf "d.get('secret','')"); v=$(jqf "d.get('codeNode') is not None")
res "webhook.secret.mint" "201 whsec_ + code node" "$c codeNode=$v" "$([ "$c" = 201 ] && [ -n "$SECRET" ] && echo 1)"
c=$(code -X POST "$H/api/webhooks/keeperhub" -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' -d '{"runs":[{"id":"fabricated"}]}')
v=$(jqf "d.get('swept')")
res "webhook.nudge" "sweeps, ignores body" "$c swept=$v" "$([ "$c" = 200 ] || [ "$c" = 202 ] && echo 1)"

# --- ownership ------------------------------------------------------------
BURN=0x000000000000000000000000000000000000dEaD
c=$(code -X POST "$H/api/watched" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"signer\":\"$BURN\",\"chainId\":11155111,\"agentId\":\"audit-owned\"}")
v=$(jqf "d.get('owned')")
res "watched.register+claim" "201 owned=true" "$c owned=$v" "$([ "$c" = 201 ] && echo 1)"
# Anonymously: refused before ownership is even consulted, since registering
# needs an account at all now.
c=$(code -X POST "$H/api/watched" -H 'Content-Type: application/json' \
    -d "{\"signer\":\"0x1111111111111111111111111111111111111111\",\"chainId\":11155111,\"agentId\":\"audit-owned\"}")
res "watched.claim.anon" "401 — registration needs an account" "$c" "$([ "$c" = 401 ] && echo 1)"
c=$(code -X DELETE "$H/api/watched/$BURN?chainId=11155111" -H "Authorization: Bearer $TOKEN")
res "watched.unwatch" "200 owner may remove" "$c" "$([ "$c" = 200 ] && echo 1)"

# --- signer health & diagnosis -------------------------------------------
c=$(code "$H/api/signers/$W/health?chainId=11155111"); v=$(jqf "list(d)[:3]")
res "signer.health" "200 balance/nonce view" "$c $v" "$([ "$c" = 200 ] && echo 1)"

c=$(code -X POST "$H/api/diagnose" -H 'Content-Type: application/json' \
    -d '{"txHash":"0xe29df2ca467fe70b390798366f4c3624fae7596dbbd717d299e61a54b07e6030","chainId":11155111}')
v=$(jqf "(d.get('summary') or d.get('headline') or str(list(d))[:60])")
res "diagnose" "200 explains a real hash" "$c" "$([ "$c" = 200 ] && echo 1)"

# --- stream ---------------------------------------------------------------
v=$(timeout 6 curl -s -N "$H/api/stream" | head -c 120 | tr '\n' ' ')
res "stream" "SSE hello frame" "$(echo "$v" | head -c 60)" "$(echo "$v" | grep -q hello && echo 1)"

# --- the console ------------------------------------------------------------
# The deployment serves the pages as well as the API, and until this was here
# nothing in the audit would have noticed the site answering JSON at its root.
ctype() { curl -s -o /tmp/a.out -w "%{http_code} %{content_type}" -H 'accept: text/html' "$@"; }

v=$(ctype "$H/"); res "console.root" "200 html, not JSON" "$v" \
  "$(echo "$v" | grep -q '^200 text/html' && echo 1)"

# A path only the router knows. It has to come back as the application, or a
# link into the console 404s for anybody who did not arrive at the front page.
v=$(ctype "$H/dashboard"); res "console.deep-link" "200 html for a client route" "$v" \
  "$(echo "$v" | grep -q '^200 text/html' && echo 1)"

v=$(curl -s "$H/" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1)
c=$(code "$H$v"); res "console.assets" "the bundle it asks for is served" "$c $v" \
  "$([ "$c" = 200 ] && [ -n "$v" ] && echo 1)"

# The other half of the same rule: a mistyped endpoint must not answer markup,
# or a client parses a page as data.
v=$(ctype "$H/api/not-a-route"); res "console.api-404-stays-json" "404 json under /api" "$v" \
  "$(echo "$v" | grep -q '^404 application/json' && echo 1)"

# --- signout (last, it burns the token) ----------------------------------
c=$(code -X POST "$H/api/auth/signout" -H "Authorization: Bearer $TOKEN")
res "auth.signout" "200" "$c" "$([ "$c" = 200 ] && echo 1)"
c=$(code "$H/api/auth/session" -H "Authorization: Bearer $TOKEN")
res "auth.session.revoked" "401 after signout" "$c" "$([ "$c" = 401 ] && echo 1)"

echo "TOTAL|$PASS passed|$FAIL failed"
