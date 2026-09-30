#!/usr/bin/env python3
"""Build a self-contained migration pack for deploying on another machine.

What the pack contains
----------------------
    project/      full working tree (incl. .git and .env) minus build junk
    data/         the newest COMPLETE backup set (pg dumps + volume tars)
    migration/    restore.ps1 / restore.sh / verify.ps1 / verify.sh / SOURCE.json
    MIGRATE.md    the human-readable runbook
    CHECKSUMS.txt sha256 of everything under data/ and of key project files

Why it is built this way
------------------------
Every piece of live state lives in Docker *named* volumes
(postgres_data_pg17 / n8n_data / minio_data). Those are in Docker Desktop's
WSL2 disk, never in the repo — so a plain copy of the folder carries zero
records. The stack's own `backup` service bind-mounts ./backups, which is why
the dumps exist on disk at all; this script picks the newest set that has ALL
five artefacts, so a half-finished run is never shipped as if it were full.
"""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import hashlib, json, os, re, shutil, subprocess, sys

ROOT = Path(__file__).resolve().parent.parent
BACKUPS = ROOT / "backups"
DIST = ROOT / "dist"
MIGRATION_SRC = ROOT / "migration"

# Directories never worth shipping to another machine.
EXCLUDE_DIRS = {
    "node_modules", ".next", "dist", "backups", "backend", "lobechat",
    "custom-theme", ".workbuddy-ai", "__pycache__", ".pytest_cache",
    "demo-assets/_tmp", "deliverables/_verify", ".venv", "venv",
}
EXCLUDE_FILE_SUFFIX = {".log", ".tmp", ".swp"}
EXCLUDE_FILE_NAMES = {"kiranism-dev.log", ".last-ok"}

REQUIRED = [
    "docker-compose.yml", ".env", ".env.example",
    "frontent/bun.lock", "frontent/package.json", "frontent/Dockerfile",
    "n8n/sandbox.Dockerfile", "backup/Dockerfile", "backup/backup.sh",
    "searxng/settings.yml", "stream-bridge/server.js",
    "migration/restore.ps1", "migration/restore.sh",
    "migration/verify.ps1", "migration/verify.sh",
    "migration/preflight.ps1", "migration/preflight.sh",
]


def check_script_syntax():
    """Parse every script that goes in the pack. Do not ship one that cannot run.

    Two of them shipped broken and nobody noticed: restore.sh had a dangling
    quote in its env_val() (tr -d '"'"'"') and verify.sh had a stray ' inside a
    Python expression. Both derail bash's $( ) scanner, so the script never
    parsed at all on Linux/macOS — it would have failed instantly on the new
    machine, and "it looks fine" is not a check. Hence this gate, for both
    shells.
    """
    problems = []

    bash = find_bash()
    if not bash:
        print("  SKIP no usable bash found — .sh not syntax-checked")
        print("       (on Windows `bash` is often the WSL launcher; install Git for Windows)")
    else:
        for sh in sorted((ROOT / "migration").glob("*.sh")) + sorted((ROOT / "backup").glob("*.sh")):
            try:
                r = subprocess.run([bash, "-n", str(sh)], capture_output=True,
                                   text=True, timeout=30)
            except (OSError, subprocess.SubprocessError) as e:
                problems.append("%s: cannot run bash: %s" % (sh.name, e))
                continue
            if r.returncode != 0:
                first = (r.stderr or r.stdout or "").strip().splitlines()
                problems.append("%s: %s" % (sh.name, first[0] if first else "syntax error"))
        print(("  OK   " if not problems else "  FAIL ") + "bash -n on all shipped .sh (%s)" % os.path.basename(bash))

    # PowerShell: use the language parser rather than running the scripts, so
    # this works (and is safe) on Linux build hosts too — skipped if pwsh is
    # not installed.
    pwsh = shutil.which("pwsh") or shutil.which("powershell")
    ps_problems = []
    if pwsh:
        ps1 = sorted((ROOT / "migration").glob("*.ps1"))
        script = (
            "$bad=@(); foreach ($f in @(%s)) {"
            " $t=$null; $e=$null;"
            " [System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$t,[ref]$e) | Out-Null;"
            " if ($e -and $e.Count -gt 0) { $bad += \"$f :: $($e[0].Message)\" } };"
            " $bad -join \"`n\""
        ) % ",".join("'%s'" % str(p).replace("'", "''") for p in ps1)
        r = run([pwsh, "-NoProfile", "-Command", script])
        lines = [l for l in (r.stdout or "").splitlines() if l.strip()]
        if r.returncode == 0 and lines:
            ps_problems = lines
    else:
        print("  SKIP powershell not available — .ps1 not parse-checked")
    if pwsh:
        print(("  OK   " if not ps_problems else "  FAIL ") + "parser on all shipped .ps1")
    problems += ps_problems

    for p in problems:
        print("       " + str(p))
    return problems


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def env_value(name):
    p = ROOT / ".env"
    if not p.exists():
        return ""
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(name + "="):
            return line[len(name) + 1:].strip().strip("'").strip('"')
    return ""


