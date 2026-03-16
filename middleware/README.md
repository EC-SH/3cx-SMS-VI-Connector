# 3CX to Sangoma SMS Middleware

This lightweight Node.js/Express application acts as a two-way translator between Sangoma Wholesale (Apidaze) SMS and the 3CX Generics SMS provider format.

## Setup

1. Make sure Node.js is installed.
2. Open a terminal in this directory and install dependencies:
   ```bash
   npm install
   ```
3. Copy the sample environment file:
   ```bash
   cp .env.example .env
   ```
4. Edit `.env` with your Sangoma credentials and your 3CX incoming webhook URL.

## Running Locally

```bash
npm start
```

The application will listen on port 8080 by default. It exposes two endpoints:

- `POST /inbound`: Translates Sangoma webhooks to 3CX JSON format. Configure your Sangoma DID webhook to point to `your-public-url.com/inbound`.
- `POST /outbound`: Translates 3CX JSON to Sangoma Apidaze API format. Configure your 3CX Outbound Provider Webhook to point to `your-public-url.com/outbound`.

## Deployment

You can test this locally using a tool like **ngrok** to expose your local port 8080 to the public internet, which allows 3CX and Sangoma to reach your laptop for testing:
```bash
ngrok http 8080
```

Once you verify it works, deploy this source folder to any hosting provider (Google Cloud Run, AWS App Runner, Heroku, DigitalOcean App Platform, or a traditional Linux VPS).
