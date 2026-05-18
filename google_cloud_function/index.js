const express = require('express');
const crypto = require('crypto');

// One codebase, two services. SERVICE_ROLE picks which side this process runs.
// The split is deployment-only: inbound and outbound share a trust boundary
// with neither each other nor the browser, but they DO hold different secrets.
// Keeping the Sangoma credential out of the inbound service's env means a
// compromise of the irreducibly-public inbound surface can't leak it.

const ROLE = process.env.SERVICE_ROLE;
const PORT = process.env.PORT || 8080;

// Structured JSON to stdout — Cloud Run ingests it. No logging framework.
function log(level, msg, ctx = {}) {
  console.log(JSON.stringify({ level, msg, ts: new Date().toISOString(), role: ROLE || 'unset', ...ctx }));
}

// Misconfiguration is a startup crash, not a runtime branch. A connector that
// serves traffic without its config is worse than one that's down: it drops
// messages silently. die() never returns — callers can use it in `x || die()`.
function die(msg) {
  log('fatal', msg);
  process.exit(1);
}

if (ROLE !== 'inbound' && ROLE !== 'outbound') {
  die(`SERVICE_ROLE must be 'inbound' or 'outbound', got '${ROLE}'. Cannot start.`);
}

// Each role validates ONLY the config it needs. The inbound service never sees
// SANGOMA_* — that's the credential isolation the two-service split buys.
const cfg = {};
if (ROLE === 'inbound') {
  cfg.threecxWebhookUrl = process.env.THREECX_WEBHOOK_URL || die('THREECX_WEBHOOK_URL not set');
  cfg.inboundPathSecret = process.env.INBOUND_PATH_SECRET || die('INBOUND_PATH_SECRET not set');
} else {
  cfg.sangomaApiKey        = process.env.SANGOMA_API_KEY        || die('SANGOMA_API_KEY not set');
  cfg.sangomaApiSecret     = process.env.SANGOMA_API_SECRET     || die('SANGOMA_API_SECRET not set');
  cfg.outboundPathSecret   = process.env.OUTBOUND_PATH_SECRET   || die('OUTBOUND_PATH_SECRET not set');
  cfg.outboundSharedSecret = process.env.OUTBOUND_SHARED_SECRET || die('OUTBOUND_SHARED_SECRET not set');
}

// --- helpers ---------------------------------------------------------------

// US-centric E.164 normalizer. Returns '' on anything it can't confidently
// normalize — caller treats '' as bad input. Stricter than a blind '+' prepend:
// junk in, '' out, not '+garbage' out.
function toE164(raw) {
  if (Array.isArray(raw)) raw = raw[0];
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '';
}

// Reuse an upstream correlation ID if present, else mint one. Propagated on
// outgoing calls so a message is traceable across both services in Logs.
function correlationId(req) {
  return req.get('x-correlation-id') || crypto.randomUUID();
}

// Constant-time secret compare. SHA-256 both sides first: fixes the length to
// 32 bytes so timingSafeEqual won't throw on mismatched sizes and the compare
// doesn't leak length.
function secretMatches(provided, expected) {
  if (!provided) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// --- inbound: Sangoma (APIdaze) -> 3CX -------------------------------------

async function handleInbound(req, res) {
  const cid = correlationId(req);
  const body = req.body || {};
  log('info', 'inbound webhook received', { cid, from: body.caller_id_number, to: body.destination_number });

  // Sangoma uses caller_id_number / destination_number, not from/to.
  const from = toE164(body.caller_id_number);
  const to = toE164(body.destination_number);
  const text = typeof body.text === 'string' ? body.text : '';

  // BAD INPUT. A malformed Sangoma payload never becomes well-formed on retry,
  // so return 200 to stop Sangoma retrying — a 4xx just yields an identical
  // failure on every attempt. This is a different failure class from the
  // transient downstream failure below; do not merge the two.
  if (!from || !to) {
    log('error', 'inbound payload missing/invalid numbers — dropping, no retry', { cid });
    return res.status(200).send('bad payload');
  }

  // 3CX Generic SMS expects the full Telnyx-style nested envelope.
  const threecxPayload = {
    data: {
      id: body.id || `msg-${Date.now()}`,
      event_type: 'message.received',
      occurred_at: new Date().toISOString(),
      record_type: 'event',
      payload: {
        direction: 'inbound',
        type: 'SMS',
        record_type: 'message',
        received_at: new Date().toISOString(),
        text,
        from: { phone_number: from, status: 'webhook_delivered' },
        to: [{ phone_number: to, status: 'webhook_delivered' }],
      },
    },
  };

  // TRANSIENT FAILURE. 3CX unreachable or 5xx CAN succeed on retry — return 503
  // so Sangoma retries. Returning 200 here (the original bug) turns every blip
  // or config typo into permanent silent message loss.
  try {
    const r = await fetch(cfg.threecxWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': cid },
      body: JSON.stringify(threecxPayload),
      signal: AbortSignal.timeout(10000),
    });
    log('info', 'forwarded to 3cx', { cid, status: r.status });
    if (!r.ok) return res.status(503).send('3cx rejected — retry');
    return res.status(200).send('ok');
  } catch (err) {
    log('error', 'failed to reach 3cx', { cid, err: err.message });
    return res.status(503).send('3cx unreachable — retry');
  }
}

