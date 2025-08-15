from flask import Flask, request, jsonify
import requests

app = Flask(__name__)

GATE_BASE_URL = "https://api.gate.io/api/v4"

@app.route("/proxy", methods=["GET"])
def proxy():
    endpoint = request.args.get("endpoint")
    verify_ssl_param = str(request.args.get("verify_ssl", "true")).lower()

    print("DEBUG – Raw endpoint:", endpoint)
    print("DEBUG – GATE_BASE_URL:", GATE_BASE_URL)

    if not endpoint or endpoint.strip() == "":
        return jsonify({"error": "Missing or empty 'endpoint' parameter"}), 400

    endpoint = endpoint.strip()
    if not endpoint.startswith("/"):
        endpoint = "/" + endpoint

    full_url = f"{GATE_BASE_URL}{endpoint}"
    verify_ssl = verify_ssl_param != "false"

    print("DEBUG – Final full_url:", full_url)
    print("DEBUG – Verify SSL:", verify_ssl)

    try:
        response = requests.get(full_url, verify=verify_ssl, timeout=10)
        try:
            return jsonify(response.json())
        except ValueError:
            return jsonify({
                "error": "Invalid JSON response from Gate.io",
                "raw_response": response.text
            }), 502
    except requests.exceptions.SSLError as e:
        return jsonify({
            "error": "SSL verification failed",
            "details": str(e)
        }), 502
    except requests.exceptions.RequestException as e:
        return jsonify({
            "error": "Request to Gate.io failed",
            "details": str(e)
        }), 502

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
