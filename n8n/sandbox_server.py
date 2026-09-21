#!/usr/bin/env python3
"""Code execution sandbox for agent-platform.

Why this exists: the agent could remember and retrieve things but never
*produce* anything — "analyse this CSV", "turn these numbers into a table",
"parse this blob" were all impossible. The n8n-sandbox container was already
in the stack doing nothing (it ran a mock task-runner broker), so this turns
it into the missing capability.

Design rules, in order:
  1. Never published to the host. Reachable only from the docker network.
  2. Shared-secret header on every call.
  3. Hard limits: CPU seconds, address space, file size, open files, and a
     wall-clock timeout — applied in the child, before any user code runs.
  4. Network and process spawning are refused unless explicitly allowed.
  5. Output is capped, so a runaway print() cannot flood the platform.

The static guard in `scan_code` is a speed bump, not a sandbox boundary: the
real boundary is the container plus the rlimits. It exists so that an
injected prompt cannot quietly exfiltrate data — the model has to ask.
"""

import http.server
import json
import os
import re
import resource
import subprocess
import sys
import tempfile
import hmac

KEY = os.environ.get('SANDBOX_KEY', '')
PORT = int(os.environ.get('SANDBOX_PORT', '8000'))
DEFAULT_TIMEOUT = float(os.environ.get('SANDBOX_TIMEOUT', '15'))
MAX_TIMEOUT = 30.0
MAX_OUTPUT = 8192
MAX_CODE = 20000

# (pattern, human label) — the label is what the model and the user see, so it
# has to read like a reason, not like a regex.
NETWORK_PATTERNS = [
    (r'\bsocket\b', 'socket（联网）'),
    (r'\burllib\b', 'urllib（联网）'),
    (r'\brequests\b', 'requests（联网）'),
    (r'\bhttpx\b', 'httpx（联网）'),
    (r'\bhttp\.client\b', 'http.client（联网）'),
    (r'\bftplib\b', 'ftplib（联网）'),
    (r'\bsmtplib\b', 'smtplib（发信）'),
    (r'\btelnetlib\b', 'telnetlib（联网）'),
    (r'\bxmlrpc\b', 'xmlrpc（远程调用）'),
    (r'\bwebbrowser\b', 'webbrowser（打开浏览器）'),
]
PROCESS_PATTERNS = [
    (r'\bsubprocess\b', 'subprocess（起子进程）'),
    (r'\bos\.system\b', 'os.system（起子进程）'),
    (r'\bos\.popen\b', 'os.popen（起子进程）'),
    (r'\bos\.exec', 'os.exec（替换进程）'),
    (r'\bos\.fork\b', 'os.fork（起进程）'),
    (r'\bos\.spawn', 'os.spawn（起进程）'),
    (r'\bpty\b', 'pty（伪终端）'),
    (r'\bmultiprocessing\b', 'multiprocessing（多进程）'),
]
ESCAPE_PATTERNS = [
    (r'__import__\s*\(', '__import__（动态导入）'),
    (r'\beval\s*\(', 'eval（动态执行）'),
    (r'\bexec\s*\(', 'exec（动态执行）'),
    (r'\bcompile\s*\(', 'compile（动态编译）'),
    (r'__subclasses__', '__subclasses__（逃逸技巧）'),
    (r'__builtins__', '__builtins__（逃逸技巧）'),
    (r'\bopen\s*\([^)]*[\'"]w', '写文件'),
    (r'\bshutil\b', 'shutil（文件操作）'),
]


def scan_code(code, allow_network):
    """Return a human label when the code is refused, else None."""
    groups = (PROCESS_PATTERNS + ESCAPE_PATTERNS) if allow_network else (
        NETWORK_PATTERNS + PROCESS_PATTERNS + ESCAPE_PATTERNS)
    for pattern, label in groups:
        if re.search(pattern, code):
            return label
    return None


def _limits(cpu_seconds):
    def apply():
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    return apply


def _clip(text):
    if len(text) > MAX_OUTPUT:
        return text[:MAX_OUTPUT] + '\n…(truncated)'
    return text


def run_code(code, timeout, allow_network):
    timeout = max(1.0, min(float(timeout or DEFAULT_TIMEOUT), MAX_TIMEOUT))
    reason = scan_code(code, allow_network)
    if reason:
        return {
            'ok': False, 'blocked': True, 'reason': reason,
            'message': ('这段代码用到 %s，当前不允许。若要联网或起子进程，'
                        '必须显式申请并由人在推送上点允许。' % reason),
        }
    handle, path = tempfile.mkstemp(suffix='.py', dir=tempfile.gettempdir())
    with os.fdopen(handle, 'w', encoding='utf-8') as f:
        f.write(code)
    try:
        proc = subprocess.run(
            [sys.executable, '-I', '-B', path],
            capture_output=True, text=True, timeout=timeout,
            cwd=tempfile.gettempdir(),
            env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'PYTHONIOENCODING': 'utf-8',
                 'HOME': tempfile.gettempdir()},
            preexec_fn=_limits(int(timeout) + 1),
        )
        return {
            'ok': proc.returncode == 0,
            'exit_code': proc.returncode,
            'stdout': _clip(proc.stdout or ''),
            'stderr': _clip(proc.stderr or ''),
        }
    except subprocess.TimeoutExpired:
        return {'ok': False, 'timeout': True, 'message': '执行超时（%ss）' % timeout}
    except Exception as exc:  # noqa: BLE001 - report, never crash the service
        return {'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc)}
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'agent-platform-sandbox'

    def log_message(self, fmt, *args):
        sys.stderr.write('[sandbox] ' + (fmt % args) + '\n')

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if not KEY:
            return False
        given = self.headers.get('x-sandbox-key', '')
        return hmac.compare_digest(given, KEY)

    def do_GET(self):
        if self.path.rstrip('/') == '/healthz':
            return self._send(200, {
                'ok': True,
                'python': sys.version.split()[0],
                'key_configured': bool(KEY),
                'max_timeout': MAX_TIMEOUT,
                'network_allowed_by_default': False,
            })
        return self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if not self._authorized():
            return self._send(401, {'ok': False, 'error': 'unauthorized'})
        if self.path.rstrip('/') != '/run':
            return self._send(404, {'ok': False, 'error': 'not found'})
        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, TypeError):
            return self._send(400, {'ok': False, 'error': 'invalid json'})
        code = body.get('code') or ''
        if not code.strip():
            return self._send(400, {'ok': False, 'error': 'code is required'})
        if len(code) > MAX_CODE:
            return self._send(400, {'ok': False, 'error': 'code too long'})
        result = run_code(code, body.get('timeout'), bool(body.get('allow_network')))
        return self._send(200, result)


if __name__ == '__main__':
    if not KEY:
        sys.stderr.write('[sandbox] WARNING: SANDBOX_KEY is empty — /run is disabled\n')
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    sys.stderr.write('[sandbox] listening on %s\n' % PORT)
    server.serve_forever()