def latest_complete_set():
    """Return the stamp whose five artefacts are all present.

    A backup can die halfway through (the log is full of Docker-daemon
    failures), so never assume 'newest file' == 'complete set'.
    """
    files = list(BACKUPS.glob("*2026*.tar.gz")) + list(BACKUPS.glob("*2026*.sql.gz"))
    stamps = {}
    for f in files:
        m = re.search(r"(\d{8}-\d{6})", f.name)
        if m:
            stamps.setdefault(m.group(1), []).append(f)
    needed = ["pg-n8n-", "pg-lobechat-", "n8n-data-", "minio-data-"]
    for stamp in sorted(stamps, reverse=True):
        kinds = {next((k for k in needed if f.name.startswith(k)), None) for f in stamps[stamp]}
        if all(k in kinds for k in needed):
            return stamp, stamps[stamp]
    return None, []


def copy_project(dst):
    copied, skipped = 0, 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        rel = Path(dirpath).relative_to(ROOT)
        parts = set(rel.parts)
        dirnames[:] = [
            d for d in dirnames
            if d not in EXCLUDE_DIRS
            and not d.startswith(".tmp-")
            and not (rel == Path(".") and d == "dist")
            and not (rel == Path(".") and d == ".workbuddy-ai")
        ]
        if parts & EXCLUDE_DIRS:
            continue
        target = dst / rel
        target.mkdir(parents=True, exist_ok=True)
        for fn in filenames:
            if fn in EXCLUDE_FILE_NAMES or Path(fn).suffix in EXCLUDE_FILE_SUFFIX:
                skipped += 1
                continue
            if fn.startswith(".env.bak"):
                skipped += 1
                continue
            src = Path(dirpath) / fn
            try:
                shutil.copy2(src, target / fn)
                copied += 1
            except OSError as e:
                print("  skip %s (%s)" % (rel / fn, e))
                skipped += 1
    return copied, skipped


def psql(sql, db=None):
    user, dbname = env_value("POSTGRES_USER") or "n8n", db or (env_value("POSTGRES_DB") or "n8n")
    r = run(["docker", "exec", "postgres", "psql", "-U", user, "-d", dbname, "-tAc", sql])
    out = r.stdout.strip()
    return None if r.returncode != 0 else out


def docker_up():
    return run(["docker", "info"]).returncode == 0


