function signRequest(method, endpoint, query_string, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body_str = body ? JSON.stringify(body) : "";
  const payload = [method, endpoint, query_string, body_str, timestamp].join("\n");

  const signature = crypto
    .createHmac("sha512", API_SECRET)
    .update(payload)
    .digest("hex");

  return { signature, timestamp };
}
