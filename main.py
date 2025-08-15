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

# مفاتيح Gate.io من متغيرات البيئة
API_KEY = os.getenv("GATE_API_KEY")
API_SECRET = os.getenv("GATE_API_SECRET")
GATE_BASE_URL = "https://api.gate.io/api/v4"

# خيار التحقق من SSL
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

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "time": int(time.time()),
        "verify_ssl": VERIFY_SSL
    }), 200

@app.route("/proxy", methods=["GET", "POST"])
def proxy():
    try:
        if request.method == "GET":
            endpoint = request.args.get("endpoint")
            if not endpoint:
                return jsonify({"error": "Missing endpoint"}), 400
            params = dict(request.args)
            params.pop("endpoint", None)
            method = "GET"
            body = {}
        else:
            data = request.json
            method = data.get("method", "GET")
            endpoint = d
