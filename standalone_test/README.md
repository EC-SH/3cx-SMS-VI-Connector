# 3CX to Sangoma SMS Middleware - Standalone Python Tester

This script is designed **exclusively for quick verification and debugging**. It allows you to run a temporary listener directly on a 3CX server (or a local testing machine) to watch webhook payloads transfer between 3CX and Sangoma.

**⚠️ WARNING: Do not use this for production deployments.** 
This uses Python's built-in `HTTPServer`, which is single-threaded and not designed for production workloads or maintaining persistent background execution through OS updates. For production, please use the provided Google Cloud Functions or the Node.js Express application.

---

## Prerequisites

1.  Python 3 installed on the target machine (`python3 --version`).
2.  The `requests` library installed (`pip3 install requests`).

## Quick Start on a 3CX Server (Debian)

1.  Connect to your 3CX server via SSH.
2.  Upload or create the `server.py` file in a temporary directory (e.g., `/tmp/sms-test/`).
3.  Edit the configuration variables at the top of the `server.py` file:
    ```bash
    nano server.py
    ```
    *Update the `CONFIG` dictionary with your Sangoma API Key/Secret and the 3CX Webhook URL.*
4.  Run the script:
    ```bash
    python3 server.py
    ```
5.  By default, it will listen on port `8080`. 
    *   *Note: If port 8080 is blocked by your firewall, you may need to temporarily allow it (`iptables -A INPUT -p tcp --dport 8080 -j ACCEPT`) or run the script on a different open port.*

## Testing the Flow
While the script is running, it will print all incoming JSON payloads directly to your console screen.

1.  **Inbound:** Send a text to your Sangoma DID. 
    *   Point your Sangoma webhook to `http://YOUR-3CX-IP:8080/inbound`
    *   Watch the console output to see the translation occur.
2.  **Outbound:** Send a text from the 3CX WebClient.
    *   Point your 3CX generic provider webhook to `http://YOUR-3CX-IP:8080/outbound`
    *   Watch the console output to see the text sent to Sangoma.

To stop the server, press `Ctrl+C`.
