# Google Cloud Functions: 3CX to Sangoma SMS Middleware

This code is specifically formatted for deployment as two separate **Google Cloud Functions** (Node.js runtime). It acts as a middleware to translate webhook payloads between Sangoma (VoIP Innovations) Wholesale SMS APIs and the 3CX Generic SMS webhook format.

Unlike the local Express version, this code does not start a local webserver. Instead, Google Cloud Functions dynamically provisions a server and calls the exported functions (`inboundSangomaTo3cx` and `outbound3cxToSangoma`) when a webhook is received.

## Prerequisites

1.  A Google Cloud Platform (GCP) account with Billing enabled.
2.  Your Sangoma API Key and API Secret (from the VoIP Innovations portal).
3.  A 3CX instance (v18 U7+) with a Generic SMS Provider configured.

---

## Deployment Instructions

You will deploy **two** separate Google Cloud Functions using this exact same source code folder.

### 1. Deploying the Inbound Function (Sangoma to 3CX)
This function handles incoming texts sent to your registered Sangoma DID and forwards them to your 3CX client.

1.  Log in to the **Google Cloud Console** -> **Cloud Functions**.
2.  Click **Create Function**.
    *   **Environment:** 2nd gen recommended (1st gen also works).
    *   **Function name:** `3cx-sms-inbound`
    *   **Trigger:** HTTP (Check "Allow unauthenticated invocations").
        > *Copy the generated trigger URL at this step! You will need to put this in your Sangoma DID settings.*
3.  Click Next (to the code editor section).
    *   **Runtime:** Node.js 18 or 20.
    *   **Entry point:** `inboundSangomaTo3cx` *(This is extremely important. It must match exactly)*
    *   **Source code:** Copy the contents of this folder's `index.js` and `package.json` into the respective tabs in the inline editor.
4.  Configure **Environment Variables**:
    *   Go to Runtime settings -> Connections and Security -> **Security and Image**.
    *   Add a new environment variable:
        *   **Name:** `THREECX_WEBHOOK_URL`
        *   **Value:** Paste the *Incoming Webhook URL* provided by your 3CX Management Console (under SIP Trunks -> Your Sangoma Trunk -> SMS tab).
5.  Click **Deploy**.

### 2. Deploying the Outbound Function (3CX to Sangoma)
This function handles outbound texts sent by a user from the 3CX WebClient or mobile app and forwards them to the Sangoma API to send.

1.  Go back to the Google Cloud Functions dashboard and click **Create Function** again.
2.  Configure Function:
    *   **Function name:** `3cx-sms-outbound`
    *   **Trigger:** HTTP (Check "Allow unauthenticated invocations").
        > *Copy the generated trigger URL at this step! You will need to put this in your 3CX SMS settings as the Webhook URL.*
3.  Click Next (to the code editor section).
    *   **Runtime:** Node.js 18 or 20.
    *   **Entry point:** `outbound3cxToSangoma` *(This is extremely important. It must match exactly)*
    *   **Source code:** Paste the exact same `index.js` and `package.json` contents as before.
4.  Configure **Environment Variables**:
    *   Go to Runtime settings -> Environment variables.
    *   Add the following two variables:
        *   **Name:** `SANGOMA_API_KEY` | **Value:** *Your Sangoma API Key*
        *   **Name:** `SANGOMA_API_SECRET` | **Value:** *Your Sangoma API Secret*
5.  Click **Deploy**.

---

## Final Configuration Links

Now that the functions are running, tie them to the services:

1.  **In 3CX:** Go to your Sangoma SIP Trunk -> SMS Tab. Ensure Provider is **Generic**. Paste the trigger URL of your newly deployed `3cx-sms-outbound` function into the "Webhook URL" field.
2.  **In Sangoma Back Office:** Go to your specific DID -> SMS Settings. Set destination type to **API POST**. Paste the trigger URL of your newly deployed `3cx-sms-inbound` function.

## Troubleshooting
If messages aren't arriving, check the **Logs explorer** inside Google Cloud for the respective deployed function. The code includes `console.log()` statements that will print the exact JSON payload being received from 3CX or Sangoma, making it easy to see if a variable needs adjusting.
