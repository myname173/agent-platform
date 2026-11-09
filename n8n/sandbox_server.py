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

Two layers enforce rule 4, because one layer is not enough:

  * `scan_code` is a static text scan. It is fast and it gives the model a
    readable reason ("socket（联网）"), but text can be split
    (`'so' + 'cket'`), routed around (`importlib.import_module`) or renamed
    (`f = eval`). Its own comment used to admit this: "a speed bump, not a
    sandbox boundary".
  * The runtime guard (`_GUARD_SOURCE`) is installed inside the child
    *before* the user code runs. It refuses denied modules at import time
    (including through `importlib`, which never raises an import audit
    event), replaces the dangerous builtins, and refuses writes, process
    spawns and socket calls through the audit hook. A walk-around that
    survives the text scan dies here, at the call.

The real boundary is still the container plus the rlimits. The guard is
defence in depth: it stops the obvious escapes without waiting for a human,
and it makes the refusal legible in the audit log.

`--self-test` exercises both layers on the host, without the server and
without rlimits (so it also runs on a Windows dev box).
"""

import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import hmac
import secrets

try:  # rlimits are POSIX-only; the Windows dev box only runs --self-test
    import resource
except ImportError:  # pragma: no cover - the Linux container has it
    resource = None

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

# The runtime guard denies whole modules — but only when the *snippet* asks
# for them. A library that imports one of these internally (pathlib imports
# urllib.parse, email imports socket) must keep working, so the guard looks
# at who asked. The actual operations are caught by the audit hook instead:
# every socket call raises a socket.* event, every spawn raises a
# subprocess/os.* event, every write raises an open event.
#
# `importlib` is on the list on purpose: `importlib.import_module('socket')`
# does NOT go through builtins.__import__, so denying the module itself is
# the only way to close that route.
NETWORK_MODULES = {
    'socket': 'socket（联网）',
    'urllib': 'urllib（联网）',
    'requests': 'requests（联网）',
    'httpx': 'httpx（联网）',
    'http': 'http.client（联网）',
    'ftplib': 'ftplib（联网）',
    'smtplib': 'smtplib（发信）',
    'telnetlib': 'telnetlib（联网）',
    'xmlrpc': 'xmlrpc（远程调用）',
    'webbrowser': 'webbrowser（打开浏览器）',
}
PROCESS_MODULES = {
    'subprocess': 'subprocess（起子进程）',
    'multiprocessing': 'multiprocessing（多进程）',
    'pty': 'pty（伪终端）',
    'shutil': 'shutil（文件操作）',
    'importlib': 'importlib（动态导入）',
    'ctypes': 'ctypes（逃逸技巧）',
    'builtins': 'builtins（逃逸技巧）',
    '_frozen_importlib': 'importlib（动态导入）',
    '_frozen_importlib_external': 'importlib（动态导入）',
}
# Audit events that mean "this process just did something it must not do".
EVENT_DENY = {
    'os.system': 'os.system（起子进程）',
    'os.fork': 'os.fork（起进程）',
    'os.forkpty': 'os.forkpty（起进程）',
    'os.posix_spawn': 'os.posix_spawn（起进程）',
    'subprocess.Popen': 'subprocess（起子进程）',
}

# The child runs this before any user code. It is written to a temp file and
# executed with `python -I -B`; isolated mode means sys.path holds neither
# the script directory nor site-packages, so everything it needs is inlined.
_GUARD_SOURCE = '''\
# agent-platform sandbox runtime guard — installed before any user code.
# The parent already ran a static text scan; this layer catches what a text
# scan cannot see:
#   importlib.import_module('socket')  -> importlib itself is refused
#   pathlib.Path(p).write_text(...)    -> the open audit event sees mode 'w'
#   f = eval; f('...')                  -> builtins.eval has been replaced
#   getattr(os, 'system')('id')         -> the os.system audit event fires
import builtins as _builtins
import os as _os
import sys as _sys

try:
    # -I ignores PYTHONIOENCODING, so the child would encode its output with
    # the host locale (GBK on a Chinese Windows box). Pin it to UTF-8 here,
    # otherwise the parent decodes mojibake.
    _sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    _sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

TOKEN = __TOKEN__
ALLOW_NETWORK = __ALLOW_NETWORK__
MODULE_DENY = __MODULE_DENY__
EVENT_DENY = __EVENT_DENY__
WRITE_FLAGS = __WRITE_FLAGS__

MARK = 'SANDBOX_GUARD-' + TOKEN

# The import machinery itself calls builtins.exec / builtins.compile, and
# stdlib modules call builtins.eval (collections.namedtuple does). Those must
# keep working, so the guard refuses the dynamic builtins only when the
# caller is the user snippet.
#
# "The caller is the user" is decided by the *code object* of the calling
# frame, not by its __name__: the snippet runs as __main__ (so that
# `if __name__ == '__main__':` still fires, the way it did when the snippet
# was executed as a script), and the guard script itself is also __main__.
# The file name of the snippet's code object is the one thing the snippet
# cannot rename from the inside.
_USER_CODE_PATH = None


def _refuse(label, detail):
    raise PermissionError(MARK + ': ' + label + ' :: ' + detail)


def _caller_is_user(depth):
    """True when the frame `depth` levels up is the user snippet itself."""
    try:
        frame = _sys._getframe(depth)
    except Exception:
        return False
    try:
        return frame.f_code.co_filename == _USER_CODE_PATH
    except Exception:
        return False


_ORIG_IMPORT = _builtins.__import__
_ORIG_EXEC = _builtins.exec
_ORIG_COMPILE = _builtins.compile
_ORIG_EVAL = _builtins.eval


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if not _caller_is_user(2):
        return _ORIG_IMPORT(name, globals, locals, fromlist, level)
    root = str(name).split('.')[0]
    label = MODULE_DENY.get(root)
    if label:
        _refuse(label, 'import of ' + str(name) + ' refused')
    return _ORIG_IMPORT(name, globals, locals, fromlist, level)


def _guarded_exec(*args, **kwargs):
    if not _caller_is_user(2):
        return _ORIG_EXEC(*args, **kwargs)
    _refuse('exec（动态执行）', 'exec is not available in the sandbox')


def _guarded_compile(*args, **kwargs):
    if not _caller_is_user(2):
        return _ORIG_COMPILE(*args, **kwargs)
    _refuse('compile（动态编译）', 'compile is not available in the sandbox')


def _guarded_eval(*args, **kwargs):
    if not _caller_is_user(2):
        return _ORIG_EVAL(*args, **kwargs)
    _refuse('eval（动态执行）', 'eval is not available in the sandbox')


_builtins.__import__ = _guarded_import
_builtins.exec = _guarded_exec
_builtins.compile = _guarded_compile
_builtins.eval = _guarded_eval


def _audit(event, args):
    if event == 'open':
        mode = str(args[1]) if len(args) > 1 and args[1] else ''
        flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
        if any(ch in mode for ch in 'wax+') or (flags & WRITE_FLAGS):
            _refuse('写文件', 'file write refused')
    elif event in EVENT_DENY:
        _refuse(EVENT_DENY[event], event + ' refused')
    elif event.startswith('os.exec') or event.startswith('os.spawn'):
        _refuse('os.exec（替换进程）', event + ' refused')
    elif not ALLOW_NETWORK and event.startswith('socket.'):
        _refuse('socket（联网）', event + ' refused')
    elif event.startswith('ctypes.'):
        _refuse('ctypes（逃逸技巧）', event + ' refused')


_sys.addaudithook(_audit)

_USER_CODE = _os.environ['SANDBOX_USER_CODE']
_USER_CODE_PATH = _USER_CODE
with open(_USER_CODE, 'r', encoding='utf-8') as _fh:
    _SOURCE = _fh.read()
# The snippet is executed as __main__, exactly like it was when it was run
# as a script: `if __name__ == '__main__':` has to fire.
_ORIG_EXEC(_ORIG_COMPILE(_SOURCE, _USER_CODE, 'exec'), {
    '__name__': '__main__',
    '__file__': _USER_CODE,
    '__loader__': None,
    '__spec__': None,
    '__package__': None,
    '__doc__': None,
    '__builtins__': _builtins,
})
'''


def scan_code(code, allow_network):
    """Return a human label when the code is refused, else None."""
    groups = (PROCESS_PATTERNS + ESCAPE_PATTERNS) if allow_network else (
        NETWORK_PATTERNS + PROCESS_PATTERNS + ESCAPE_PATTERNS)
    for pattern, label in groups:
        if re.search(pattern, code):
            return label
    return None


# 512 MB was enough for the stdlib but not for pandas: importing it raised
# MemoryError inside the child while it worked fine with `docker exec` (no
# rlimits). Bounded, but roomy enough for real libraries.
MAX_AS_MB = int(os.environ.get('SANDBOX_AS_MB', '1536'))


def _limits(cpu_seconds):
    if resource is None:
        raise RuntimeError('rlimits are not available on this platform')
    def apply():
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        resource.setrlimit(resource.RLIMIT_AS, (MAX_AS_MB * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    return apply


def _clip(text):
    if len(text) > MAX_OUTPUT:
        return text[:MAX_OUTPUT] + '\n…(truncated)'
    return text


def _module_deny(allow_network):
    denied = dict(PROCESS_MODULES)
    if not allow_network:
        denied.update(NETWORK_MODULES)
    return denied


def _guard_source(token, allow_network):
    write_flags = 0
    for name in ('O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_APPEND', 'O_TRUNC'):
        write_flags |= getattr(os, name, 0)
    return (_GUARD_SOURCE
            .replace('__TOKEN__', repr(token))
            .replace('__ALLOW_NETWORK__', repr(bool(allow_network)))
            .replace('__MODULE_DENY__', repr(_module_deny(allow_network)))
            .replace('__EVENT_DENY__', repr(EVENT_DENY))
            .replace('__WRITE_FLAGS__', repr(write_flags)))


def guard_reason(stderr, token):
    """Return the label the runtime guard refused with, or None."""
    match = re.search(r'SANDBOX_GUARD-' + re.escape(token) + r':\s*([^:\n]*?)\s*::',
                      stderr or '')
    return match.group(1).strip() if match else None


def _child_env(workdir, user_path, token):
    env = {
        'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
        'PYTHONIOENCODING': 'utf-8',
        'HOME': workdir,
        'SANDBOX_USER_CODE': user_path,
        'SANDBOX_TOKEN': token,
    }
    if os.name == 'nt':
        for name in ('SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP'):
            if os.environ.get(name):
                env[name] = workdir if name in ('TEMP', 'TMP') else os.environ[name]
    return env


def run_code(code, timeout, allow_network, use_rlimits=True):
    timeout = max(1.0, min(float(timeout or DEFAULT_TIMEOUT), MAX_TIMEOUT))
    reason = scan_code(code, allow_network)
    if reason:
        return {
            'ok': False, 'blocked': True, 'reason': reason,
            'message': ('这段代码用到 %s，当前不允许。若要联网或起子进程，'
                        '必须显式申请并由人在推送上点允许。' % reason),
        }
    token = secrets.token_hex(8)
    workdir = tempfile.mkdtemp(prefix='sbx-')
    user_path = os.path.join(workdir, 'user.py')
    guard_path = os.path.join(workdir, 'guard.py')
    try:
        with open(user_path, 'w', encoding='utf-8') as fh:
            fh.write(code)
        with open(guard_path, 'w', encoding='utf-8') as fh:
            fh.write(_guard_source(token, allow_network))
        proc = subprocess.run(
            [sys.executable, '-I', '-B', guard_path],
            capture_output=True, text=True, encoding='utf-8', errors='replace',
            timeout=timeout,
            cwd=workdir,
            env=_child_env(workdir, user_path, token),
            # rlimits are POSIX-only. The container is Linux, so they are
            # always applied there; on a dev box without them the guard and
            # the timeout still apply, and the result says so.
            preexec_fn=_limits(int(timeout) + 1) if (use_rlimits and resource is not None) else None,
        )
        stderr = proc.stderr or ''
        guarded = guard_reason(stderr, token)
        if guarded:
            return {
                'ok': False, 'blocked': True, 'reason': guarded,
                'message': ('这段代码用到 %s，当前不允许。若要联网或起子进程，'
                            '必须显式申请并由人在推送上点允许。' % guarded),
                'stderr': _clip(stderr),
                'rlimits_applied': bool(use_rlimits and resource is not None),
            }
        return {
            'ok': proc.returncode == 0,
            'exit_code': proc.returncode,
            'stdout': _clip(proc.stdout or ''),
            'stderr': _clip(stderr),
            'rlimits_applied': bool(use_rlimits and resource is not None),
        }
    except subprocess.TimeoutExpired:
        return {'ok': False, 'timeout': True, 'message': '执行超时（%ss）' % timeout}
    except Exception as exc:  # noqa: BLE001 - report, never crash the service
        return {'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc)}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


SELF_TEST_CASES = [
    # name, code, allow_network, expected layer, expected reason fragment,
    # expected stdout fragment
    ('benign_print', 'print(2 + 3)', False, 'allow', '', ''),
    ('benign_stdlib', "import json\nprint(json.dumps({'a': 1}))", False, 'allow', '', ''),
    ('benign_read', "print(open(__file__).read()[:1] if False else 'ok')", False, 'allow', '', ''),
    # pathlib imports urllib.parse internally: a library that reaches a denied
    # module must still work, only the snippet's own import is refused.
    ('benign_pathlib', "import pathlib\nprint(pathlib.Path('.').name or 'x')", False, 'allow', '', ''),
    # collections.namedtuple calls builtins.eval internally. If the guard
    # refused every eval, this standard library call would break.
    ('benign_namedtuple',
     "import collections\nP = collections.namedtuple('P', 'x y')\nprint(P(1, 2).x)", False, 'allow', '', ''),
    # The snippet is executed as __main__, like a script: a main guard must
    # still fire, otherwise the agent silently gets empty output.
    ('benign_main_guard',
     "def main():\n    print('main block ran')\nif __name__ == '__main__':\n    main()",
     False, 'allow', '', 'main block ran'),
    # The approved path: network allowed by a human, so socket is permitted.
    ('approved_network', 'import socket\nprint(socket.gethostname())', True, 'allow', '', ''),
    ('static_socket', 'import socket\nprint(socket.gethostname())', False, 'static', 'socket', ''),
    ('static_subprocess', "import subprocess\nsubprocess.run(['id'])", False, 'static', 'subprocess', ''),
    ('static_eval', "print(eval('2 + 2'))", False, 'static', 'eval', ''),
    ('static_write', "open('agent-eval.txt', 'w').write('x')", False, 'static', '写文件', ''),
    ('runtime_dynamic_import',
     "import importlib\nm = importlib.import_module('so' + 'cket')\nprint(m.gethostname())",
     False, 'runtime', 'importlib', ''),
    ('runtime_pathlib_write',
     "import pathlib\npathlib.Path('agent-eval.txt').write_text('x')\nprint('wrote')",
     False, 'runtime', '写文件', ''),
    ('runtime_ctypes', "import ctypes\nctypes.CDLL('libc.so.6')\nprint('ok')",
     False, 'runtime', 'ctypes', ''),
    ('runtime_eval_alias', "f = eval\nprint(f('2 + 2'))", False, 'runtime', 'eval', ''),
    ('runtime_os_system_alias',
     "import os\ngetattr(os, 'system')('echo hi')", False, 'runtime', 'os.system', ''),
]


def self_test():
    """Exercise the static scan and the runtime guard on this host."""
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    failures = []
    for name, code, allow_network, layer, fragment, stdout_fragment in SELF_TEST_CASES:
        scanned = scan_code(code, allow_network)
        if layer == 'allow':
            if scanned:
                failures.append('%s: static scan refused a benign snippet (%s)' % (name, scanned))
                continue
            result = run_code(code, 5, allow_network, use_rlimits=False)
            if not result.get('ok'):
                failures.append('%s: benign snippet failed: %s' % (name, result))
                continue
            if stdout_fragment and stdout_fragment not in str(result.get('stdout') or ''):
                failures.append('%s: stdout %r does not contain %r' % (
                    name, result.get('stdout'), stdout_fragment))
                continue
            print('ok   %-24s allowed' % name)
            continue
        if layer == 'static':
            if not scanned:
                failures.append('%s: expected the static scan to refuse it' % name)
                continue
            if fragment and fragment not in scanned:
                failures.append('%s: static reason %r does not mention %r' % (name, scanned, fragment))
                continue
            print('ok   %-24s refused statically (%s)' % (name, scanned))
            continue
        # runtime: the text scan must miss it, the guard must not
        if scanned:
            failures.append('%s: the static scan already refused it (%s) — '
                            'the runtime layer is not being exercised' % (name, scanned))
            continue
        result = run_code(code, 5, allow_network, use_rlimits=False)
        if not result.get('blocked'):
            failures.append('%s: the runtime guard let it through: %s' % (name, result))
            continue
        reason = str(result.get('reason') or '')
        if fragment and fragment not in reason:
            failures.append('%s: runtime reason %r does not mention %r' % (name, reason, fragment))
            continue
        print('ok   %-24s refused at runtime (%s)' % (name, reason))
    print('\n%d/%d sandbox guard checks passed' % (
        len(SELF_TEST_CASES) - len(failures), len(SELF_TEST_CASES)))
    for failure in failures:
        print('FAIL %s' % failure)
    return 0 if not failures else 1


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
                'runtime_guard': True,
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
    if '--self-test' in sys.argv:
        sys.exit(self_test())
    if not KEY:
        sys.stderr.write('[sandbox] WARNING: SANDBOX_KEY is empty — /run is disabled\n')
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    sys.stderr.write('[sandbox] listening on %s\n' % PORT)
    server.serve_forever()
