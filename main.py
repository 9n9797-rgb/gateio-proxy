from flask import Flask, request, jsonify

app = Flask(__name__)

GATE_BASE_URL = "https://api.gate.io/api/v4"

@app.route("/proxy", methods=["GET"])
def proxy():
    endpoint = request.args.get("endpoint")
    verify_ssl_param = str(request.args.get("verify_ssl", "false")).lower() == "true"

    print("DEBUG - Raw endpoint:", endpoint)
    print("DEBUG - GATE_BASE_URL:", GATE_BASE_URL)

    if not endpoint or endpoint.strip() == "":
        return jsonify({"error": "Missing or empty endpoint"}), 400

    endpoint = endpoint.strip()
    if not endpoint.startswith("/"):
        endpoint = "/" + endpoint

    full_url = f"{GATE_BASE_URL}{endpoint}"
    print("DEBUG - Final full_url:", full_url)
    print("DEBUG - Verify SSL:", verify_ssl_param)

    return jsonify({
        "raw_endpoint": endpoint,
        "final_full_url": full_url,
        "verify_ssl": verify_ssl_param
    })

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
