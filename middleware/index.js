const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json()); // Parse JSON bodies

// --- Configuration ---
// Read variables from process.env (or a .env file if using dotenv)
const SANGOMA_API_KEY = process.env.SANGOMA_API_KEY;
const SANGOMA_API_SECRET = process.env.SANGOMA_API_SECRET;
const THREECX_WEBHOOK_URL = process.env.THREECX_WEBHOOK_URL;
const PORT = process.env.PORT || 8080;
// ---------------------

/**
 * 1. INBOUND: Sangoma -> 3CX
 * Sangoma sends a POST request here when an SMS arrives on your DID.
 */
app.post('/inbound', async (req, res) => {
    try {
        console.log('--- Received Inbound SMS from Sangoma ---');
        console.log('Payload:', JSON.stringify(req.body, null, 2));
        
        const sangomaBody = req.body;
        
        // Extract fields. Note: verify exact payload structure from Sangoma.
        const fromNumber = sangomaBody.from; 
        const toNumber = sangomaBody.to;
        const messageText = sangomaBody.body || sangomaBody.text || '';
        const messageId = sangomaBody.id || `msg-${Date.now()}`;

        // Ensure E.164 format (Add '+' if missing)
        const formatE164 = (num) => (num && !num.startsWith('+') ? `+${num}` : num);

        // Construct 3CX Expected Payload (Generic SMS Provider format)
        const threeCxPayload = {
            "data": {
                "id": messageId,
                "event_type": "message.received",
                "occurred_at": new Date().toISOString(),
                "payload": {
                    "direction": "inbound",
                    "from": {
                        "phone_number": formatE164(fromNumber),
                        "status": "webhook_delivered"
                    },
                    "to": [
                        {
                            "phone_number": formatE164(toNumber),
                            "status": "webhook_delivered"
                        }
                    ],
                    "text": messageText,
                    "type": "SMS",
                    "record_type": "message",
                    "received_at": new Date().toISOString()
                },
                "record_type": "event"
            }
        };

        console.log('Translating to 3CX Format:', JSON.stringify(threeCxPayload, null, 2));

        if (!THREECX_WEBHOOK_URL) {
            console.error('ERROR: THREECX_WEBHOOK_URL is not set in the environment variables.');
            return res.status(200).send('Missing 3CX Webhook config'); // Still 200 so Sangoma doesn't retry
        }

        // Send to 3CX
        const cxResponse = await axios.post(THREECX_WEBHOOK_URL, threeCxPayload, {
            headers: { 'Content-Type': 'application/json' }
        });

        console.log('3CX Response Status:', cxResponse.status);
        res.status(200).send('OK');

    } catch (error) {
        console.error('Error forwarding to 3CX:', error.message);
        res.status(200).send('Error processed'); // 200 to prevent Sangoma from retrying
    }
});

/**
 * 2. OUTBOUND: 3CX -> Sangoma
 * 3CX sends a POST request here when a user sends an SMS from the 3CX app.
 */
app.post('/outbound', async (req, res) => {
    try {
        console.log('--- Received Outbound SMS from 3CX ---');
        console.log('Payload:', JSON.stringify(req.body, null, 2));

        const cxBody = req.body;
        
        // 3CX Outbound Payload structure
        const fromNumber = cxBody.from;   // E.g. +19542223333
        const toNumber = cxBody.to;       // E.g. +15551234567
        const messageText = cxBody.text;

        if (!SANGOMA_API_KEY || !SANGOMA_API_SECRET) {
            console.error('ERROR: Sangoma API credentials are not set.');
            return res.status(500).send('Server configuration error');
        }

        // Construct Sangoma API URL (Apidaze)
        const sangomaUrl = `https://api.apidaze.io/${SANGOMA_API_KEY}/sms/send?api_secret=${SANGOMA_API_SECRET}`;

        // Construct Sangoma Payload
        const sangomaPayload = {
            to: toNumber,
            from: fromNumber,
            body: messageText,
            num_retries: 3
        };

        console.log('Translating to Sangoma Format:', JSON.stringify(sangomaPayload, null, 2));
        
        // Send to Sangoma API
        const sangomaResponse = await axios.post(sangomaUrl, sangomaPayload, {
            headers: { 'Content-Type': 'application/json' }
        });

        console.log('Sangoma API Response Status:', sangomaResponse.status);

        // 3CX expects a 200 OK
        res.status(200).send('OK');

    } catch (error) {
        console.error('Error forwarding to Sangoma:', error.message);
        res.status(500).send('Failed to send SMS');
    }
});

// Health check endpoint
app.get('/', (req, res) => res.send('3CX-Sangoma SMS Middleware is running.'));

// Start server
app.listen(PORT, () => {
    console.log(`Middleware listening on port ${PORT}`);
    console.log(`Inbound expected at: POST /inbound`);
    console.log(`Outbound expected at: POST /outbound`);
});
