#!/usr/bin/env python3
"""Fetch live platform data via n8n APIs into a single JSON bundle.
This becomes the data backbone for the demo deck + renderings.
"""
import json, urllib.request, urllib.parse
from pathlib import Path
from datetime import datetime, timezone, timedelta

N8N_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxYTIzNzhjMC1mMWI5LTRkMjMtYjhmNy01MTVlZDFmZGY3NTIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiMmYyZDliNGYtZTc4Ny00YzljLWIzMTktZjg3YWFiMjVkZGUyIiwiaWF0IjoxNzg4NDM2NTI2LCJleHAiOjE3OTEwMDAwMDB9.U8X2pv2LR-sLeR8YPhIDQAdXCNE5tQEkxTVKNug4pWA"
CHAT_KEY = "sk-n8n-agent"
BASE = "http://localhost:5678"
H_N8N = {"X-N8N-API-KEY": N8N_KEY, "Accept": "application/json"}
H_ADM = {"Authorization": "Bearer " + CHAT_KEY, "Accept": "application/json"}

# all data table IDs from /api/v1/data-tables
TABLES = {
    "telegram_state":   "RrDOLDiMFWTGBxCJ",
    "daily_briefs":     "V9b4noF6hmOvG36I",
    "heartbeats":       "EOIcWrHcX0rqEk4X",
    "chat_messages":    "ayFdcG2zQCzkYdz0",
    "chat_executions":  "rS98dlI0DJWv2WK9",
    "gateway_keys":     "VeFow6B0Xs47gchR",
    "selfcheck_runs":   "Ll2BgVwmkQC1DB6q",
    "cron_runs":        "m5WSpuYJe8anVHHc",
    "tool_contract":    "cUXEzybyGq9p4NsY",
    "todos":            "riYlT2xyyMuNobGJ",
    "admin_audit":      "nOdlrXgcAxb7SPU5",
    "ops_alerts":       "kKH6wg6OdlFqa6X1",
    "documents":        "OHWnQE0xLvqGSHWl",
    "reminders":        "WHUezfAd0d4XvLNm",
    "mcp_servers":      "vnDHMZkVeM71Gq1P",
    "sandbox_approvals":"iMccDiKmLbRq3Tt9",
    "topic_watch":      "vPTcsx3RpMKRbxjZ",
    "kb_usage":         "lYuvFwwXS3Pl7f2n",
    "people":           "mwD5VrCb7y5Z98Fp",
    "weekly_reviews":   "aTEHkK0coJH1yojl",
    "workflow_tools":   "6qcmuDJ5B61ogKpV",
}

def get(path, headers=H_N8N):
    req = urllib.request.Request(BASE + path, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def rows(table_id, limit=80, extra=""):
    """Fetch rows. Use extra for filter/sort."""
    qs = f"limit={limit}"
    if extra: qs += "&" + extra
    d = get(f"/api/v1/data-tables/{table_id}/rows?{qs}")
    return d.get("data", [])

out = {}

out["_meta"] = {
    "fetched_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
    "source": "live n8n API",
}

# 1. workflows
wf = get("/api/v1/workflows?limit=50&fields=id,name,active,updatedAt,nodes,settings")
out["workflows"] = [{"id": w["id"], "name": w["name"], "nodes": len(w.get("nodes", [])),
                      "active": w.get("active"), "updated": w.get("updatedAt")} for w in wf["data"]]
out["workflows"].sort(key=lambda w: w["nodes"], reverse=True)

# 2. recent executions
exs = get("/api/v1/executions?limit=20&includeData=false")
out["executions_recent"] = exs["data"][:10]

# 3. tool contract (the 12 server tools)
tc = rows(TABLES["tool_contract"], limit=30)
out["tool_contract"] = tc

# 4. chat executions (recent tool usage traces)
ce = rows(TABLES["chat_executions"], limit=20)
out["chat_executions"] = ce

# 5. KB usage (recent)
ku = rows(TABLES["kb_usage"], limit=20)
out["kb_usage"] = ku

# 6. selfcheck runs (latest)
sc = rows(TABLES["selfcheck_runs"], limit=3)
out["selfcheck"] = sc

# 7. ops alerts
oa = rows(TABLES["ops_alerts"], limit=10)
out["ops_alerts"] = oa

# 8. reminders (open)
rm = rows(TABLES["reminders"], limit=20)
out["reminders"] = rm

# 9. todos (open)
td = rows(TABLES["todos"], limit=20)
out["todos"] = td

# 10. mcp servers
ms = rows(TABLES["mcp_servers"], limit=10)
out["mcp_servers"] = ms

# 11. cron runs (last week)
cr = rows(TABLES["cron_runs"], limit=20)
out["cron_runs"] = cr

# 12. daily briefs
db = rows(TABLES["daily_briefs"], limit=5)
out["daily_briefs"] = db

# 13. chat messages count + latest
cm = rows(TABLES["chat_messages"], limit=8)
out["chat_messages"] = cm

# 14. people directory
pp = rows(TABLES["people"], limit=20)
out["people"] = pp

# 15. heartbeats
hb = rows(TABLES["heartbeats"], limit=8)
out["heartbeats"] = hb

# 16. admin overview via bearer
try:
    req = urllib.request.Request(BASE + "/webhook/admin/overview", headers=H_ADM)
    with urllib.request.urlopen(req, timeout=15) as r:
        out["admin_overview"] = json.loads(r.read())
except Exception as e:
    out["admin_overview"] = {"error": str(e)}

# 17. alerts via bearer
try:
    req = urllib.request.Request(BASE + "/webhook/admin/alerts", headers=H_ADM)
    with urllib.request.urlopen(req, timeout=15) as r:
        out["admin_alerts"] = json.loads(r.read())
except Exception as e:
    out["admin_alerts"] = {"error": str(e)}

# write
Path("demo-assets").mkdir(exist_ok=True)
Path("demo-assets/_data.json").write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
print(f"✅ demo-assets/_data.json  ({Path('demo-assets/_data.json').stat().st_size//1024} KB)")
print(f"   workflows: {len(out['workflows'])}, executions: {len(out['executions_recent'])}")
print(f"   tool_contract: {len(out['tool_contract'])}, chat_executions: {len(out['chat_executions'])}")
print(f"   reminders: {len(out['reminders'])}, todos: {len(out['todos'])}, ops_alerts: {len(out['ops_alerts'])}")