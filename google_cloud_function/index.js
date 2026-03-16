const axios = require('axios');

// --- Configuration Variables ---
// These should be configured in the Google Cloud Console under Environment Variables
// for each respective cloud function.

// 1. INBOUND: Sangoma -> 3CX
// Exported as an entry point for Google Cloud Functions
exports.inboundSangomaTo3cx = async (req, res) => {
    try {
        console.log('--- Received Inbound SMS from Sangoma ---');
        console.log('Payload:', JSON.stringify(req.body));
        
        const sangomaBody = req.body;
        
        // Extract fields
        const fromNumber = sangomaBody.from; 
        const toNumber = sangomaBody.to;
        const messageText = sangomaBody.body || sangomaBody.text || '';
        const messageId = sangomaBody.id || `msg-${Date.now()}`;

        // Ensure E.164 format (Add '+' if missing)
        const formatE164 = (num) => (num && !num.startsWith('+') ? `+${num}` : num);

        // Construct 3CX Expected Payload
        const threeCxPayload = {
            "data": {
                "id": messageId,
                "event_type": "message.received",
                "payload": {
                    "from": {
                        "phone_number": formatE164(fromNumber)
                    },
                    "to": {
                        "phone_number": formatE164(toNumber)
                    },
                    "text": messageText,
                    "received_at": new Date().toISOString()
                }
            }
        };

        const threeCxWebhookUrl = process.env.THREECX_WEBHOOK_URL;
        
        if (!threeCxWebhookUrl) {
            console.error('ERROR: THREECX_WEBHOOK_URL environment variable is missing.');
            return res.status(200).send('Missing 3CX Webhook config'); // Returning 200 to Sangoma to prevent repeating webhook retry attempts
        }

        console.log('Sending JSON Payload to 3CX:', JSON.stringify(threeCxPayload));

        // Send to 3CX
        const cxResponse = await axios.post(threeCxWebhookUrl, threeCxPayload, {
            headers: { 'Content-Type': 'application/json' }
        });

        console.log('3CX Response Status:', cxResponse.status);
        res.status(200).send('OK');

    } catch (error) {
        console.error('Error forwarding to 3CX:', error.message);
        // We still return 200 so Sangoma doesn't repeatedly retry a failed event mapping
        res.status(200).send('Error processed'); 
    }
};

// 2. OUTBOUND: 3CX -> Sangoma
// Exported as an entry point for Google Cloud Functions
exports.outbound3cxToSangoma = async (req, res) => {
    try {
        console.log('--- Received Outbound SMS from 3CX ---');
        console.log('Payload:', JSON.stringify(req.body));

        const cxBody = req.body;
        
        // Extract 3CX Outbound JSON Webhook structure
        const fromNumber = cxBody.from;   // E.g. +19542223333
        const toNumber = cxBody.to;       // E.g. +15551234567
        const messageText = cxBody.text;

        const sangomaApiKey = process.env.SANGOMA_API_KEY;
        const sangomaApiSecret = process.env.SANGOMA_API_SECRET;

        if (!sangomaApiKey || !sangomaApiSecret) {
            console.error('ERROR: Sangoma API credentials (SANGOMA_API_KEY / SANGOMA_API_SECRET) environment variables are missing.');
            return res.status(500).send('Server configuration error');
        }

        // Construct Sangoma API URL (Apidaze CPaaS endpoint for VoIP Innovations)
        const sangomaUrl = `https://api.apidaze.io/${sangomaApiKey}/sms/send?api_secret=${sangomaApiSecret}`;

        // Construct Sangoma Payload
        const sangomaPayload = {
            to: toNumber,
            from: fromNumber,
            body: messageText,
            num_retries: 3
        };

        console.log('Sending JSON Payload to Sangoma API:', JSON.stringify(sangomaPayload));
        
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
};
