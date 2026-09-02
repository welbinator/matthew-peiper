#!/usr/bin/env bash
# mp-reconcile-worker-secret.sh — align the matthew-peiper Cloudflare Worker's
# PUSH_NOTIFY_SECRET to the HUB (canonical) value, then verify both signed flows.
#
# The Worker is the ONE component that can't source the secret from a file (it lives
# at Cloudflare), so it's the single manual touch-point. The on-box hub<->client-CC
# copies self-reconcile via mp-sync-push-secret.sh (systemd ExecStartPre); this script
# closes the loop for the Worker. Run it any time you suspect drift or after rotating
# the hub secret. Idempotent, never prints the secret, verifies before declaring success.
#
# Requires (run from ~/matthew-peiper): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
# node 22 (nvm), ssh key ~/.ssh/parchment-hetzner.
set -euo pipefail

SITE="matthew-peiper"
HUB_HOST="root@168.119.121.111"
SSH_KEY="$HOME/.ssh/parchment-hetzner"
WORKER_INBOUND="https://matthewpeiper.com/api/support/inbound"
WORKER_INGEST="https://matthewpeiper.com/api/support/ingest"

log() { echo "[reconcile-worker] $*"; }

HUB_SECRET="$(ssh -i "$SSH_KEY" -o BatchMode=yes "$HUB_HOST" \
  'grep -m1 "^PUSH_NOTIFY_SECRET=" /opt/command-center/.env | cut -d= -f2-')"
[ -n "$HUB_SECRET" ] || { log "FATAL: could not read hub secret"; exit 1; }
log "hub secret fp $(printf '%s' "$HUB_SECRET" | sha256sum | cut -c1-12)"

# --- verify current Worker state BEFORE changing (probe inbound) ---
probe_inbound() { # $1 = secret ; echoes HTTP status
  python3 - "$1" <<'PY'
import sys, time, json, hmac, hashlib, urllib.request, urllib.error
secret=sys.argv[1]
raw=json.dumps({"type":"ping","id":"reconcile-probe","site_id":"matthew-peiper"},separators=(",",":")).encode()
ts=str(int(time.time())); dig=hmac.new(secret.encode(),f"v0:{ts}:{raw.decode()}".encode(),hashlib.sha256).hexdigest()
req=urllib.request.Request("https://matthewpeiper.com/api/support/inbound",data=raw,method="POST",
  headers={"Content-Type":"application/json","X-CC-Signature":f"t={ts},v0={dig}","User-Agent":"ReconcileProbe/1.0"})
try:
    r=urllib.request.urlopen(req,timeout=15); print(r.status)
except urllib.error.HTTPError as e: print(e.code)
except Exception: print("ERR")
PY
}

pre="$(probe_inbound "$HUB_SECRET")"
if [ "$pre" = "400" ]; then
  log "Worker ALREADY matches hub (inbound probe 400 = sig accepted); nothing to do"
else
  log "Worker mismatch (inbound probe $pre); setting Worker secret from hub value"
  printf '%s' "$HUB_SECRET" | npx --yes wrangler secret put PUSH_NOTIFY_SECRET
  sleep 5
fi

# --- verify BOTH flows after (inbound push + ingest uploads) ---
post_inbound="$(probe_inbound "$HUB_SECRET")"
ingest_status="$(python3 - "$HUB_SECRET" <<'PY'
import sys, time, hashlib, hmac, urllib.request, urllib.error
secret=sys.argv[1]; body=b"\x89PNG\r\n\x1a\n"+b"x"*32; tid="reconcile-probe-tid"; fn="probe.png"
sha=hashlib.sha256(body).hexdigest(); ts=str(int(time.time()))
dig=hmac.new(secret.encode(),f"v0:{ts}:{tid}:{fn}:{sha}".encode(),hashlib.sha256).hexdigest()
req=urllib.request.Request("https://matthewpeiper.com/api/support/ingest",data=body,method="POST",
  headers={"Content-Type":"application/octet-stream","X-CC-Signature":f"t={ts},v0={dig}",
           "X-CC-Ticket":tid,"X-CC-Filename":fn,"X-CC-Content-Type":"image/png",
           "User-Agent":"MatthewPeiperCC-Support/1.0 (+https://cc.matthewpeiper.com)"})
try:
    r=urllib.request.urlopen(req,timeout=15); print(r.status)
except urllib.error.HTTPError as e: print(e.code)
except Exception: print("ERR")
PY
)"

log "post-fix inbound=$post_inbound ingest=$ingest_status"
# ingest 200 writes a real attachment row+R2 object — clean it up
if [ "$ingest_status" = "200" ]; then
  log "cleaning ingest probe artifact"
  npx --yes wrangler d1 execute "${SITE}-db" --remote \
    --command "DELETE FROM support_attachments WHERE ticket_id='reconcile-probe-tid'" >/dev/null 2>&1 || true
  # R2 object id is random; sweep the probe prefix
  for k in $(npx --yes wrangler r2 object list "${SITE}-support-uploads" --prefix "support/reconcile-probe-tid/" 2>/dev/null | grep -oE 'support/reconcile-probe-tid/[^ ]+' || true); do
    npx --yes wrangler r2 object delete "${SITE}-support-uploads/$k" >/dev/null 2>&1 || true
  done
fi

if [ "$post_inbound" = "400" ] && { [ "$ingest_status" = "200" ] || [ "$ingest_status" = "404" ]; }; then
  log "SUCCESS: Worker aligned to hub; both push + ingest signatures verify"
  exit 0
fi
log "WARN: verification incomplete (inbound=$post_inbound ingest=$ingest_status) — investigate"
exit 1
