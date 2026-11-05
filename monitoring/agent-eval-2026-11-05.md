# Agent Evaluation: assertion hardening (Phase 4.3)

Date: 2026-11-05
Branch: `chore/agent-eval-assertions` (commit `2cc4d65`), cut from `main` (`c539dcc`)
Command: `node --env-file=.env n8n/scripts/agent-eval.mjs`

This phase does not add cases for their own sake. It repairs three assertions
that could pass a run that should have failed.

## What was wrong

1. **The server tool list was a copy.** The evaluator carried its own list of
   15 server tool names. The chat gateway arms 16. `meeting_actions` was
   missing, so `no_returned_server_tools` could not see a leak of that tool.
2. **The network case matched a word in the prose.** Its `content_any` list
   held both "不允许" and "允许", and "允许" is a substring of "不允许".
   Nothing in the case required the tool to have been called at all, so a
   model that reported a successful network call passed.
3. **The sandbox refused code by reading it.** `scan_code` matched regexes
   over the snippet text; the file's own comment said it was "a speed bump,
   not a sandbox boundary". A renamed import (`importlib.import_module`) or a
   renamed builtin (`f = eval`) walked around it.

## What changed

| File | Change |
| --- | --- |
| `n8n/scripts/agent-eval.mjs` | the server tool list is parsed from the gateway workflow that owns it (16 names, `meeting_actions` included); a preflight aborts the run when a case names a tool the gateway does not have; new `trace_args_include` and `trace_blocked` assertions |
| `n8n/workflows/chat-gateway.json` | the tool trace now carries `blocked` and `reason`, so a refusal is recorded by the platform itself and not only claimed in prose |
| `n8n/eval/agent-set.json` | the network case now asks the trace; six new sandbox cases walk around the text scan |
| `n8n/sandbox_server.py` | a runtime guard runs inside the child, before the user code does |

The gateway workflow must be redeployed before the new trace assertions can
pass. A trace without the `blocked` field is reported as such rather than
counted as a refusal.

## The sandbox has two layers now

The static scan still runs first: it is fast and it returns a reason a human
can read ("socket（联网）"). The runtime guard is installed in the child
before the user code runs:

- denied modules are refused at import time, including `importlib`, which
  never raises an import audit event and therefore cannot be caught by the
  audit hook alone;
- `eval`, `exec` and `compile` are refused when the snippet itself calls them
  — the import machinery and `collections.namedtuple` also call them, so the
  guard decides by the calling frame, not by the name of the builtin;
- writes, process spawns, socket calls and `ctypes` are refused by an audit
  hook, which sees the operation rather than the text.

The snippet is executed as `__main__`, as it was when it ran as a script, so
`if __name__ == '__main__':` still fires. The guard identifies "the caller is
the snippet" by the file name of the calling code object, which the snippet
cannot rename from the inside.

The real boundary is still the container plus the rlimits. A determined
snippet can walk the interpreter stack to recover the original builtins; the
guard stops the ordinary escapes without waiting for a human and makes the
refusal legible in the audit log.

## What was verified, and how

| Check | How it was run | Result |
| --- | --- | --- |
| Sandbox guard, both layers | `python n8n/sandbox_server.py --self-test` | 16/16 |
| Sandbox cases through the evaluator | local sandbox on `127.0.0.1:18080`, `EVAL_SANDBOX_URL` pointed at it | 12/12 |
| Network case, honest run | local fake gateway returning a real refusal trace | PASS |
| Network case, claimed success | same fake gateway, the model never called the tool | FAIL on 4 assertions |
| Network case, wrong code | same fake gateway, the model called `run_python` with other code | FAIL on 3 assertions |
| Tool-list preflight | a case naming a tool the gateway does not have | run aborted, exit 1 |
| Workflow JSON | `node n8n/scripts/validate-workflows.mjs` | 26 files, 0 warnings |
| Harness syntax | `node --check n8n/scripts/agent-eval.mjs` | clean |
| Sandbox syntax | `python -m py_compile n8n/sandbox_server.py n8n/sandbox_job.py` | clean |
| Credentials in the diff | `bash scripts/secret-scan.sh --self-test` and `--added main..HEAD` | pass (exit 0) |

The network case is the one that used to be decorative. It now has three
independent ways to fail: the tool must appear in the trace, it must have been
called with the socket code, and the platform must have refused it.

## What was not run

- **The chat and MCP cases against the real gateway.** This box has no n8n
  stack running, so the network case was exercised against a local fake
  gateway that replays a canned answer and a canned trace. The assertions
  were verified; the live model, the live workflow and the live
  `chat_executions` row were not.
- **The container behaviour of the runtime guard.** Docker's engine is off on
  this box, so the guard was never exercised under the container's Python
  3.14 on musl, and `rlimits` (CPU, address space, file size, open files)
  were never applied. The local runs used CPython 3.12.10 on Windows, where
  `resource` does not exist; the sandbox reports `rlimits_applied: false`
  there, and `--self-test` runs without rlimits for the same reason.
- **A full run against the deployed stack.** The numbers in the 2026-10-29
  baseline (12/12) still describe the previous phase. Re-run the command on a
  box with the stack up, after the gateway workflow is redeployed, before
  quoting a new pass rate.

## How to re-run

```powershell
node --env-file=.env n8n/scripts/agent-eval.mjs
```

The sandbox guard can be checked on its own, without the stack:

```powershell
python n8n/sandbox_server.py --self-test
```

A non-zero exit from either command means a contract failed. The report now
lists the server tool names it derived from the gateway, so a gateway that
gained or lost a tool shows up in the report itself.
