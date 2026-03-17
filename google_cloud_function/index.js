const axios = require('axios');

// Helper: ensure E.164 format, handles 10/11-digit US numbers and array inputs
const formatE164 = (num) => {
    if (Array.isArray(num)) num = num[0];
    if (!num) return '';
    num = String(num).trim().replace(/\D/g, ''); // strip non-digits
    if (num.length === 10) num = '1' + num;       // assume US, prepend country code
    return '+' + num;
};

// 1. INBOUND: Sangoma (VoIP Innovations) -> 3CX
exports.inboundSangomaTo3cx = async (req, res) => {
    try {
        console.log('--- Received Inbound SMS from Sangoma ---');
        console.log('Payload:', JSON.stringify(req.body));

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

        // 3CX Generic SMS expects the full Telnyx-style nested envelope
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

        const threeCxWebhookUrl = process.env.THREECX_WEBHOOK_URL;

        if (!threeCxWebhookUrl) {
            console.error('ERROR: THREECX_WEBHOOK_URL environment variable is missing.');
            return res.status(200).send('Missing 3CX Webhook config');
        }

        console.log('Sending to 3CX:', JSON.stringify(threeCxPayload));

        const cxResponse = await axios.post(threeCxWebhookUrl, threeCxPayload, {
            headers: { 'Content-Type': 'application/json' }
        });

        console.log('3CX Response Status:', cxResponse.status);
        res.status(200).send('OK');

    } catch (error) {
        console.error('Error forwarding to 3CX:', error.message);
        res.status(200).send('Error processed'); // 200 to suppress Sangoma retries
    }
};

// 2. OUTBOUND: 3CX -> Sangoma (VoIP Innovations)
exports.outbound3cxToSangoma = async (req, res) => {
    try {
        console.log('--- Received Outbound SMS from 3CX ---');
        console.log('Payload:', JSON.stringify(req.body));

        const cxBody = req.body;

        const fromNumber  = formatE164(cxBody.from);
        const toNumber    = formatE164(cxBody.to);
        const messageText = cxBody.text || cxBody.body || '';

        if (!fromNumber || !toNumber || !messageText) {
            console.error('ERROR: Missing from, to, or text in 3CX payload.');
            return res.status(400).send('Missing required fields');
        }

        const sangomaApiKey    = process.env.SANGOMA_API_KEY;
        const sangomaApiSecret = process.env.SANGOMA_API_SECRET;

        if (!sangomaApiKey || !sangomaApiSecret) {
            console.error('ERROR: Sangoma API credentials missing.');
            return res.status(500).send('Server configuration error');
        }

        const sangomaUrl = `https://api.apidaze.io/${sangomaApiKey}/sms/send?api_secret=${sangomaApiSecret}`;

        // Sangoma wants bare 11-digit numbers, no + prefix
        const sangomaPayload = {
            to:          toNumber.replace('+', ''),
            from:        fromNumber.replace('+', ''),
            body:        messageText,
            num_retries: 3
        };

        console.log('Sending to Sangoma API:', JSON.stringify(sangomaPayload));

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
};
