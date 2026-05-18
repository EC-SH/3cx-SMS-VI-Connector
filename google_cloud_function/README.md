# 3CX SMS ↔ VoIP Innovations Connector

Translation middleware bridging **3CX Generic SMS** and the **VoIP Innovations
(APIdaze) SMS API**. 3CX uses a Telnyx-style nested JSON envelope; APIdaze uses
a flat, non-standard payload with different field names and number formatting.
Neither speaks the other natively. This connector translates both directions.

One codebase. Deployed as two Cloud Run services.

---

## Why two services from one codebase

The code for both directions lives in one `index.js`, deployed twice. This is
deliberate, and the two halves of the decision are separate:

- **One codebase** — because four divergent copies of one translator is how the
  previous version rotted: the field names, retry counts, and number-formatting
  logic had already drifted apart across copies. Single source, no drift.
- **Two deployed services** — because inbound and outbound hold *different
  secrets*. Only the outbound service carries the Sangoma API credential. The
  inbound service is irreducibly public (a third party POSTs to it from the open
  internet); keeping the money-spending credential out of its environment means
  a compromise of that surface can't leak it.

`SERVICE_ROLE` (`inbound` | `outbound`) selects which side a process runs:
which config it validates at boot, which route it mounts. Wrong or missing role
is a startup crash.

```
INBOUND:  Cell → Sangoma DID → threecx-sms-inbound  → 3CX webhook
OUTBOUND: 3CX  → threecx-sms-outbound → APIdaze API → Cell
```

---

## Security model — read this

Both services sit on the public internet. 3CX's Generic SMS provider and
Sangoma's DID webhooks both call in from outside any VPC and cannot present a
GCP identity token, so Cloud Run IAM auth is not an option here. Auth is at the
application layer.

**Outbound is the service that matters** — it sends SMS, so an open endpoint is
a direct toll-fraud and 10DLC-reputation risk. It has two layers:

1. **Secret path.** The handler is mounted on `/outbound/<OUTBOUND_PATH_SECRET>`.
   Any other path is a router 404 — an attacker scanning the `run.app`
   namespace reaches no handler and gets no signal.
2. **Shared secret.** Every request must carry `X-Auth-Token` matching
   `OUTBOUND_SHARED_SECRET`. Constant-time compared; rejection is a bare 401.

> **Assumption you must verify.** Layer 2 requires 3CX's Generic SMS provider to
> send a static custom header on the outbound webhook. Confirm this in the 3CX
> SMS tab *before* relying on it. See **Fallback** below if it can't.

**Inbound** carries one layer — a secret path (`/inbound/<INBOUND_PATH_SECRET>`).
It's intentionally lighter: the worst case for a forged inbound webhook is an
injected fake text in a user's 3CX conversation (a phishing vector worth
closing cheaply), not spend. Sangoma's webhook config can't reliably send a
custom header, so a header layer isn't available on this side anyway.

### Fallback: if 3CX can't send a custom header

Then layer 2 is unavailable from 3CX's side. Options, in order of preference:
make `OUTBOUND_PATH_SECRET` long and high-entropy and treat the path as the sole
credential; put a lightweight authenticating proxy in front of the outbound
service; or, if 3CX supports signing the webhook body, switch the handler from
the static-header check to HMAC verification (strictly stronger — a static
header leaks if any intermediary logs the request). Either way, **set a spend
cap** (below) — auth limits exposure, the cap floors the cost if auth fails.

---

## Failure handling

Misconfiguration and bad input are different failure classes and are handled
differently:

- **Missing config crashes the process at boot.** A connector serving traffic
  without its config is worse than one that's down — it drops messages silently.
- **Inbound, bad input** (malformed Sangoma payload) → **200**. It will never
  become valid on retry; a 4xx just produces identical failures forever.
- **Inbound, transient downstream failure** (3CX unreachable / 5xx) → **503**,
  so Sangoma retries. Returning 200 here — the original bug — turned every blip
  or config typo into permanent silent message loss.
- **Outbound, bad input** → **400**. **Transient Sangoma failure** → **503** so
  3CX retries. **Auth failure** → **401**.

---

## Secrets

Create these in Secret Manager once. `deploy.ps1` references them by name.

```bash
# generate path/shared secrets with: openssl rand -hex 24
printf 'VALUE' | gcloud secrets create threecx-webhook-url            --data-file=-
printf 'VALUE' | gcloud secrets create threecx-inbound-path-secret    --data-file=-
printf 'VALUE' | gcloud secrets create sangoma-api-key                --data-file=-
printf 'VALUE' | gcloud secrets create sangoma-api-secret             --data-file=-
printf 'VALUE' | gcloud secrets create threecx-outbound-path-secret   --data-file=-
printf 'VALUE' | gcloud secrets create threecx-outbound-shared-secret --data-file=-
```

The Cloud Run service account needs `roles/secretmanager.secretAccessor`.

---

## Deploy

Buildpacks build from source — no Dockerfile.

```powershell
./deploy.ps1 -Role inbound
./deploy.ps1 -Role outbound
```

Each run builds, deploys, smoke-tests the health check, and rolls traffic back
to the previous revision if the smoke test fails. Region defaults to
`us-central1`; override with `-Region`.

---

## Wire it up

After deploying, note each service's URL (`gcloud run services describe`).

**3CX** — Voice & Chat → your SIP trunk → SMS tab. Provider: **Generic**.
Provider URL: `https://<outbound-url>/outbound/<OUTBOUND_PATH_SECRET>`. Add the
`X-Auth-Token` header set to `OUTBOUND_SHARED_SECRET` (see Security note above).
Copy the Webhook URL 3CX shows you — that's the value of the
`threecx-webhook-url` secret.

**Sangoma** — VoIP Innovations back office → DIDs → your DID → SMS. Destination
type: **API POST**. URL: `https://<inbound-url>/inbound/<INBOUND_PATH_SECRET>`.

---

## 10DLC and spend cap

Outbound SMS is accepted by the API but **silently dropped by carriers** until a
10DLC campaign is approved in the VoIP Innovations portal (SMS → Campaigns/Use
Cases).

Independently: set a balance or daily-send cap on the VoIP Innovations account.
It's the backstop that fails in dollars instead of thousands of dollars if the
outbound endpoint is ever abused.

---

## Local development

```bash
npm install
cp .env.example .env        # fill in, set SERVICE_ROLE to one side
node --env-file=.env index.js
```

`GET /` is the health check. The active POST route is
`/inbound/<secret>` or `/outbound/<secret>` depending on `SERVICE_ROLE`.

---

## License

MIT
