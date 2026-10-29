# External Access Overlay

This is the Phase 5.2A external edge for a domain-backed deployment. It is
opt-in and does not change the default local/Pilot Compose path.

## Preconditions

Set these values in the root `.env`:

```text
PLATFORM_DOMAIN=example.com
ACME_EMAIL=ops@example.com
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=<caddy hash-password output>
```

For the DuckDNS-backed host, refresh the public A record before starting the
edge (the token is read locally and never printed):

```powershell
.\scripts\update-duckdns.ps1
```

Create DNS records that point to the host running Docker:

```text
console.example.com
chat.example.com
n8n.example.com
s3.example.com
storage.example.com
```

Allow inbound TCP `80` and `443`. Do not expose Redis, Runtime, Worker or the
Kubernetes Sandbox Gateway to the public network.

## Start

Render the merged configuration first. The `!reset`/`!override` tags require a
current Docker Compose release (Docker Desktop's Compose v2 supports them):

```powershell
.\deploy\external\edge.ps1 -Action check
.\deploy\external\edge.ps1 -Action up
```

The overlay removes direct host ports from n8n, Console, LobeChat, SearXNG and
RustFS. Only Caddy listens on `80/443`. n8n receives the public editor and
webhook URLs, while LobeChat and browser S3 uploads use their public HTTPS
hosts.

After the first start, provision and verify the bucket CORS policy:

```powershell
bash scripts/provision-bucket.sh
```

The script derives the HTTPS chat origin from `PLATFORM_DOMAIN` when the
external overlay is active.

## Verify

Check the five public hosts over HTTPS, then run the internal Pilot check from
the host. The public edge must not be used to reach Redis, Runtime or the
Kubernetes API. The Sandbox bridge must be installed separately and remains
loopback-only.

```powershell
curl.exe --fail-with-body https://console.example.com
curl.exe --fail-with-body https://chat.example.com
curl.exe --fail-with-body https://n8n.example.com/healthz
.\deploy\k8s\phase3-pilot\sandbox-bridge.ps1 -Action check
.\deploy\k8s\phase3-pilot\pilot.ps1 -Action check
```

## Return to local/Pilot mode

The overlay is not persistent state. Stop the merged stack and start the base
Compose file again:

```powershell
.\deploy\external\edge.ps1 -Action down
docker compose up -d
```

Do not delete the named volumes. The external overlay changes the edge and
public URLs, not application data.
