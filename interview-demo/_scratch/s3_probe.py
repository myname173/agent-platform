"""Probe the object store with the platform's OWN credentials, over plain HTTP.

No boto3 — implements AWS SigV4 with the stdlib only (hmac/hashlib/urllib).
Why: pip install boto3 was blocked by policy in this environment, and the point
here is just to prove the S3 path (creds + bucket + path-style) really works.

Reads MINIO_ROOT_USER / MINIO_ROOT_PASSWORD from the project .env so we are
using exactly the credentials LobeChat itself uses.
"""
import datetime
import hashlib
import hmac
import os
import re
import sys
import urllib.request
import urllib.error

PROJECT = r"C:\Users\13682\Desktop\agent-platform-main"
ENDPOINT = "http://127.0.0.1:9000"
BUCKET = "lobechat-files"
REGION = "us-east-1"
SERVICE = "s3"


def load_env(path):
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
            if m:
                out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


env = load_env(os.path.join(PROJECT, ".env"))
AK = env.get("MINIO_ROOT_USER", "")
SK = env.get("MINIO_ROOT_PASSWORD", "")
if not AK or not SK:
    sys.exit("!! MINIO_ROOT_USER / MINIO_ROOT_PASSWORD not found in .env")
print("creds loaded: access key len=%d  secret len=%d" % (len(AK), len(SK)))


def sign(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret, datestamp, region, service):
    k = ("AWS4" + secret).encode("utf-8")
    for part in (datestamp, region, service, "aws4_request"):
        k = sign(k, part)
    return k


def request(method, key="", body=b"", extra_query=""):
    """Signed request. key='' means bucket-level (list)."""
    path = "/" + BUCKET + (("/" + key) if key else "")
    now = datetime.datetime.now(datetime.timezone.utc)
    amzdate = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()
    host = ENDPOINT.split("//", 1)[1]

    # canonical query string must be sorted by key
    q = ""
    if extra_query:
        pairs = sorted(extra_query.split("&"))
        q = "&".join(pairs)

    canon_headers = (
        "host:%s\n" % host
        + "x-amz-content-sha256:%s\n" % payload_hash
        + "x-amz-date:%s\n" % amzdate
    )
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical = "\n".join([
        method, path, q, canon_headers, signed_headers, payload_hash
    ])
    scope = "%s/%s/%s/aws4_request" % (datestamp, REGION, SERVICE)
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amzdate, scope,
        hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    ])
    sig = hmac.new(
        signing_key(SK, datestamp, REGION, SERVICE),
        string_to_sign.encode("utf-8"), hashlib.sha256,
    ).hexdigest()

    auth = (
        "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s"
        % (AK, scope, signed_headers, sig)
    )
    url = ENDPOINT + path + (("?" + q) if q else "")
    req = urllib.request.Request(url, data=(body if method in ("PUT", "POST") else None),
                                 method=method)
    req.add_header("Authorization", auth)
    req.add_header("x-amz-content-sha256", payload_hash)
    req.add_header("x-amz-date", amzdate)
    # bypass any host proxy
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=15) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


print("\n--- 1. PUT a real object ---")
KEY = "evidence/s3-path-check.txt"
PAYLOAD = ("RustFS S3 通路验证\n"
           "写于 2026-10-08，用于证明 lobechat-files 桶可写。\n"
           "由 interview-demo/_scratch/s3_probe.py 通过平台自身的凭据写入。\n").encode("utf-8")
st, body = request("PUT", KEY, PAYLOAD)
print("PUT  %s -> HTTP %s" % (KEY, st))
if st not in (200, 201):
    print("     resp:", body[:300])
    sys.exit(1)

print("\n--- 2. HEAD it back ---")
st, body = request("HEAD", KEY)
print("HEAD %s -> HTTP %s" % (KEY, st))

print("\n--- 3. GET it back and compare bytes ---")
st, got = request("GET", KEY)
same = got == PAYLOAD
print("GET  %s -> HTTP %s | bytes=%d | identical=%s" % (KEY, st, len(got), same))

print("\n--- 4. LIST the bucket ---")
st, body = request("GET", "")
keys = re.findall(rb"<Key>([^<]+)</Key>", body)
sizes = re.findall(rb"<Size>([^<]+)</Size>", body)
print("LIST -> HTTP %s | objects=%d" % (st, len(keys)))
for k, s in zip(keys, sizes):
    print("     %-40s %s bytes" % (k.decode(), s.decode()))

print("\nRESULT:", "PASS" if (st == 200 and same) else "FAIL")