// --- outbound: 3CX -> Sangoma (APIdaze) ------------------------------------

async function handleOutbound(req, res) {
  const cid = correlationId(req);

  // Auth layer 2: shared secret in a header. Layer 1 is the secret path this
  // route is mounted on — any other path is a router 404 the handler never
  // sees. Bare 401, no body: don't distinguish wrong-secret from no-secret.
  //
  // ASSUMPTION TO VERIFY: this requires 3CX's Generic SMS provider to send a
  // static custom header (X-Auth-Token) on the outbound webhook. Confirm in
  // the 3CX SMS tab. If 3CX can't send custom headers, see README "Fallback".
  // A signed-body HMAC would be strictly stronger than a static header (a
  // static header leaks if any intermediary logs it) — use it if 3CX offers it.
  if (!secretMatches(req.get('x-auth-token'), cfg.outboundSharedSecret)) {
    log('warn', 'outbound auth rejected', { cid });
    return res.status(401).end();
  }

  const body = req.body || {};
  const from = toE164(body.from);
  const to = toE164(body.to);
  const text = (typeof body.text === 'string' && body.text) ||
               (typeof body.body === 'string' && body.body) || '';
  // Log numbers (needed to debug routing) and text length, never text content.
  log('info', 'outbound webhook received', { cid, from, to, textLength: text.length });

  // BAD INPUT from 3CX -> 400. 3CX is our own system; an honest 400 is fine.
  if (!from || !to || !text) {
    log('error', 'outbound payload missing from/to/text', { cid });
    return res.status(400).send('missing from, to, or text');
  }

  // APIdaze rejects the E.164 '+' on from/to — bare 11-digit only.
  const sangomaPayload = {
    from: from.replace('+', ''),
    to: to.replace('+', ''),
    body: text,
    num_retries: 3,
  };
  // api_secret rides in the query string — never log this URL.
  const url = `https://api.apidaze.io/${cfg.sangomaApiKey}/sms/send?api_secret=${cfg.sangomaApiSecret}`;

  // TRANSIENT FAILURE -> 503 so 3CX retries.
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sangomaPayload),
      signal: AbortSignal.timeout(10000),
    });
    const detail = await r.text();
    log('info', 'forwarded to sangoma', { cid, status: r.status });
    if (!r.ok) {
      log('error', 'sangoma rejected send', { cid, status: r.status, detail: detail.slice(0, 500) });
      return res.status(503).send('sangoma rejected — retry');
    }
    return res.status(200).send('ok');
  } catch (err) {
    log('error', 'failed to reach sangoma', { cid, err: err.message });
    return res.status(503).send('sangoma unreachable — retry');
  }
}

// --- wiring ----------------------------------------------------------------

const app = express();
app.use(express.json()); // malformed JSON -> Express 400, which is correct: bad input.

app.get('/', (req, res) => res.status(200).send(`ok — ${ROLE}`));

if (ROLE === 'inbound') {
  app.post(`/inbound/${cfg.inboundPathSecret}`, handleInbound);
} else {
  app.post(`/outbound/${cfg.outboundPathSecret}`, handleOutbound);
}

app.listen(PORT, () => log('info', 'connector up', { port: PORT }));
