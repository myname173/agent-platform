// Canonical web_fetch follow-up layer: read the full text of a public web page.
// Dependency-free (httpRequest is injected, like pg/rerank/CRAG) so it is
// importable by the offline contract tests without a network.
//
// n8n Code nodes run in a runner sandbox that only allows `pg` and `crypto`
// (NODE_FUNCTION_ALLOW_EXTERNAL=pg, NODE_FUNCTION_ALLOW_BUILTIN=crypto), so they
// cannot import this file. The region between the EMBED markers below is copied
// VERBATIM into the gateway Code node:
//   - n8n/workflows/chat-gateway.json  (Execute Tool, web_fetch branch)
// n8n/scripts/web-fetch.test.mjs asserts the copy has not drifted.
//
// web_fetch is a NEW TOOL, not a kb_search stage: it lives in Execute Tool (and
// optionally Do MCP), NOT in kb-ingest, so it is deliberately NOT part of the
// KB-HYBRID-EMBED region (that region is the kb_search retrieval pipeline).
//
// This is a BOUNDED fetch-and-read tool, NOT a browsing agent: one HTTP GET per
// call (no headless browser, no JS rendering, no crawl), a HEURISTIC pure-JS
// HTML->text stripper (no readability/cheerio dep — the sandbox forbids them),
// a hostname/literal-IP SSRF guard with redirects disabled. It must NOT be
// claimed as readability-grade extraction, injection-proof, or resolve-time
// pinned SSRF protection.
//
// §9.13 (AGENTS.md) does NOT apply here: this is HTTP, not pg, so try/catch is
// effective and a failure returns a fail-open {ok:false,reason} envelope instead
// of killing the runner. DNS-rebinding protection is structurally unavailable
// (the `dns` module is not allowlisted), so the guard checks the hostname string
// and literal IPs only; that residual is documented, not hidden.

// >>> WEB-FETCH-EMBED-BEGIN (verbatim copy into workflow Code nodes; drift-guarded)
// Bounds. Timeout is tighter than the 20s standalone web_search so a fetch cannot
// blow up the agent round; maxChars clamps the extracted text fed to the model;
// maxBytes is a best-effort content-length gate (httpRequest has no streaming
// download cap, so the body is fetched then rejected if oversized). All env-tunable.
const WEB_FETCH_TIMEOUT_MS = 12000;
const WEB_FETCH_MAX_CHARS = 6000;
const WEB_FETCH_MAX_BYTES = 200000;
// Internal docker-network service names. The single-label deny below already
// catches every one of these (public DNS hosts always contain a dot); this list
// is belt-and-suspenders + an operator extension point (cfg.denyHosts).
const WEB_FETCH_DENY_HOSTS = [
  'localhost', 'searxng', 'n8n', 'postgres', 'redis', 'minio', 'stream-bridge',
  'platform-runtime', 'n8n-sandbox', 'console', 'caddy', 'kafka', 'prometheus',
  'platform-worker', 'platform-outbox-publisher', 'platform-event-consumer', 'platform-backup',
];

// IPv4 literal danger ranges (SSRF targets). Pure. Malformed octets => deny.
function isPrivateIPv4(host) {
  const p = String(host).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = p[0], b = p[1];
  if (a === 0) return true;                          // 0.0.0.0/8 "this network"
  if (a === 10) return true;                         // RFC1918
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 168) return true;           // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                         // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

// IPv6 literal danger ranges. Pure. Conservative for loopback/link-local/ULA and
// IPv4-mapped addresses; other (public) IPv6 is allowed. IPv4-mapped (::ffff:…)
// is denied wholesale: the URL global hex-normalizes the embedded IPv4 (e.g.
// ::ffff:127.0.0.1 -> ::ffff:7f00:1), and a public fetch has no legitimate need
// for a mapped literal, so denying the whole class closes the bypass simply.
function isPrivateIPv6(host) {
  const h = String(host).toLowerCase();
  if (h === '::1' || h === '::') return true;        // loopback / unspecified
  if (/^fe80:/.test(h)) return true;                 // link-local
  if (/^f[cd]/.test(h)) return true;                 // unique-local fc00::/7
  if (/^::ffff:/.test(h)) return true;               // IPv4-mapped (conservative deny-all)
  return false;
}

