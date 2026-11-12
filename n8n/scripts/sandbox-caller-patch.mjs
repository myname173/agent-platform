// Deploy-time patch for the chat-gateway run_python call path (P1 admission).
// Extracted from deploy.mjs so the offline contract tests can apply it to the
// committed workflow JSON without booting the deploy script (which requires
// N8N_API_KEY and talks to a live instance).
//
// Two effects, both idempotent:
//  1. Route ordinary run_python calls through the K8s Job gateway when
//     SANDBOX_URL is configured. Approved network calls retain the Compose
//     sandbox because the pilot Job has a deny-all NetworkPolicy by design.
//  2. Send x-sandbox-caller: chat-gateway so the gateway's admission layer
//     can attribute rate limits and metrics. The header is accounting, not
//     authentication; the shared x-sandbox-key stays the trust boundary.

export function patchPlatformSandboxCaller(wf) {
  const execute = (wf.nodes || []).find((item) => item.name === 'Execute Tool');
  if (!execute?.parameters?.jsCode) return wf;

  if (!execute.parameters.jsCode.includes('SANDBOX_APPROVED_URL')) {
    const marker = [
      "const callSandbox = (allowNetwork) => this.helpers.httpRequest({",
      "        method: 'POST',",
      "        url: 'http://n8n-sandbox:8000/run',",
    ].join('\n');
    const replacement = [
      "const callSandbox = (allowNetwork) => this.helpers.httpRequest({",
      "        method: 'POST',",
      "        url: ((allowNetwork ? ($env.SANDBOX_APPROVED_URL || $env.SANDBOX_URL) : ($env.SANDBOX_URL || 'http://n8n-sandbox:8000')).replace(/\\/$/, '')) + '/run',",
    ].join('\n');
    if (execute.parameters.jsCode.includes(marker)) execute.parameters.jsCode = execute.parameters.jsCode.replace(marker, replacement);
  }

  // Instances already carrying the URL patch still need the identity header;
  // match the exact callSandbox header line (unique inside Execute Tool).
  const headerMarker = "headers: { 'x-sandbox-key': $env.CHAT_API_KEY || '', 'Content-Type': 'application/json' },";
  const headerReplacement = "headers: { 'x-sandbox-key': $env.CHAT_API_KEY || '', 'x-sandbox-caller': 'chat-gateway', 'Content-Type': 'application/json' },";
  if (execute.parameters.jsCode.includes(headerMarker) && !execute.parameters.jsCode.includes("'x-sandbox-caller'")) {
    execute.parameters.jsCode = execute.parameters.jsCode.replace(headerMarker, headerReplacement);
  }
  return wf;
}