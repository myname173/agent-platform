# Cloudflare Tunnel 外部入口

这个 overlay 用 `cloudflared` 建立从 Docker 主机到 Cloudflare 的出站连接，
不需要路由器端口转发，也不需要本机监听公网 `80/443`。默认 Compose 和本地
Caddy 入口保持不变，只有显式启动这个 overlay 时才会启用 Tunnel。

## 前提

稳定的自定义域名需要满足两个条件：

1. 有一个由 Cloudflare 托管 DNS 的域名；
2. 在 Cloudflare Zero Trust 的 Tunnels 页面创建 remotely-managed Tunnel，
   添加 connector 后复制 Docker token。

`agent-platform-node783.duckdns.org` 仍然可以用于 DuckDNS 更新和直连备用，
但它属于 `duckdns.org`，不能作为你 Cloudflare 账号里的自定义 Tunnel 域名。

把下面两项写入根目录 `.env`，token 只保存在本机：

```text
CLOUDFLARE_DOMAIN=example.com
CLOUDFLARE_TUNNEL_TOKEN=<connector token>
```

## Cloudflare Public Hostname 路由

在 Tunnel 的 Public Hostnames 中配置这些 HTTP 服务目标。它们使用 Docker
内部 DNS，因此不需要主机端口：

```text
console.example.com  -> http://platform-console:3000
chat.example.com     -> http://lobechat:3210
n8n.example.com      -> http://n8n:5678
s3.example.com       -> http://minio:9000
```

`storage.example.com -> http://minio:9001` 只有在配置 Cloudflare Access 或
其他明确的身份认证后才应发布。它是 RustFS 管理面，不应作为普通业务入口。

## 启动与验证

先检查合并配置，再启动 overlay：

```powershell
.\deploy\cloudflare\tunnel.ps1 -Action check
.\deploy\cloudflare\tunnel.ps1 -Action up
.\deploy\cloudflare\tunnel.ps1 -Action status
```

验证 Tunnel 连接后，运行对象存储 CORS 配置和平台检查：

```powershell
bash scripts/provision-bucket.sh
.\deploy\k8s\phase3-pilot\pilot.ps1 -Action check
```

停止 Tunnel 并回到当前本地模式：

```powershell
.\deploy\cloudflare\tunnel.ps1 -Action down
docker compose up -d
```

Quick Tunnel (`trycloudflare.com`) 只适合临时验证，地址会变化，不作为这个
overlay 的生产配置。
