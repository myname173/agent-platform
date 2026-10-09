"""The strongest possible check on the product-level upload.

A row in `files` proves the app RECORDED a file. It does not prove the bytes
made it. This pulls the object back out of RustFS and compares SHA-256 with the
local original — byte equality is the only thing that proves the whole chain.

Takes the object key from the `files.url` column so we do not have to guess it.
"""
import datetime
import hashlib
import hmac
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error

PROJECT = r"C:\Users\13682\Desktop\agent-platform-main"
# Override with LOCAL_FILE=... to verify an upload of a different source file.
LOCAL = os.environ.get("LOCAL_FILE") or os.path.join(
    PROJECT, "interview-demo", "测试素材", "Airbnb-JavaScript-代码规范.md")
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


def request(method, key="", body=b""):
    path = "/" + BUCKET + (("/" + key) if key else "")
    now = datetime.datetime.now(datetime.timezone.utc)
    amzdate, ds = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    phash = hashlib.sha256(body).hexdigest()
    host = ENDPOINT.split("//", 1)[1]
    ch = "host:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n" % (host, phash, amzdate)
    sh = "host;x-amz-content-sha256;x-amz-date"
    canon = "\n".join([method, path, "", ch, sh, phash])
    scope = "%s/%s/%s/aws4_request" % (ds, REGION, SERVICE)
    sts = "\n".join(["AWS4-HMAC-SHA256", amzdate, scope,
                     hashlib.sha256(canon.encode()).hexdigest()])
    sig = hmac.new(_skey(SK, ds), sts.encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(ENDPOINT + path, data=(body or None), method=method)
    req.add_header("Authorization",
                   "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s"
                   % (AK, scope, sh, sig))
    req.add_header("x-amz-content-sha256", phash)
    req.add_header("x-amz-date", amzdate)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(req, timeout=25) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


print("=== 1. what the product recorded ===")
fid = os.environ.get("FILE_ID", "")
fname = os.environ.get("FILE_NAME", "")
fsize = os.environ.get("FILE_SIZE", "")
fkey = os.environ.get("FILE_KEY", "")
if not fkey:
    sys.exit("!! pass FILE_ID/FILE_NAME/FILE_SIZE/FILE_KEY (read them from lobechat.files)")
print("   file id : %s" % fid)
print("   name    : %s" % fname)
print("   size    : %s" % fsize)
print("   s3 key  : %s" % fkey)

raw = open(LOCAL, "rb").read()
local_sha = hashlib.sha256(raw).hexdigest()
print("\n=== 2. local original ===")
print("   size   : %d" % len(raw))
print("   sha256 : %s" % local_sha)

print("\n=== 3. GET the object back out of RustFS ===")
st, got = request("GET", fkey)
print("   HTTP %s | %d bytes" % (st, len(got)))
if st != 200:
    sys.exit("!! GET failed")

remote_sha = hashlib.sha256(got).hexdigest()
print("   sha256 : %s" % remote_sha)

print("\n=== 4. verdict ===")
same_bytes = remote_sha == local_sha
same_size = int(fsize) == len(raw) == len(got)
print("   size in DB == local size == retrieved size : %s" % same_size)
print("   sha256 local == sha256 retrieved           : %s" % same_bytes)
print()
if same_bytes and same_size:
    print("RESULT: PASS")
    print("  the file left the browser, went through LobeHub's own upload API,")
    print("  landed in RustFS, and came back byte-identical.")
else:
    print("RESULT: FAIL")
