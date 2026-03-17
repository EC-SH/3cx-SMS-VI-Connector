const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// --- Configuration ---
const SANGOMA_API_KEY    = process.env.SANGOMA_API_KEY;
const SANGOMA_API_SECRET = process.env.SANGOMA_API_SECRET;
const THREECX_WEBHOOK_URL = process.env.THREECX_WEBHOOK_URL;
const PORT = process.env.PORT || 8080;
// ---------------------

// Helper: ensure E.164 format, handles 10/11-digit US numbers and array inputs
const formatE164 = (num) => {
    if (Array.isArray(num)) num = num[0];
    if (!num) return '';
    num = String(num).trim().replace(/\D/g, ''); // strip non-digits
    if (num.length === 10) num = '1' + num;       // assume US, prepend country code
    return '+' + num;
};

/**
 * 1. INBOUND: Sangoma -> 3CX
 * Sangoma POSTs here when an SMS arrives on your DID.
 * Sangoma uses non-standard field names: caller_id_number, destination_number
 */
app.post('/inbound', async (req, res) => {
    try {
        console.log('--- Received Inbound SMS from Sangoma ---');
        console.log('Payload:', JSON.stringify(req.body, null, 2));

        const sangomaBody = req.body;

        // Sangoma sends caller_id_number and destination_number (NOT from/to)
        const fromNumber  = formatE164(sangomaBody.caller_id_number);
        const toNumber    = formatE164(sangomaBody.destination_number);
        const messageText = sangomaBody.text || '';
        const messageId   = sangomaBody.id || `msg-${Date.now()}`;

        if (!fromNumber || !toNumber) {
            console.error('ERROR: Missing caller_id_number or destination_number in Sangoma payload.');
            return res.status(200).send('Missing fields'); // 200 to suppress Sangoma retries
        }

        if (!THREECX_WEBHOOK_URL) {
            console.error('ERROR: THREECX_WEBHOOK_URL is not set.');
            return res.status(200).send('Missing 3CX Webhook config');
        }

        // 3CX Generic SMS requires full Telnyx-style nested envelope
        const threeCxPayload = {
            data: {
                id: messageId,
                event_type: "message.received",
                occurred_at: new Date().toISOString(),
                record_type: "event",
                payload: {
                    direction: "inbound",
                    type: "SMS",
                    record_type: "message",
                    received_at: new Date().toISOString(),
                    text: messageText,
                    from: {
                        phone_number: fromNumber,
                        status: "webhook_delivered"
                    },
                    to: [
                        {
                            phone_number: toNumber,
                            status: "webhook_delivered"
                        }
                    ]
                }
            }
        };

        console.log('Sending to 3CX:', JSON.stringify(threeCxPayload, null, 2));

        const cxResponse = await axios.post(THREECX_WEBHOOK_URL, threeCxPayload, {
            headers: { 'Content-Type': 'application/json' }
        });

        console.log('3CX Response Status:', cxResponse.status);
        res.status(200).send('OK');

    } catch (error) {
        console.error('Error forwarding to 3CX:', error.message);
        res.status(200).send('Error processed'); // 200 to suppress Sangoma retries
    }
});

/**
 * 2. OUTBOUND: 3CX -> Sangoma
 * 3CX POSTs here when a user sends an SMS from the 3CX app.
 * APIdaze requires bare 11-digit numbers (no + prefix).
 */
app.post('/outbound', async (req, res) => {
    try {
        console.log('--- Received Outbound SMS from 3CX ---');
        console.log('Payload:', JSON.stringify(req.body, null, 2));

        const cxBody = req.body;

        const fromNumber  = formatE164(cxBody.from);
        const toNumber    = formatE164(cxBody.to);
        const messageText = cxBody.text || cxBody.body || '';

        if (!fromNumber || !toNumber || !messageText) {
            console.error('ERROR: Missing from, to, or text in 3CX payload.');
            return res.status(400).send('Missing required fields');
        }

        if (!SANGOMA_API_KEY || !SANGOMA_API_SECRET) {
            console.error('ERROR: Sangoma API credentials are not set.');
            return res.status(500).send('Server configuration error');
        }

        const sangomaUrl = `https://api.apidaze.io/${SANGOMA_API_KEY}/sms/send?api_secret=${SANGOMA_API_SECRET}`;

        // APIdaze rejects E.164 + prefix — strip it for both from and to
        const sangomaPayload = {
            to:          toNumber.replace('+', ''),
            from:        fromNumber.replace('+', ''),
            body:        messageText,
            num_retries: 3
        };

        console.log('Sending to Sangoma API:', JSON.stringify(sangomaPayload, null, 2));

        const sangomaResponse = await axios.post(sangomaUrl, sangomaPayload, {
            headers: { 'Content-Type': 'application/json' }
        });

        console.log('Sangoma API Response Status:', sangomaResponse.status);
        res.status(200).send('OK');

    } catch (error) {
        console.error('Error forwarding to Sangoma:', error.message);
        if (error.response) {
            console.error('Sangoma error response:', JSON.stringify(error.response.data));
        }
        res.status(500).send('Failed to send SMS');
    }
});

// Health check
app.get('/', (req, res) => res.send('3CX-Sangoma SMS Middleware is running.'));

app.listen(PORT, () => {
    console.log(`Middleware listening on port ${PORT}`);
    console.log(`Inbound:  POST /inbound`);
    console.log(`Outbound: POST /outbound`);
});