// SSRF guard. Runs BEFORE any network call. Pure (uses the URL global only).
// Returns {ok:true,url,host} for a public http(s) URL, or {ok:false,reason}.
// Denies: non-http schemes, userinfo, loopback/RFC1918/link-local/metadata/CGNAT/
// multicast literals, internal service names, single-label hosts, *.internal/
// *.local/*.localhost. DNS-rebinding (a public name resolving to a private IP) is
// a documented residual: `dns` is not allowlisted, so resolve-time pinning is
// impossible here. cfg.denyHosts optionally extends the internal-name list.
function assertPublicUrl(rawUrl, cfg) {
  const c = cfg || {};
  const s = String(rawUrl == null ? '' : rawUrl).trim();
  if (!s) return { ok: false, reason: 'empty_url' };
  if (typeof URL !== 'function') return { ok: false, reason: 'url_parser_unavailable' };
  let u;
  try { u = new URL(s); } catch (e) { return { ok: false, reason: 'malformed_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'blocked_scheme' };
  if (u.username || u.password) return { ok: false, reason: 'blocked_userinfo' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.replace(/^\[|\]$/g, '');         // strip IPv6 brackets
  if (!bare) return { ok: false, reason: 'empty_host' };
  // IP literals FIRST (they carry no DNS name). The URL global normalizes short/
  // hex/octal/decimal IPv4 (127.1, 0x7f000001, 2130706433) to dotted-quad, so the
  // IPv4 check below catches those SSRF bypass forms too.
  if (bare.indexOf(':') !== -1) {                    // IPv6 literal
    if (isPrivateIPv6(bare)) return { ok: false, reason: 'blocked_private_url' };
    return { ok: true, url: u.href, host: bare };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {        // IPv4 literal
    if (isPrivateIPv4(bare)) return { ok: false, reason: 'blocked_private_url' };
    return { ok: true, url: u.href, host: bare };
  }
  // Hostname rules (public DNS names always contain a dot).
  const deny = Array.isArray(c.denyHosts) && c.denyHosts.length ? c.denyHosts.map((x) => String(x).toLowerCase()) : WEB_FETCH_DENY_HOSTS;
  if (deny.indexOf(bare) !== -1) return { ok: false, reason: 'blocked_private_url' };
  if (bare.indexOf('.') === -1) return { ok: false, reason: 'blocked_private_url' }; // single-label = internal
  // .internal/.local/.localhost = internal; nip.io/sslip.io/xip.io = wildcard DNS
  // that resolves to an embedded IP (a common rebinding vector — mitigate the
  // known services; arbitrary rebinding domains remain a documented residual).
  if (/\.(internal|local|localhost|nip\.io|sslip\.io|xip\.io)$/.test(bare)) return { ok: false, reason: 'blocked_private_url' };
  return { ok: true, url: u.href, host: bare };      // public hostname (rebinding residual)
}

// Decode the common HTML entities (numeric first, named, amp LAST so &amp;lt;
// decodes once to &lt;, not <). Pure.
function decodeEntities(s) {
  const cp = (n) => (Number.isFinite(n) && n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : '');
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

// Heuristic HTML -> readable text. NOT readability-grade: strips non-content
// blocks, prefers <article>/<main>, turns block boundaries into newlines, drops
// tags, decodes entities, collapses whitespace, clamps to maxChars. Pure. JS-
// rendered content is missed (no browser); some boilerplate may leak. Returns
// {text, title}.
function extractReadableText(html, maxChars) {
  const cap = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Number(maxChars) : WEB_FETCH_MAX_CHARS;
  let s = String(html == null ? '' : html);
  let title = '';
  const tm = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) title = decodeEntities(tm[1]).replace(/\s+/g, ' ').trim().slice(0, 200);
  s = s.replace(/<(script|style|noscript|template|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  const am = s.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  if (am) s = am[2];
  else { const bm = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i); if (bm) s = bm[1]; }
  s = s.replace(/<\/(p|div|section|article|main|li|tr|h[1-6]|blockquote|pre)>/gi, '\n');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n').replace(/^\s+|\s+$/g, '');
  if (s.length > cap) s = s.slice(0, cap);
  return { text: s, title };
}

// Wrap extracted text as explicitly-untrusted quoted data and strip C0/C1 control
// chars (keep tab=9 and newline=10). This REDUCES the prompt-injection surface
// (delimiter + the DIRECTIVE "data not instructions" rule); it does NOT eliminate
// injection. Pure. Uses charCodeAt (no regex unicode escapes) to stay sandbox-safe.
function sanitizeUntrusted(text, url) {
  const src = String(text == null ? '' : text);
  let s = '';
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    if (code === 9 || code === 10) { s += src[i]; continue; }
    if (code < 32 || (code >= 127 && code <= 159)) continue;
    s += src[i];
  }
  const u = String(url == null ? '' : url);
  return '<<<UNTRUSTED_WEB_CONTENT url=' + u + '>>>\n' + s + '\n<<<END_UNTRUSTED_WEB_CONTENT>>>';
}

// Bounded fetch-and-read. `httpRequest` is injected like pg/rerank/CRAG so the
// module stays dependency-free and offline-testable. cfg = {timeoutMs, maxChars,
// maxBytes, allowRedirects, denyHosts}. Flow: SSRF guard (before any network) ->
// bounded GET (redirects disabled by default) -> status/content-type/byte gates ->
// heuristic extract -> sanitize -> provenance. Fail-open is the central safety
// property: ANY guard rejection / timeout / non-2xx / redirect / bad content-type
// / oversized body / error returns {ok:false,url,reason}, NEVER throws into the
// host (HTTP not pg, so try/catch is effective; §9.13 does not apply). One URL per
// call, never recursive; the agent loop and MAX_TOOL_ROUNDS are untouched.
// Success: {ok:true,url,title,fetched_at,chars,text,source:'web_fetch'} where text
// is the sanitized, clamped, delimiter-wrapped page text and chars is the
// pre-sanitization extracted length.
async function fetchWebPage(httpRequest, cfg, rawUrl) {
  const c = cfg || {};
  const guard = assertPublicUrl(rawUrl, c);
  if (!guard.ok) return { ok: false, url: String(rawUrl == null ? '' : rawUrl), reason: guard.reason };
  if (typeof httpRequest !== 'function') return { ok: false, url: guard.url, reason: 'no_http_client' };
  const timeout = Number(c.timeoutMs) || WEB_FETCH_TIMEOUT_MS;
  const maxChars = Number(c.maxChars) || WEB_FETCH_MAX_CHARS;
  const maxBytes = Number(c.maxBytes) || WEB_FETCH_MAX_BYTES;
  const allowRedirects = c.allowRedirects === true || String(c.allowRedirects == null ? '' : c.allowRedirects).toLowerCase() === 'true';
  try {
    const resp = await httpRequest({
      method: 'GET',
      url: guard.url,
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain,application/json', 'User-Agent': 'Mozilla/5.0 (compatible; PlatformWebFetch/1.0)' },
      timeout,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      followRedirect: allowRedirects,
    });
    const status = Number(resp && resp.statusCode) || 0;
    if (status >= 300 && status < 400) return { ok: false, url: guard.url, reason: 'redirect_blocked' };
    if (status < 200 || status >= 300) return { ok: false, url: guard.url, reason: 'http_' + status };
    const headers = (resp && resp.headers) || {};
    const ct = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
    if (ct && !/text\/html|application\/xhtml\+xml|text\/plain|application\/json/.test(ct)) return { ok: false, url: guard.url, reason: 'unsupported_content_type' };
    const clen = Number(headers['content-length'] || headers['Content-Length'] || 0);
    if (clen && clen > maxBytes) return { ok: false, url: guard.url, reason: 'too_large' };
    const body = resp && resp.body;
    if (body == null || body === '') return { ok: false, url: guard.url, reason: 'empty_body' };
    let html = typeof body === 'string' ? body : (typeof Buffer !== 'undefined' && Buffer.isBuffer(body) ? body.toString('utf8') : (typeof body === 'object' ? JSON.stringify(body) : String(body)));
    if (html.length > maxBytes) html = html.slice(0, maxBytes); // best-effort post-download bound (char proxy)
    let text, title;
    if (/application\/json/.test(ct)) { text = html.slice(0, maxChars); title = ''; }
    else { const ex = extractReadableText(html, maxChars); text = ex.text; title = ex.title; }
    const safe = sanitizeUntrusted(text, guard.url);
    return { ok: true, url: guard.url, title, fetched_at: new Date().toISOString(), chars: text.length, text: safe, source: 'web_fetch' };
  } catch (e) {
    // Timeout / network error / bad shape: fail-open, legible reason, never throw.
    return { ok: false, url: guard.url, reason: 'fetch_failed' };
  }
}
// <<< WEB-FETCH-EMBED-END

export { assertPublicUrl, extractReadableText, sanitizeUntrusted, fetchWebPage, isPrivateIPv4, isPrivateIPv6, decodeEntities, WEB_FETCH_TIMEOUT_MS, WEB_FETCH_MAX_CHARS, WEB_FETCH_MAX_BYTES, WEB_FETCH_DENY_HOSTS };