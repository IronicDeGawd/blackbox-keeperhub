#!/usr/bin/env bash
# Audit of the surfaces added after the first audit: connecting an account,
# choosing workflows, who may act, the per-workflow budget, and the one public
# button. Read-only apart from the demo press, which is bounded by its own
# cooldown and spends no gas.
#
# Needs KEEPERHUB_ORG_KEY in the environment. Never run this in CI: it signs in
# to a real organisation and presses a button that costs executions.
H="${H:-https://blackbox-kh.parakramlabs.com}"
PASS=0; FAIL=0
res() {
  if [ "$4" = "1" ]; then PASS=$((PASS+1)); echo "PASS|$1|$2|$3";
  else FAIL=$((FAIL+1)); echo "FAIL|$1|$2|$3"; fi
}
code() { curl -s -o /tmp/c.out -w "%{http_code}" "$@"; }
jqf() { python3 -c "import json,sys;d=json.load(open('/tmp/c.out'));print($1)" 2>/dev/null || echo "PARSE_ERR"; }

TOKEN=$(curl -s -X POST "$H/api/auth/keeperhub" -H 'Content-Type: application/json' \
  -d "{\"orgKey\":\"$KEEPERHUB_ORG_KEY\"}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('token',''))")
AUTH="Authorization: Bearer $TOKEN"

# --- what the deployment says about itself --------------------------------
c=$(code "$H/api/config"); v=$(jqf "d['connections']['available'], d['connections']['revocation'], d['connections']['scope']")
res "config.connections" "available, local_only, mcp:read" "$c $v" \
  "$([ "$c" = 200 ] && [ "$v" = "True local_only mcp:read" ] && echo 1)"

v=$(jqf "d['connections']['lifetimeDays']")
res "config.lifetime" "7..60 default 30" "$v" "$([ "$v" = "{'min': 7, 'max': 60, 'default': 30}" ] && echo 1)"

v=$(jqf "'mine' in d['connections'] and d['connections']['mine'] is None")
res "config.connections.anon" "no caller, no 'mine'" "$v" "$([ "$v" = True ] && echo 1)"

v=$(jqf "d['remediation']['budget']['maxRemediationsPerDayPerAgent']")
res "config.budget.perAgent" "3 per workflow per day" "$v" "$([ "$v" = 3 ] && echo 1)"

# --- reading stays open ----------------------------------------------------
c=$(code "$H/api/incidents"); v=$(jqf "d['total']")
res "read.incidents.anon" "200 without an account" "$c total=$v" "$([ "$c" = 200 ] && echo 1)"
c=$(code "$H/api/stats")
res "read.stats.anon" "200 without an account" "$c" "$([ "$c" = 200 ] && echo 1)"
ID=$(curl -s "$H/api/incidents?limit=1" | python3 -c "import json,sys;i=json.load(sys.stdin)['items'];print(i[0]['id'] if i else '')")
c=$(code "$H/api/incidents/$ID")
res "read.incident.detail.anon" "200 without an account" "$c" "$([ "$c" = 200 ] && echo 1)"

# --- acting needs the owner ------------------------------------------------
c=$(code -X POST "$H/api/incidents/$ID/remediate"); v=$(jqf "d.get('detail','')[:20]")
res "act.remediate.anon" "403 telling them to sign in" "$c $v" \
  "$([ "$c" = 403 ] && echo 1)"
c=$(code -X POST "$H/api/incidents/$ID/acknowledge")
res "act.acknowledge.anon" "403" "$c" "$([ "$c" = 403 ] && echo 1)"
c=$(code -X POST "$H/api/watched" -H 'Content-Type: application/json' \
  -d '{"signer":"0x2222222222222222222222222222222222222222","chainId":11155111,"agentId":"land-grab"}')
res "act.watch.anon" "401 — registration needs an account" "$c" "$([ "$c" = 401 ] && echo 1)"

# The owner of a claimed agent may act on it.
OWNED=$(curl -s "$H/api/auth/session" -H "$AUTH" | python3 -c "import json,sys;a=json.load(sys.stdin)['agents'];print(a[0] if a else '')")
res "act.owner.hasAgents" "the session owns something" "$OWNED" "$([ -n "$OWNED" ] && echo 1)"

# --- connections -----------------------------------------------------------
c=$(code "$H/api/connections/keeperhub")
res "conn.needs-session" "401 anonymously" "$c" "$([ "$c" = 401 ] && echo 1)"
c=$(code "$H/api/connections/keeperhub" -H "$AUTH"); v=$(jqf "d['connected'], d['watching']")
res "conn.none-yet" "200 connected:false" "$c $v" "$([ "$c" = 200 ] && echo 1)"
c=$(code "$H/api/connections/keeperhub/workflows" -H "$AUTH")
res "conn.workflows.not-connected" "409 — nothing to read them with" "$c" "$([ "$c" = 409 ] && echo 1)"
c=$(code -X POST "$H/api/connections/keeperhub/workflows" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"workflows":["anything"]}')
res "conn.pick.not-connected" "409 before connecting" "$c" "$([ "$c" = 409 ] && echo 1)"

c=$(code "$H/api/auth/keeperhub/start?connect=1&days=90"); v=$(jqf "d['connect']['days'], d['connect']['scope']")
res "conn.start.clamped" "90 clamps to 60, mcp:read" "$c $v" "$([ "$v" = "60 mcp:read" ] && echo 1)"
v=$(jqf "'blackbox-kh.parakramlabs.com' in d['url'] or 'redirect_uri' in d['url']")
res "conn.start.redirect" "redirect is this deployment" "$v" "$([ "$v" = True ] && echo 1)"

# --- the public button -----------------------------------------------------
c=$(code "$H/api/demo"); v=$(jqf "d['scope'], d['spendsGas'], d['cooldownSeconds']")
res "demo.state" "global, no gas, 1800s" "$c $v" "$([ "$v" = "global False 1800" ] && echo 1)"

READY=$(jqf "d['ready']")
if [ "$READY" = "True" ]; then
  c=$(code -X POST "$H/api/demo/run"); v=$(jqf "len(d.get('executionIds',[]))")
  res "demo.run" "202, three runs" "$c runs=$v" "$([ "$c" = 202 ] && [ "$v" = 3 ] && echo 1)"
else
  res "demo.run" "skipped — still cooling down" "ready=$READY" "1"
fi
c=$(code -X POST "$H/api/demo/run"); v=$(jqf "'everybody' in d.get('detail','')")
res "demo.cooldown" "429 shared by everybody" "$c global=$v" "$([ "$c" = 429 ] && [ "$v" = True ] && echo 1)"

echo "TOTAL|$PASS passed|$FAIL failed"
