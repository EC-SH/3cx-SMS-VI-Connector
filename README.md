# 3CX SMS ↔ VoIP Innovations Connector

A lightweight translation middleware that bridges **3CX Generic SMS** and the **Sangoma/VoIP Innovations APIdaze SMS API**. Deployed as two Google Cloud Run services, it translates incompatible webhook formats between the two platforms in both directions.

---

## The Problem

3CX Generic SMS provider uses a **Telnyx-style nested JSON envelope** for inbound webhooks. VoIP Innovations (APIdaze) uses a **flat, non-standard payload** with different field names and number formatting. Neither platform speaks the other's format natively, making direct integration impossible.

---

## Architecture

```
INBOUND:  Cell Phone → Sangoma DID → GCF (inbound) → 3CX Webhook
OUTBOUND: 3CX → GCF (outbound) → Sangoma APIdaze API → Cell Phone
```

Two separate Cloud Run services handle each direction:

| Service | Entry Point | Trigger |
|---|---|---|
| `threecx-sms-inbound` | `POST /inbound` | Sangoma webhook on DID |
| `threecx-sms-outbound` | `POST /outbound` | 3CX Generic SMS provider |

---

## Format Translation

### Inbound (Sangoma → 3CX)

Sangoma sends:
```json
{
  "type": "incomingWebhookSMS",
  "caller_id_number": "13057673260",
  "destination_number": "13052314933",
  "text": "Hello"
}
```

Translated to 3CX Generic SMS envelope:
```json
{
  "data": {
    "id": "msg-...",
    "event_type": "message.received",
    "occurred_at": "...",
    "record_type": "event",
    "payload": {
      "direction": "inbound",
      "type": "SMS",
      "record_type": "message",
      "received_at": "...",
      "text": "Hello",
      "from": { "phone_number": "+13057673260", "status": "webhook_delivered" },
      "to": [{ "phone_number": "+13052314933", "status": "webhook_delivered" }]
    }
  }
}
```

### Outbound (3CX → Sangoma)

3CX sends:
```json
{ "from": "+13052314933", "to": "+13057673260", "text": "Hello" }
```

Translated to APIdaze API call:
```json
{ "from": "13052314933", "to": "13057673260", "body": "Hello", "num_retries": 3 }
```

> **Note:** APIdaze rejects E.164 `+` prefix on `from`/`to`. Numbers must be bare 11-digit strings.

---

## Deployment

### Prerequisites

- Google Cloud project with Cloud Run enabled
- Sangoma/VoIP Innovations account with APIdaze API credentials
- 3CX instance (v18 U7+) with a Generic SMS provider configured
- 10DLC campaign approved in VoIP Innovations portal (required for outbound delivery)

### Deploy Inbound Service

```bash
gcloud run deploy threecx-sms-inbound \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars THREECX_WEBHOOK_URL=https://your-3cx-instance/sms/generic/webhook
```

Copy the generated Cloud Run URL. Set it as the webhook destination in your Sangoma DID settings (SMS → API POST).

### Deploy Outbound Service

```bash
gcloud run deploy threecx-sms-outbound \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars SANGOMA_API_KEY=your_key,SANGOMA_API_SECRET=your_secret
```

Copy the generated Cloud Run URL. Set it as the **Provider URL** in 3CX under Voice & Chat → your trunk → SMS tab.

---

## Environment Variables

| Variable | Service | Description |
|---|---|---|
| `THREECX_WEBHOOK_URL` | Inbound | Inbound webhook URL from 3CX SMS tab |
| `SANGOMA_API_KEY` | Outbound | APIdaze API key from VoIP Innovations portal |
| `SANGOMA_API_SECRET` | Outbound | APIdaze API secret from VoIP Innovations portal |

> **Security:** For production use, store credentials in [GCP Secret Manager](https://cloud.google.com/secret-manager) and reference them as environment variables rather than storing plaintext values.

---

## 3CX Configuration

1. Go to **Voice & Chat** → your SIP trunk → **SMS** tab
2. Set provider to **Generic**
3. Set **Provider URL** to your `threecx-sms-outbound` Cloud Run URL
4. Copy the **Webhook URL** shown — this is your `THREECX_WEBHOOK_URL`

## Sangoma Configuration

1. Log into VoIP Innovations back office → **DIDs** → your DID
2. Set SMS destination type to **API POST**
3. Set webhook URL to your `threecx-sms-inbound` Cloud Run URL

---

## 10DLC Requirement

Outbound SMS will be accepted by the API but **silently dropped by carriers** until a 10DLC campaign is approved in the VoIP Innovations portal. Submit a campaign under **SMS → Campaigns/Use Cases** before expecting outbound delivery to complete.

---

## Local Development

```bash
npm install
cp .env.example .env   # fill in your credentials
node index.js
```

Endpoints:
- `POST /inbound` — simulate a Sangoma webhook
- `POST /outbound` — simulate a 3CX outbound SMS
- `GET /` — health check

---

## License

MIT
