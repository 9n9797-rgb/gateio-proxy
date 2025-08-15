from flask import Flask, request, jsonify
import requests
import time
import hashlib
import hmac
import json
import os
from dotenv import load_dotenv
import certifi

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

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "time": int(time.time())
    }), 200

@app.route("/proxy", methods=["GET", "POST"])
def proxy():
    try:
        # قراءة البيانات بشكل منفصل حسب نوع الطلب
        if request.method == "GET":
            method = request.args.get("method", "GET").upper()
            endpoint = request.args.get("endpoint")
            params = {}
            body = {}
            # الوضع الافتراضي false إلا إذا كتب المستخدم true
            verify_ssl_param = str(request.args.get("verify_ssl", "false")).lower() == "true"
        else:  # POST
            data = request.json if request.is_json else request.args
            method = data.get("method", "GET").upper()
            endpoint = data.get("endpoint")
            params = json.loads(data.get("params", "{}")) if isinstance(data.get("params"), str) else data.get("params", {})
            body = json.loads(data.get("body", "{}")) if isinstance(data.get("body"), str) else data.get("body", {})
            verify_ssl_param = str(data.get("verify_ssl", "false")).lower() == "true"

        if not endpoint:
            return jsonify({"error": "Missing endpoint"}), 400

        verify_option = certifi.where() if verify_ssl_param else False

        url_path = endpoint
        query_string = "&".join([f"{k}={v}" for k, v in params.items()])
        body_str = json.dumps(body) if body else ""
        headers = sign_request(method, url_path, query_string, body_str)

        # إرسال الطلب
        if method == "GET":
            response = requests.get(
                f"{GATE_BASE_URL}{endpoint}",
                headers=headers,
                params=params,
                timeout=10,
                verify=verify_option
            )
        elif method == "POST":
            response = requests.post(
                f"{GATE_BASE_URL}{endpoint}",
                headers=headers,
                params=params,
                json=body,
                timeout=10,
                verify=verify_option
            )
        else:
            return jsonify({"error": "Unsupported method"}), 400

        try:
            return jsonify(response.json()), response.status_code
        except json.JSONDecodeError:
            return jsonify({
                "error": "Invalid JSON response from Gate.io",
                "raw_response": response.text
            }), 502

    except requests.exceptions.SSLError as ssl_err:
        return jsonify({"error": "SSL verification failed", "details": str(ssl_err)}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
