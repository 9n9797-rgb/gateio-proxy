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

# بيانات Gate.io
API_KEY = os.getenv("GATE_API_KEY")
API_SECRET = os.getenv("GATE_API_SECRET")
GATE_BASE_URL = "https://api.gate.io/api/v4"

# خيار تجاوز SSL مؤقت (True = تحقق من الشهادة / False = تجاوز)
VERIFY_SSL = os.getenv("VERIFY_SSL", "false").lower() == "true"

def sign_request(method, url_path, query_string="", body=""):
    t = str(int(time.time()))
    to_sign = f"{t}\n{method.upper()}\n{url_path}\n{query_string}\n{body}"
    sign = hmac.new(API_SECRET.encode(), to_sign.encode(), hashlib.sha512).hexdigest()
    return {
        "KEY": API_KEY,
        "Timestamp": t,
        "SIGN": sign
    }

# ✅ فحص صحة السيرفر
@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "time": int(time.time()),
        "verify_ssl": VERIFY_SSL
    }), 200

# ✅ البروكسي نفسه
@app.route("/proxy", methods=["GET", "POST"])
def proxy():
    try:
        # إذا كان GET
        if request.method == "GET":
            endpoint = request.args.get("endpoint")
            if not endpoint:
                return jsonify({"error": "Missing endpoint"}), 400
            params = dict(request.args)
            params.pop("endpoint", None)
            method = "GET"
            body = {}
        else:
            # إذا كان POST
            data = request.json
            method = data.get("method", "GET")
            endpoint = data.get("endpoint")
            params = data.get("params", {})
            body = data.get("body", {})

        url_path = endpoint
        query_string = "&".join([f"{k}={v}" for k, v in params.items()])
        body_str = json.dumps(body) if body else ""
        headers = sign_request(method, url_path, query_string, body_str)

        # تنفيذ الطلب
        if method.upper() == "GET":
            response = requests.get(
                f"{GATE_BASE_URL}{endpoint}",
                headers=headers,
                params=params,
                timeout=10,
                verify=VERIFY_SSL
            )
        elif method.upper() == "POST":
            response = requests.post(
                f"{GATE_BASE_URL}{endpoint}",
                headers=headers,
                params=params,
                json=body,
                timeout=10,
                verify=VERIFY_SSL
            )
        else:
            return jsonify({"error": "Unsupported method"}), 400

        return jsonify(response.json()), response.status_code

    except requests.exceptions.SSLError as ssl_err:
        return jsonify({"error": "SSL verification failed", "details": str(ssl_err)}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
