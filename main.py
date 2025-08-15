from flask import Flask, request, jsonify
import requests
import time
import hashlib
import hmac
import json
import os
import certifi
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

API_KEY = os.getenv("GATE_API_KEY")
API_SECRET = os.getenv("GATE_API_SECRET")
GATE_BASE_URL = "https://api.gate.io/api/v4"

# يمكنك تعطيل التحقق من SSL لو أردت (غيره إلى False إذا كنت تريد التجاوز)
VERIFY_SSL = os.getenv("VERIFY_SSL", "true").lower() == "true"

def sign_request(method, url_path, query_string="", body=""):
    t = str(int(time.time()))
    to_sign = f"{t}\n{method.upper()}\n{url_path}\n{query_string}\n{body}"
    sign = hmac.new(API_SECRET.encode(), to_sign.encode(), hashlib.sha512).hexdigest()
    return {
        "KEY": API_KEY,
        "Timestamp": t,
        "SIGN": sign
    }

@app.route("/proxy", methods=["GET", "POST"])
def proxy():
    try:
        method = request.args.get("method", "GET").upper()
        endpoint = request.args.get("endpoint")
        params = json.loads(request.args.get("params", "{}"))
        body = json.loads(request.args.get("body", "{}"))

        url_path = endpoint
        query_string = "&".join([f"{k}={v}" for k, v in params.items()])
        body_str = json.dumps(body) if body else ""
        headers = sign_request(method, url_path, query_string, body_str)

        full_url = f"{GATE_BASE_URL}{endpoint}"

        if method == "GET":
            response = requests.get(full_url, headers=headers, params=params, verify=certifi.where() if VERIFY_SSL else False)
        elif method == "POST":
            response = requests.post(full_url, headers=headers, params=params, json=body, verify=certifi.where() if VERIFY_SSL else False)
        else:
            return jsonify({"error": "Unsupported method"}), 400

        return jsonify(response.json()), response.status_code

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "time": int(time.time()),
        "verify_ssl": VERIFY_SSL
    })

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
