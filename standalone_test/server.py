#!/usr/bin/env python3
"""
3CX to Sangoma SMS Middleware - Standalone Test Script
------------------------------------------------------
WARNING: This is a standalone script meant for quick testing on a local machine 
or temporarily on a 3CX server to validate payloads.
It is NOT recommended to run this permanently as a background service on your 3CX 
Debian server, as it can be killed during OS updates, it lacks robust process 
management out of the box, and relies on built-in HTTP servers rather than a 
production-grade WSGI server (like Gunicorn).

For production, deploy the Google Cloud Functions or the Node.js Express app!
------------------------------------------------------

Usage:
1. Ensure Python 3 is installed: `python3 --version`
2. Install the requests library: `pip3 install requests`
3. Edit the CONFIG variables below with your credentials.
4. Run the script: `python3 server.py`
"""

import os
import json
import logging
import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
import requests

# Set up simple console logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ==========================================
# CONFIGURATION
# Fill in your values below before running!
# ==========================================
CONFIG = {
    "PORT": 8080,
    "SANGOMA_API_KEY": "your_api_key_here",
    "SANGOMA_API_SECRET": "your_api_secret_here",
    "THREECX_WEBHOOK_URL": "https://your-hostname.3cx.us/webhook/your_unique_id"
}

def format_e164(number):
    """Ensure a phone number is in E.164 format (starts with +)"""
    if number and not number.startswith('+'):
        return f"+{number}"
    return number

class SMSMiddlewareHandler(BaseHTTPRequestHandler):
    
    def do_POST(self):
        """Handle incoming POST requests for both endpoints"""
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length).decode('utf-8')
        
        try:
            body = json.loads(post_data) if post_data else {}
        except json.JSONDecodeError:
            logger.error("Failed to parse JSON body")
            self.send_response(400)
            self.end_headers()
            return
            
        if self.path == '/inbound':
            self.handle_inbound(body)
        elif self.path == '/outbound':
            self.handle_outbound(body)
        else:
            self.send_response(404)
            self.end_headers()
            
    def handle_inbound(self, body):
        """Sangoma -> 3CX Translation"""
        logger.info("--- Received Inbound SMS from Sangoma ---")
        logger.info(json.dumps(body, indent=2))
        
        # Extract variables
        from_number = body.get('from', '')
        to_number = body.get('to', '')
        message_text = body.get('body', body.get('text', ''))
        message_id = body.get('id', f"msg-{int(datetime.datetime.now().timestamp())}")
        
        # Build 3CX JSON Payload
        three_cx_payload = {
            "data": {
                "id": message_id,
                "event_type": "message.received",
                "payload": {
                    "from": {"phone_number": format_e164(from_number)},
                    "to": {"phone_number": format_e164(to_number)},
                    "text": message_text,
                    "received_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
                }
            }
        }
        
        logger.info("Translating to 3CX Format:")
        logger.info(json.dumps(three_cx_payload, indent=2))
        
        if not CONFIG["THREECX_WEBHOOK_URL"] or "your_unique_id" in CONFIG["THREECX_WEBHOOK_URL"]:
            logger.error("THREECX_WEBHOOK_URL is not configured properly.")
            self.send_ok_response() # Still return 200 so Sangoma stops retrying
            return
            
        try:
            # Forward to 3CX
            headers = {'Content-Type': 'application/json'}
            response = requests.post(
                CONFIG["THREECX_WEBHOOK_URL"], 
                json=three_cx_payload, 
                headers=headers, 
                timeout=10
            )
            logger.info(f"3CX Webhook Response Status: {response.status_code}")
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to reach 3CX webhook: {e}")
            
        # Always return 200 to Sangoma to avoid retry loops on our end
        self.send_ok_response()
        
    def handle_outbound(self, body):
        """3CX -> Sangoma Translation"""
        logger.info("--- Received Outbound SMS from 3CX ---")
        logger.info(json.dumps(body, indent=2))
        
        # Extract variables
        from_number = body.get('from', '')
        to_number = body.get('to', '')
        message_text = body.get('text', '')
        
        if "your_api_key_here" in CONFIG["SANGOMA_API_KEY"]:
            logger.error("Sangoma API credentials are not configured properly.")
            self.send_error_response(500)
            return
            
        # Build Sangoma Payload
        sangoma_url = f"https://api.apidaze.io/{CONFIG['SANGOMA_API_KEY']}/sms/send?api_secret={CONFIG['SANGOMA_API_SECRET']}"
        sangoma_payload = {
            "to": to_number,
            "from": from_number,
            "body": message_text,
            "num_retries": 1
        }
        
        logger.info("Translating to Sangoma Format:")
        logger.info(json.dumps(sangoma_payload, indent=2))
        
        try:
            # Forward to Sangoma API
            headers = {'Content-Type': 'application/json'}
            response = requests.post(
                sangoma_url, 
                json=sangoma_payload, 
                headers=headers, 
                timeout=10
            )
            logger.info(f"Sangoma API Response Status: {response.status_code}")
            if response.status_code != 200:
                logger.error(f"Sangoma Error Details: {response.text}")
                
            self.send_ok_response()
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to reach Sangoma API: {e}")
            self.send_error_response(500)

    def send_ok_response(self):
        """Helper to send a standard 200 OK response"""
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(b"OK")
        
    def send_error_response(self, code):
        """Helper to send detailed error responses"""
        self.send_response(code)
        self.end_headers()

def run_server():
    server_address = ('', CONFIG["PORT"])
    httpd = HTTPServer(server_address, SMSMiddlewareHandler)
    logger.info(f"Starting Standalone Python Middleware on port {CONFIG['PORT']}...")
    logger.info("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logger.info("\nShutting down server...")
        httpd.server_close()

if __name__ == '__main__':
    run_server()
