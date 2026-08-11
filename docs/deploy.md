# Deploying Blackbox

The public deployment is one Compute Engine VM running three containers:
Postgres, the API, and Caddy for HTTPS. It is deliberately not a
scale-to-zero service — the detection loop ticks every fifteen seconds and
holds a cursor into the chain, so it needs a machine that stays up and a disk
that survives a restart.

## What the public deployment deliberately cannot do

It holds **no signer key and no KeeperHub key**. The API is unauthenticated by
design — a judge should need no account — so any key present would be a
spendable key handed to the open internet. `GET /api/config` reports the
consequence honestly:

```json
{ "remediate": false, "chaos": false, "signChaos": true,
  "diagnose": true, "signerHealth": true, "proposeRemediation": true }
```

`/api/chaos/run` and `/api/incidents/:id/remediate` do not exist there — not
disabled, absent, returning 404. Visitors induce failures by signing them from
their own wallet and apply fixes the same way, which costs us nothing and
proves more.

Setting `KEEPERHUB_ORG_KEY` on the public host would turn the remediation route
back on for anonymous callers, spending our KeeperHub quota. If it is ever
wanted there, add a per-caller cap first; the hourly budget is global and one
caller can exhaust it for everybody.

## First deploy

```bash
PROJECT=blackbox-onchain
gcloud projects create $PROJECT
gcloud billing projects link $PROJECT --billing-account=<ACCOUNT_ID>
gcloud services enable compute.googleapis.com aiplatform.googleapis.com --project $PROJECT

# The model needs no key: Vertex authenticates through the VM's own service
# account via Application Default Credentials.
gcloud iam service-accounts create blackbox-vm --project $PROJECT
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:blackbox-vm@$PROJECT.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

gcloud compute firewall-rules create allow-web --project $PROJECT \
  --allow=tcp:80,tcp:443 --source-ranges=0.0.0.0/0

# us-central1 is frequently out of capacity; any zone works.
gcloud compute instances create blackbox --project $PROJECT --zone=us-east1-b \
  --machine-type=e2-small --boot-disk-size=30GB \
  --image-family=debian-12 --image-project=debian-cloud \
  --service-account="blackbox-vm@$PROJECT.iam.gserviceaccount.com" \
  --scopes=https://www.googleapis.com/auth/cloud-platform \
  --tags=http-server,https-server
```

On the VM: install Docker, and add swap — an `e2-small` has 2 GB of memory and
the TypeScript build of nine packages will exhaust it without.

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Then copy the tree, write `.env` from `.env.example`, and bring it up. The
hostname uses [sslip.io](https://sslip.io), which resolves `1-2-3-4.sslip.io`
to that IP — so Caddy can obtain a real Let's Encrypt certificate without
owning a domain.

```bash
git archive --format=tar.gz -o blackbox.tar.gz HEAD
gcloud compute scp blackbox.tar.gz blackbox:~/ --zone us-east1-b
gcloud compute ssh blackbox --zone us-east1-b
mkdir -p app && tar xzf blackbox.tar.gz -C app && cd app
# BLACKBOX_HOST=blackbox.<ip with dashes>.sslip.io
sudo docker compose -f compose.deploy.yml up -d --build
```

The schema is applied by the `migrate` service, which must exit successfully
before the API starts, so a request cannot land on a database with no tables.

## Connecting operator accounts

The deployment can hold an operator's read-only KeeperHub refresh token, which
is what makes Blackbox read *their* workflows rather than only its own. That
needs a key it is encrypted with, and the key belongs on the machine and
nowhere else:

```bash
# On the VM, not on a laptop, and not in the repo.
echo "BLACKBOX_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> ~/app/.env
```

Without it, `POST /api/auth/keeperhub/start?connect=1` answers **501** naming
the variable and `/api/config` reports `connections.available: false`. Signing
in still works; it simply grants identity and no ingestion.

**Do not rotate this key casually.** It decrypts credentials already stored, so
a new one turns every existing connection into `needs_reauth` and every
operator has to authorise again.

## Verifying a deploy

```bash
H=https://blackbox.<ip-with-dashes>.sslip.io
curl -s $H/api/health
curl -s $H/api/config | jq .capabilities        # chaos and remediate must be false
curl -s $H/api/config | jq .connections        # available:true once the key is set
curl -s "$H/api/auth/keeperhub/start?connect=1&days=30" | jq -r .url \
  | grep -o 'redirect_uri=[^&]*'               # must be this deployment's own URL
curl -s -o /dev/null -w '%{http_code}\n' -X POST $H/api/chaos/run -d '{}'   # 404
curl -s -X POST $H/api/chaos/plan -H 'content-type: application/json' \
  -d '{"scenario":"C2","signer":"0x…"}' | jq '.induces, .steps[0].transaction.nonce'
```

Rate limits are per caller: 120 requests a minute overall, 10 for `/api/diagnose`
and `/api/chaos/observe`, which cost a model call and an RPC fan-out
respectively. The eleventh request in a minute answers `429 rate_limited`.

## Gotchas found the hard way

- **Empty is not unset.** Compose passes an unset variable through as an empty
  string. The env loader now drops blank values, because a blank
  `ALCHEMY_RPC_URL` otherwise wins the fallback against a working
  `SEPOLIA_RPC_URL`, and a blank `KEEPERHUB_ORG_KEY` falls past its default and
  fails schema validation at boot.
- **The runtime user needs a home directory.** The migration tool writes under
  it and fails without one.
- **`us-central1` capacity.** All four zones refused an `e2-small`; `us-east1-b`
  had room. This is normal and not a quota problem.
- **Do not run Postgres on Cloud Run.** Its filesystem is ephemeral and
  instances are recycled, so the incident history would vanish silently. If
  Cloud Run is ever used for the API, the database must be external and the
  service needs `--cpu-always-allocated --min-instances=1`, or the detection
  loop stops between requests.

## Restricting access

While preparing, limit the firewall to a single address:

```bash
gcloud compute firewall-rules update allow-web --project $PROJECT \
  --source-ranges="$(curl -s https://api.ipify.org)/32"
```

Open it back to `0.0.0.0/0` before submitting. Certificate renewal needs port 80
reachable from Let's Encrypt, so do not leave it restricted for months.
