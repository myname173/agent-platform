#!/usr/bin/env python3
"""Dry-run the migration pack's restore path WITHOUT touching the live stack.

Spins a throwaway postgres on a spare port with its own volume, replays the
pack's dumps into it, and counts rows. If this passes, the dumps are loadable
and the restore recipe is sound — the only untested part is the target
machine's own docker/network setup.

Also unpacks the two volume archives into throwaway volumes to prove the
tar/restore command in restore.ps1 actually works.

Usage:  python scripts/test-restore-pack.py [--keep]
"""
from pathlib import Path
import subprocess, sys, time, json

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / "dist" / "agent-platform-migration-20260929"
DATA = PACK / "data"
PORT = "55433"
CT = "pgtest_migration"
VOL = "pgtest_migration_data"


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def out(cmd, **kw):
    r = sh(cmd, **kw)
    return (r.stdout or "").strip()


def env_value(name):
    for line in (ROOT / ".env").read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(name + "="):
            return line[len(name) + 1:].strip().strip("'").strip('"')
    return ""


def pick(glob):
    fs = sorted(DATA.glob(glob))
    return fs[-1] if fs else None


def main():
    keep = "--keep" in sys.argv
    pw = env_value("POSTGRES_PASSWORD")
    user = env_value("POSTGRES_USER") or "n8n"
    db = env_value("POSTGRES_DB") or "n8n"
    ok = True

    print("=== 1. compose config parses with the packed .env ===")
    r = sh(["docker", "compose", "-f", str(PACK / "project" / "docker-compose.yml"),
            "--env-file", str(PACK / "project" / ".env"), "config"])
    print("  exit=%d  lines=%d" % (r.returncode, len((r.stdout or "").splitlines())))
    if r.returncode != 0:
        print("  " + (r.stderr or "")[:600]); ok = False
    else:
        cfg = r.stdout
        for need in ("n8n_data", "postgres_data_pg17", "minio_data"):
            print("  mentions %-20s %s" % (need, need in cfg))
        if "postgres_data_pg17" not in cfg: ok = False

    print("\n=== 2. volume archives unpack cleanly ===")
    for vol, glob in (("n8n_data", "n8n-data-*.tar.gz"), ("minio_data", "minio-data-*.tar.gz")):
        f = pick(glob)
        if not f:
            print("  ! missing %s" % glob); ok = False; continue
        test_vol = "pytest_" + vol
        sh(["docker", "volume", "rm", "-f", test_vol])
        sh(["docker", "volume", "create", test_vol])
        mount = str(DATA).replace("\\", "/")
        r = sh(["docker", "run", "--rm", "-v", "%s:/vol" % test_vol,
                "-v", "%s:/src:ro" % mount, "alpine",
                "sh", "-c", "tar xzf /src/%s -C /vol" % f.name])
        if r.returncode != 0:
            print("  ! untar %s failed: %s" % (f.name, (r.stderr or "")[:200])); ok = False
        else:
            listing = out(["docker", "run", "--rm", "-v", "%s:/vol" % test_vol,
                           "alpine", "sh", "-c", "ls /vol | head -8; echo ---; du -sh /vol"])
            print("  %-12s <- %s\n      %s" % (vol, f.name, listing.replace("\n", "\n      ")))
        sh(["docker", "volume", "rm", "-f", test_vol])

    print("\n=== 3. replay SQL dumps into a throwaway postgres (port %s) ===" % PORT)
    sh(["docker", "rm", "-f", CT]); sh(["docker", "volume", "rm", "-f", VOL])
    sh(["docker", "volume", "create", VOL])
    r = sh(["docker", "run", "-d", "--name", CT,
            "-e", "POSTGRES_USER=%s" % user, "-e", "POSTGRES_PASSWORD=%s" % pw,
            "-e", "POSTGRES_DB=%s" % db,
            "-p", "%s:5432" % PORT, "-v", "%s:/var/lib/postgresql/data" % VOL,
            "paradedb/paradedb:latest-pg17",
            # pg_cron must be preloaded or a FRESH volume dies during
            # paradedb's bootstrap (CREATE EXTENSION pg_cron).
            "postgres", "-c", "shared_preload_libraries=pg_search,pg_cron"])
    if r.returncode != 0:
        print("  ! could not start test postgres: %s" % (r.stderr or "")[:300]); return 1
    for _ in range(60):
        q = sh(["docker", "exec", CT, "pg_isready", "-U", user, "-d", db])
        if q.returncode == 0: break
        time.sleep(2)
    print("  pg_isready ok")
    # The server starts accepting connections BEFORE paradedb's
    # 10_bootstrap_paradedb.sh finishes. Load too early and the bootstrap
    # errors out, the entrypoint exits, and the server shuts down mid-load.
    time.sleep(25)
    st = out(["docker", "inspect", "-f", "{{.State.Status}}", CT])
    print("  status after bootstrap settle: %s" % st)
    if st != "running":
        print("  ! bootstrap killed the container:\n" +
              (sh(["docker", "logs", CT]).stdout or "")[-1500:])
        return 1

    # TEMPLATE template0: paradedb's bootstrap puts a `paradedb` schema in
    # template1, which a default CREATE DATABASE would inherit and then clash
    # with the dump's own CREATE SCHEMA paradedb.
    sh(["docker", "exec", CT, "psql", "-U", user, "-d", "postgres",
        "-c", "CREATE DATABASE lobechat TEMPLATE template0"])

    results = {}
    for name, glob in (("n8n", "pg-n8n-*.sql.gz"), ("lobechat", "pg-lobechat-*.sql.gz")):
        f = pick(glob)
        t0 = time.time()
        print("  loading %s -> db %s ..." % (f.name, name))
        psql = "gunzip -c | psql -U %s -d %s -v ON_ERROR_STOP=1 -q" % (user, name)
        with open(f, "rb") as fh:
            r = subprocess.run(["docker", "exec", "-i", CT, "sh", "-c", psql],
                               stdin=fh, capture_output=True, text=True, errors="ignore")
        dt = time.time() - t0
        if r.returncode != 0:
            print("  ! FAILED (%.0fs)\n%s" % (dt, (r.stderr or r.stdout or "")[-1500:]))
            lg = sh(["docker", "logs", "--tail", "25", CT])
            print("  --- container log tail ---\n" + ((lg.stdout or "") + (lg.stderr or ""))[-1500:])
            ok = False
        else:
            print("  loaded in %.0fs" % dt)
            errs = [l for l in (r.stderr or "").splitlines() if "ERROR" in l]
            if errs:
                print("  ! psql reported errors: %s" % errs[:3]); ok = False

    print("\n=== 4. row counts in the restored database ===")
    checks = {
        "workflows": ("select count(*) from workflow_entity", 24),
        "credentials": ("select count(*) from credentials_entity", 4),
        "data_tables": ("select count(*) from data_table", 23),
        "data_rows": ("""select sum((xpath('/row/c/text()', query_to_xml(
            format('select count(*) as c from %I','data_table_user_'||id),false,true,'')))[1]::text::bigint)
            from data_table""", 4000),
        "users": ("select count(*) from \"user\"", 1),
    }
    lobechat_tables = None
    for label, (sql, want) in checks.items():
        v = out(["docker", "exec", CT, "psql", "-U", user, "-d", db, "-tAc", sql])
        try:
            got = int(v)
        except ValueError:
            got = None
        good = got is not None and got >= want
        print("  %-14s got=%-8s want>=%-6s %s" % (label, got, want, "OK" if good else "FAIL"))
        if not good: ok = False
        results[label] = got

    lobechat_tables = out(["docker", "exec", CT, "psql", "-U", user, "-d", "lobechat", "-tAc",
                           "select count(*) from information_schema.tables "
                           "where table_schema not in ('pg_catalog','information_schema')"])
    n = int(lobechat_tables) if (lobechat_tables or "").isdigit() else -1
    print("  %-14s got=%-8s want>=%-6s %s" % ("lobechat tbls", n, 50, "OK" if n >= 50 else "FAIL"))
    if n < 50: ok = False
    results["lobechat_tables"] = n

    if not keep:
        print("\ncleaning up ...")
        sh(["docker", "rm", "-f", CT]); sh(["docker", "volume", "rm", "-f", VOL])
        print("removed %s + volume %s" % (CT, VOL))
    else:
        print("\nkept container %s on port %s" % (CT, PORT))

    print("\nRESULT: %s" % ("PASS - dumps are loadable" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