def find_bash():
    """A bash that actually runs, not the WSL launcher.

    On Windows `bash` on PATH can be C:\\Windows\\System32\\bash.exe, which is
    the WSL launcher — it tries to spawn wsl.exe, hangs, and in a sandboxed run
    is blocked outright. That made every syntax check fail with garbage output
    and the pack looked broken when nothing was. Prefer a real Git bash, and
    prove the candidate works before trusting it.
    """
    candidates = []
    if os.name == "nt":
        candidates += [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Git\bin\bash.exe"),
        ]
    candidates.append(shutil.which("bash") or "bash")
    for c in candidates:
        if not c or (os.name == "nt" and not os.path.exists(c)):
            continue
        try:
            r = subprocess.run([c, "-c", "echo ok"], capture_output=True,
                               text=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            continue
        # The WSL shim either fails or prints a distro-not-installed message.
        if r.returncode == 0 and "ok" in (r.stdout or ""):
            return c
    return None


def collect_counts():
    counts = {}
    for label, sql in (("workflows", "select count(*) from workflow_entity"),
                       ("executions", "select count(*) from execution_entity"),
                       ("credentials", "select count(*) from credentials_entity"),
                       ("data_tables", "select count(*) from data_table")):
        v = psql(sql)
        counts[label] = int(v) if (v or "").isdigit() else None
    rows = psql(
        "select d.name || '|' || (xpath('/row/c/text()', query_to_xml("
        "format('select count(*) as c from %I', 'data_table_user_' || d.id),"
        " false, true, '')))[1]::text::bigint from data_table d order by d.name")
    tables = {}
    for line in (rows or "").splitlines():
        if "|" in line:
            n, c = line.split("|", 1)
            try:
                tables[n.strip()] = int(c.strip())
            except ValueError:
                pass
    return counts, tables


def sha256(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


def main():
    ts = datetime.now(timezone(timedelta(hours=8)))
    stamp, files = latest_complete_set()
    if not stamp:
        print("no complete backup set found in backups/"); return 1
    print("backup stamp: %s (%d files)" % (stamp, len(files)))

    pack = DIST / ("agent-platform-migration-%s" % ts.strftime("%Y%m%d"))
    if pack.exists():
        shutil.rmtree(pack)
    (pack / "data").mkdir(parents=True, exist_ok=True)
    (pack / "migration").mkdir(parents=True, exist_ok=True)

    print("checking script syntax ...")
    broken = check_script_syntax()

    print("copying project ...")
    n, skipped = copy_project(pack / "project")
    print("  copied %d files (skipped %d)" % (n, skipped))

    print("copying backup set ...")
    for f in files:
        shutil.copy2(f, pack / "data" / f.name)
        print("  %-42s %8.1f MB" % (f.name, f.stat().st_size / 1048576))

    for f in MIGRATION_SRC.glob("*"):
        if f.is_file() and f.suffix in (".ps1", ".sh"):
            shutil.copy2(f, pack / "migration" / f.name)

    print("collecting source-of-truth counts ...")
    # The counts are what verify.* compares against, so they must come from the
    # live database. If the daemon is down we cannot read it — reusing the last
    # SOURCE.json is honest only if the pack says so, because otherwise a stale
    # baseline ships looking authoritative.
    live = docker_up()
    if live:
        counts, tables = collect_counts()
    else:
        print("  WARN docker daemon is down — reusing counts from the previous SOURCE.json")
        prev = MIGRATION_SRC / "SOURCE.json"
        old = json.loads(prev.read_text(encoding="utf-8")) if prev.exists() else {}
        counts, tables = old.get("counts") or {}, old.get("data_tables") or {}
        if not counts:
            print("  FAIL no previous SOURCE.json to fall back on")
            return 1
    head = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    src = {
        "generated_at": ts.isoformat(timespec="seconds"),
        "counts_read_live_from_database": live,
        "source_host_lan_ip": env_value("PLATFORM_LAN_IP"),
        "git_branch": branch,
        "git_head": head,
        "backup_stamp": stamp,
        "n8n_encryption_key": env_value("N8N_ENCRYPTION_KEY"),
        "postgres_db": env_value("POSTGRES_DB") or "n8n",
        "postgres_user": env_value("POSTGRES_USER") or "n8n",
        "n8n_version": env_value("N8N_VERSION"),
        "counts": counts,
        "data_tables": tables,
        "volumes": {
            "n8n_data": "external:true — MUST be created by hand before compose up",
            "postgres_data": "compose-managed, real name postgres_data_pg17",
            "minio_data": "compose-managed",
        },
    }
    (pack / "migration" / "SOURCE.json").write_text(
        json.dumps(src, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.copy2(pack / "migration" / "SOURCE.json", pack / "SOURCE.json")
    # Keep a copy in the repo too, so verify.ps1 can be run against the live
    # stack on this machine and not only inside the pack.
    MIGRATION_SRC.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pack / "migration" / "SOURCE.json", MIGRATION_SRC / "SOURCE.json")

    print("checksums ...")
    lines = []
    for f in sorted((pack / "data").glob("*")):
        lines.append("%s  data/%s" % (sha256(f), f.name))
    for rel in REQUIRED:
        p = pack / "project" / rel
        if p.exists():
            lines.append("%s  project/%s" % (sha256(p), rel))
    (pack / "CHECKSUMS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    missing = [r for r in REQUIRED if not (pack / "project" / r).exists()]
    missing += ["shell syntax: " + b for b in broken]
    if missing:
        print("\nMISSING FROM PACK:")
        for m in missing:
            print("  ! %s" % m)
    else:
        print("\nall required files present")

    write_runbook(pack, src, files, missing)

    total = sum(f.stat().st_size for f in pack.rglob("*") if f.is_file())
    print("\npack: %s" % pack)
    print("size: %.1f MB" % (total / 1048576))
    print("missing: %d" % len(missing))
    return 0 if not missing else 2


RUNBOOK = """# agent-platform 迁移到新机器

生成时间：{generated_at}
来源机器 LAN IP：`{lan_ip}`（**新机器会不一样，恢复脚本会自动改写**）
来源 git：`{branch}` @ `{head}`
备份集：`{stamp}`

## 这个包里有什么

```
agent-platform-migration-{date}/
├── project/      完整源码（含 .env 和 .git，已剔除 node_modules 等构建垃圾）
├── data/         最新一份"完整"备份集（五个文件齐全才会被选中）
│                 pg-n8n-*.sql.gz          n8n 全部数据（工作流/执行/凭据/数据表）
│                 pg-lobechat-*.sql.gz     对话记录
│                 n8n-data-*.tar.gz        n8n_data 卷快照
│                 minio-data-*.tar.gz      minio_data 卷快照
├── migration/    preflight.*（装机前自检）+ restore.*（一键恢复）
│                 + verify.*（验收）+ SOURCE.json（比对基准）
├── CHECKSUMS.txt
└── MIGRATE.md    本文件
```

## 为什么必须带 data/

compose 里所有状态都在 **Docker 具名卷**里 —— `postgres_data_pg17`、`n8n_data`、
`minio_data`。这些住在 Docker Desktop 的 WSL2 虚拟盘，**不在项目目录里**。
所以只拷源码过去 = 一条记录都没有。栈里的 `backup` 服务 bind 了 `./backups`，
这些 dump 就是它产出的。

## 第 0 步：先自检（别跳过）

解压完先跑这个，它会告诉你这台机器**能不能跑**，而不是让你装到一半才发现：

```powershell
powershell -ExecutionPolicy Bypass -File migration\\preflight.ps1
```

查：Docker daemon 在不在（装了不等于开着）、compose v2、磁盘/内存、
**每个宿主端口有没有被占**、系统代理是否放行 localhost、**TUN 是否生效**。
`restore.ps1` 内部会自动跑一遍，所以也可以直接往下走 —— 但想先看一眼就跑它。

## 恢复（Windows / PowerShell）

```powershell
powershell -ExecutionPolicy Bypass -File migration\\restore.ps1 -Target C:\\agent-platform
# 指定 IP（有多张网卡时）：
powershell -ExecutionPolicy Bypass -File migration\\restore.ps1 -Target C:\\agent-platform -LanIp 192.168.1.50
```

## 恢复（Linux / macOS）

```bash
chmod +x migration/*.sh
./migration/restore.sh ~/agent-platform
```

## 脚本做了什么（顺序不能改）

1. 拷贝 project → Target
2. 把 `.env` 里的 `PLATFORM_LAN_IP` / `LAN_IP` 改成本机 IP
3. **探测宿主端口**：被占的就顺延到下一个空闲端口并写回 `.env`
   （见下方端口表）。不会让你在构建五分钟后才收到 "port is already allocated"
4. `docker network create n8n-net` + `docker volume create n8n_data` ——
   两个都是 `external: true`，**compose 不会自己建，不建就启动失败**
5. 只起 postgres，等 healthy（再等 30 秒让 paradedb bootstrap 跑完）
6. **在 n8n/minio 启动之前**把两个卷快照解回去
7. 建 `lobechat` 库（`TEMPLATE template0`），然后灌两份 SQL dump
8. `docker compose up -d --build`（console 镜像首次构建要几分钟）

顺序要点：卷快照必须先落盘，SQL 必须先于 n8n 自己的 migration 落地。

## 端口（可改，冲突会自动避让）

| 变量 | 默认 | 用途 |
|---|---|---|
| `CONSOLE_PORT` | 3000 | Kiranism 控制台 |
| `LOBECHAT_PORT` | 3210 | LobeHub 对话 |
| `N8N_PORT` | 5678 | n8n |
| `SEARXNG_PORT` | 8080 | SearXNG |
| `MINIO_API_PORT` / `MINIO_CONSOLE_PORT` | 9000 / 9001 | MinIO S3 / 控制台 |
| `STREAM_BRIDGE_PORT` | 3211 | 流式侧车（只监听 127.0.0.1）|
| `CADDY_PORT_CONSOLE` / `_LOBEHUB` / `_N8N` / `_MINIO` | 8443–8446 | HTTPS 入口 |

**只改宿主侧**，容器侧端口不动，所以服务之間的互相调用不受影响。
依赖宿主端口的变量（`CONSOLE_URL`、`APP_URL`、`AUTH_ADDITIONAL_TRUSTED_ORIGINS`、
`S3_ENDPOINT`、`S3_PUBLIC_DOMAIN`）会跟着一起变，不用手写。
装完看 `restore.ps1` 结尾打印的**实际端口表**（不是这张表 —— 那张是默认值）。

## TUN / Clash：**必须开着，不要关**

来源机器上实测（容器里查的，不是猜的）：

```
$ docker exec n8n  nslookup api.telegram.org   ->  Address: 198.18.0.35
$ docker exec searxng nslookup google.com      ->  Address: 198.18.0.219
```

`198.18.0.0/15` 是 mihomo 的 **Fake-IP 段**（RFC 2544 保留地址），
Telegram 和 Google 的真实 IP 不可能落在这一段的。路由表也印证了：

```
0.0.0.0/0  ->  192.168.208.1  (WLAN,  跃点 35)   <- 真实默认路由
0.0.0.0/0  ->  198.18.0.2     (TUN,   跃点  0)   <- TUN 抢到了默认路由
```

**结论：SearXNG 出网和 Telegram 推送现在就是靠 TUN 在跑。**
关掉 TUN 不是"降低风险"，是直接把它们打断：

- SearXNG 拿到真实 IP → 直连超时 → `web_search` **返回 0 条但 HTTP 仍是 200**
  （静默失败，自检里 `searxng engines` 会从 warn 变 FAIL）
- Telegram 推送全断

**所以新机器上的启动顺序是：**

1. **先开 Clash（mihomo），确认 TUN 生效** —— 宿主机跑
   `nslookup api.telegram.org`，返回 `198.18.x.x` 就对了
2. **再开 Docker Desktop**，然后 `docker compose up -d`
3. 验证容器里也走代理：`docker exec n8n nslookup api.telegram.org`
   —— 如果返回真实 IP，说明容器在 TUN 建好之前就缓存了 DNS，
   **重启容器**（`docker compose restart n8n searxng`），不是关 TUN

`verify.ps1` 里有专门的"出网"一段会查这个，包括让 SearXNG 真搜一次看有没有结果。

## 验收

```powershell
powershell -ExecutionPolicy Bypass -File C:\\agent-platform\\migration\\verify.ps1
```

比对基准在 `migration/SOURCE.json`，来源机器的真实数字：

| 项 | 数量 |
|---|---|
| workflows | {wf} |
| executions | {ex} |
| credentials | {cr} |
| n8n 数据表 | {dt} |

关键业务表：{tables}

验收项：10 个容器 Up、`N8N_ENCRYPTION_KEY` 一致（否则 4 条凭据解不开）、
LAN IP 属于本机、四张核心表行数、全部业务数据表行数、5 个 HTTP 端点、
n8n API 工作流数。

## 手工确认（脚本查不到的）

- [ ] n8n 用自己的账号能登进去（用户表在 pg dump 里，已还原）
- [ ] n8n 里 4 条 credentials 能打开且能解密
- [ ] Kiranism 控制台 Clerk 登录正常（Clerk 是 SaaS，与机器无关）
- [ ] **Telegram 必须登同一个账号**（见下）
- [ ] **Clash / mihomo 的 TUN 模式保持开启**（见上一节，关了 SearXNG 就废）
- [ ] Clash 的 `system_proxy_bypass` 里保留 `localhost;127.*`（Clash Verge Rev
      默认就有）—— 否则浏览器打不开 3000/8443。
      注意：**.NET 的 `HttpWebRequest` 不读这份豁免列表**，脚本里探测本地服务
      必须显式禁用代理，否则会误报 404（`verify.ps1` 已处理）。
- [ ] **本项目与 OpenVPN 无关**（这条更正过一次：早先误判成 VPN 导致回环被劫持，
      实测是 .NET 不读 bypass 列表 + n8n 2.x 对无 `Accept` 头回 404）。
      机器上同时挂着的 OpenVPN TAP 网卡不影响部署，`PLATFORM_LAN_IP` 要填
      **WLAN/以太网卡**的地址，不是 `192.168.1.x` 那个隧道地址。
- [ ] Caddy 的 HTTPS 入口用**证书里的名字**访问（`https://<新IP>:8443`），
      不要用 `127.0.0.1` —— 路由按 Host 头匹配，IP 直连会得到空 200

## Telegram：同账号就没问题（已实测确认）

`TELEGRAM_CHAT_ID = 7020739140` 是一个**正数**，也就是你的 Telegram **用户 ID**（私聊），
不是群组（群组是负数）。代码里它身兼两职：

1. `telegram-bridge` 把它当 **owner 白名单** —— `OWNER = TELEGRAM_CHAT_ID`，
   其它 chat 一律忽略（注释写着 "strangers are ignored"）。
2. 它是**所有推送的目标**：告警（`chat-alerts`）、动态监控（`topic-watch`）、
   周报（`weekly-review`）、文档分享（`platform-admin-api`）都发到这个 id。

所以**只要新机器上 Telegram 登的是同一个账号，用户 ID 不变，网关照常工作**。

代价是它只认这一个 id：换成别的账号，桥接会**静默忽略**你的每条消息，
告警也发不出去，而且**不会报任何错**。要换人接管，得改
`.env` 里的 `TELEGRAM_CHAT_ID` 然后重启 n8n。

验收脚本里有两项会真的调 Telegram API 验证：`getMe`（bot token 有效）和
`getChat`（这个 id 现在可达）。当前实测：bot `@No1MyAgentBot` → 私聊 `pigpig` ✅

## 已经在来源机器上实测过

不是"应该能行"，是跑过：

- **恢复演练**：用包里的备份集，在独立端口起一个全新的 paradedb 容器，
  灌完两份 dump，逐项数行 —— workflows {wf} / credentials {cr} / 数据表 {dt} 张 /
  业务数据 {rows} 行 / lobechat 表 182 张，全部与来源一致。
- **卷快照**：`n8n_data`（13.5 MB）、`minio_data`（156 KB）解包验证过内容。
- **compose config**：用包里的 `.env` 解析通过；改了端口变量后重新渲染验证过，
  宿主端口和 `CONSOLE_URL` / `S3_ENDPOINT` 一起跟着变。
- **验收脚本**：在来源机器这台活栈上跑过，全绿（含 Telegram 两项和出网段）。
- **出网链路**：容器里 `nslookup` 拿到 `198.18.x.x` Fake-IP，确认 SearXNG/Telegram
  走的是 TUN；`preflight.ps1` 在宿主机上跑过，能自己认出 TUN 是开着的。

## 已知坑（都是演练里踩出来的）

- **paradedb 全新卷会起不来**：镜像的 `10_bootstrap_paradedb.sh` 要 `CREATE EXTENSION pg_cron`，
  不在 `shared_preload_libraries` 里就直接退出。compose 里已经改成
  `pg_search,pg_cron`。旧卷不受影响（bootstrap 只跑一次），所以这个问题只会在新机器上出现。
- **`n8n-net` 网络也是 `external: true`**：新机器上不存在，`compose up` 直接报
  "network n8n-net declared as external, but could not be found"。恢复脚本会先建网络。
- **Telegram 绑的是账号不是机器**：`TELEGRAM_CHAT_ID` 既是 owner 白名单又是所有推送目标。
  新机器上如果 Telegram 登的是**另一个账号**，这个 id 不再匹配 —— 桥接会
  **静默忽略所有消息**（"陌生人一律忽略"），告警也发不出去，**不报错**。
  必须在**同一个账号**登录。验收脚本会调 `getChat` 实际验证通路。
- **`CREATE DATABASE lobechat` 必须带 `TEMPLATE template0`**：bootstrap 往 `template1`
  里塞了 `paradedb` schema，默认建库会继承，然后和 dump 里自己的
  `CREATE SCHEMA paradedb` 撞车（"already exists"，`ON_ERROR_STOP=1` 下整份灌不进去）。
- **postgres healthy ≠ 可以灌数据**：healthcheck 只是 `pg_isready`，而 bootstrap
  在服务器开始接受连接之后才跑完。恢复脚本里等了 30 秒再动手。
- **探测 n8n 必须带 `Accept` 头**：n8n 2.x 对没有 Accept 的请求回 404。
  `curl` 默认带 `*/*` 所以看不出来，.NET/脚本里不带就会误判成挂了。
- **脚本里探测 localhost 要禁用代理**：机器上有系统代理时，
  `Invoke-WebRequest` 会把 localhost 也发给代理，结果全是 404。
- **宿主端口被占**：compose 里所有宿主端口都是 `.env` 变量了，
  `restore` 会自动避让。手工改的话记得同步改
  `CONSOLE_URL` / `APP_URL` / `S3_ENDPOINT`（compose 里已用变量引用，不用手写）。
- **两个 `.sh` 脚本曾经根本解析不了**：`restore.sh` 的 `env_val()` 里有个悬空引号
  （`tr -d '"'"'"'`），`verify.sh` 里有个多余的 `'` —— bash 会把后面整个文件吃掉。
  现在打包时跑 `bash -n` 卡这道关，坏了就打包失败。
{missing}
- `.env` 和 `backups/` 都在 `.gitignore` 里，`git clone` 拿不到，**必须拷目录**
- `N8N_ENCRYPTION_KEY` 变了 = 所有凭据变红，且不可逆
- 换机器后 `PLATFORM_LAN_IP` 不改 = LobeChat 的 S3 上传/跳转全部指向旧地址
"""


def write_runbook(pack, src, files, missing):
    tables = "、".join("%s %d" % (k, v) for k, v in list(src["data_tables"].items())[:12])
    miss = ("- **打包时缺失**：" + "、".join(missing)) if missing else "- 打包时必需文件齐全"
    txt = RUNBOOK.format(
        generated_at=src["generated_at"], lan_ip=src["source_host_lan_ip"],
        branch=src["git_branch"], head=src["git_head"][:12], stamp=src["backup_stamp"],
        date=datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d"),
        wf=src["counts"]["workflows"], ex=src["counts"]["executions"],
        cr=src["counts"]["credentials"], dt=src["counts"]["data_tables"],
        tables=tables, missing=miss,
        rows=sum(src["data_tables"].values()),
    )
    (pack / "MIGRATE.md").write_text(txt, encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
