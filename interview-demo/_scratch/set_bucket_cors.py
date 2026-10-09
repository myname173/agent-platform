"""Give the lobechat-files bucket a CORS policy.

Why: LobeHub uploads from the BROWSER via a presigned URL, i.e. a cross-origin
PUT from http://127.0.0.1:3210 to http://<host>:9000. RustFS answered the
preflight with a bare "200 OK" and NO Access-Control-* headers, so Chrome
blocked the actual PUT and the app called upload.abortS3Upload. The result was
file_uploads rows stuck at status=released, nothing in `files`, nothing in the
bucket.

Fix: PutBucketCors with the console origins allowed. Stdlib SigV4 (no boto3).
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
REGION, SERVICE = "us-east-1", "s3"


def load_env(path):
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
            if m:
                out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


env = load_env(os.path.join(PROJECT, ".env"))
AK, SK = env["MINIO_ROOT_USER"], env["MINIO_ROOT_PASSWORD"]


def _sign(k, m):
    return hmac.new(k, m.encode(), hashlib.sha256).digest()


def _skey(s, ds):
    k = ("AWS4" + s).encode()
    for p in (ds, REGION, SERVICE, "aws4_request"):
        k = _sign(k, p)
    return k


def request(method, key="", query="", body=b"", ctype=None):
    path = "/" + BUCKET + (("/" + key) if key else "")
    now = datetime.datetime.now(datetime.timezone.utc)
    amzdate, ds = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    phash = hashlib.sha256(body).hexdigest()
    host = ENDPOINT.split("//", 1)[1]
    # Canonical query string: URL-encode, sort by key, and render a valueless
    # parameter as "name=" (NOT bare "name") — SigV4 signs "cors=", while the
    # actual request URL stays "?cors".
    q = "&".join(sorted(query.split("&"))) if query else ""
    if q and "=" not in q:
        q = q + "="

    ch = "host:%s\n" % host
    sh = ["host"]
    if ctype:
        ch += "content-type:%s\n" % ctype
        sh.append("content-type")
    ch += "x-amz-content-sha256:%s\nx-amz-date:%s\n" % (phash, amzdate)
    sh += ["x-amz-content-sha256", "x-amz-date"]
    sh = ";".join(sh)

    canon = "\n".join([method, path, q, ch, sh, phash])
    scope = "%s/%s/%s/aws4_request" % (ds, REGION, SERVICE)
    sts = "\n".join(["AWS4-HMAC-SHA256", amzdate, scope,
                     hashlib.sha256(canon.encode()).hexdigest()])
    sig = hmac.new(_skey(SK, ds), sts.encode(), hashlib.sha256).hexdigest()

    url = ENDPOINT + path + (("?" + q) if q else "")
    req = urllib.request.Request(url, data=(body or None), method=method)
    req.add_header("Authorization",
                   "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s"
                   % (AK, scope, sh, sig))
    req.add_header("x-amz-content-sha256", phash)
    req.add_header("x-amz-date", amzdate)
    if ctype:
        req.add_header("Content-Type", ctype)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(req, timeout=20) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


CORS = """<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
    <AllowedOrigin>http://127.0.0.1:3210</AllowedOrigin>
    <AllowedOrigin>http://localhost:3210</AllowedOrigin>
    <AllowedOrigin>http://192.168.31.91:3210</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>x-amz-request-id</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
""".encode("utf-8")

print("=== PUT bucket CORS ===")
st, hdrs, body = request("PUT", "", "cors", CORS, "application/xml")
print("HTTP %s" % st)
if st not in (200, 204):
    print("resp:", body[:400].decode("utf-8", "replace"))

print("\n=== GET bucket CORS back (proves it stuck) ===")
st, hdrs, body = request("GET", "", "cors")
print("HTTP %s" % st)
print(body.decode("utf-8", "replace")[:600] if st == 200 else "resp: " + body[:300].decode("utf-8", "replace"))

print("\n=== re-run the preflight the browser will send ===")
import urllib.request as _u
req = _u.Request(ENDPOINT + "/" + BUCKET + "/probe.txt", method="OPTIONS")
req.add_header("Origin", "http://127.0.0.1:3210")
req.add_header("Access-Control-Request-Method", "PUT")
req.add_header("Access-Control-Request-Headers", "content-length")
op = _u.build_opener(_u.ProxyHandler({}))
try:
    with op.open(req, timeout=15) as r:
        print("HTTP", r.status)
        for k, v in r.headers.items():
            if k.lower().startswith("access-control"):
                print("   %s: %s" % (k, v))
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
    for k, v in e.headers.items():
        if k.lower().startswith("access-control"):
            print("   %s: %s" % (k, v))
