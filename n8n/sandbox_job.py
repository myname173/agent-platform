#!/usr/bin/env python3
"""One-shot Kubernetes Job runner for the existing sandbox limits."""

import json
import os
import sys

from sandbox_server import run_code


def main():
    try:
        request = json.loads(os.environ.get('SANDBOX_REQUEST_JSON', '{}'))
    except json.JSONDecodeError as exc:
        print(json.dumps({'ok': False, 'error': f'invalid request: {exc}'}))
        return 2

    code = request.get('code') or ''
    if not code.strip():
        print(json.dumps({'ok': False, 'error': 'code is required'}))
        return 2
    if len(code) > 20000:
        print(json.dumps({'ok': False, 'error': 'code too long'}))
        return 2

    result = run_code(code, request.get('timeout'), bool(request.get('allow_network')))
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
