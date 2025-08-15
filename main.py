from flask import Flask, request, jsonify
import requests
import time
import hashlib
import hmac
import json
import os
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

API_KEY = os.getenv("GATE_API_KEY")
API_SECRET = os.getenv("GATE_API_SECRET")
GATE_BASE_URL = "https://api.gate.io/api/v4"

def sign_request(method, url_path, query_string="", body=""):
    t = str(int(time.time()))
    to_sign = f"{t}\n{method.upper()}\n{url_path}\n{query_string}\n{body}"
    sign = hmac.new(API_SECRET.encode(), to_sign.encode(), hashlib.sha512).hexdigest()
    return {
        "KEY": API_KEY,
        "Timestamp": t,
        "SIGN": sign
    }

@app.route("/proxy", methods=["POST"])
def proxy():
    try:
        data = request.json
        method = data.get("method", "GET")
        endpoint = data.get("endpoint")
        params = data.get("params", {})
        body = data.get("body", {})
        url_path = endpoint
        query_string = "&".join([f"{k}={v}" for k, v in params.items()])
        body_str = json.dumps(body) if body else ""
        headers = sign_request(method, url_path, query_string, body_str)

        if method.upper() == "GET":
            response = requests.get(
                f"{GATE_BASE_URL}{endpoint}",
                headers=headers,
                params=params
            )
        elif method.upper() == "POST":
            response = requests.post(
                f"{GATE_BASE_URL}{endpoint}",
                headers=headers,
                params=params,
                json=body
            )
        else:
            return jsonify({"error": "Unsupported method"}), 400

        return jsonify(response.json()), response.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ✅ السطر المهم لتشغيل التطبيق على Render
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
