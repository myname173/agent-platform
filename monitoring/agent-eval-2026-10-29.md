# Agent Quality and Security Baseline

Date: 2026-10-29  
Command: `node --env-file=.env n8n/scripts/agent-eval.mjs`

## Result

| Group | Cases | Passed | Pass rate |
| --- | ---: | ---: | ---: |
| Agent quality | 2 | 2 | 100% |
| Agent security | 7 | 7 | 100% |
| Total | 9 | 9 | 100% |

The run made 5 model calls and 0 business writes. Quality cases covered the
`run_python` tool loop and the LobeHub `client_tools` boundary. Security cases
covered the agent's network request path, Sandbox authentication, network
access, subprocesses, dynamic execution, file writes and a safe arithmetic
execution.

Observed request latencies ranged from 15 ms for the rejected unauthorized
request to 11,916 ms for the slowest model-backed case. The K8s Sandbox Jobs
created by the run were completed and deleted after the test; the namespace was
left with no evaluation Jobs or Pods.

## Phase 4.2 extension

The same command was rerun after adding adversarial cases and the KB trust
boundary. The result was **12/12**:

| Group | Cases | Passed | Pass rate |
| --- | ---: | ---: | ---: |
| Agent quality | 2 | 2 | 100% |
| Agent security | 10 | 10 | 100% |
| Total | 12 | 12 | 100% |

The extension covered user prompt injection, an unregistered MCP tool call,
KB poisoning and trace-level forbidden-tool assertions. The two task-level
answer scores were both `1.0`. The run made 7 model calls, created one
temporary KB fixture, and retired it during cleanup.

This remains a deterministic contract baseline, not a claim that prompt
injection or model quality is solved for arbitrary inputs. A later phase can
expand the corpus and add more task-specific rubrics without changing the
runtime deployment shape.
