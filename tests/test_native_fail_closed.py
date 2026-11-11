"""Prove the shipped image admits nothing without a key, with disposable state."""
import contextlib
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest

import httpx

ROOT = Path(__file__).resolve().parents[1]
# The retired switch must stay inert: setting it must not re-open admission.
RETIRED_SWITCH = "CODEBUDDY2API_ALLOW_OPEN_NOAUTH"


class NativeFailClosedTests(unittest.TestCase):
    def test_image_default_rejects_every_inference_call_without_a_key(self):
        dockerfile = (ROOT / 'Dockerfile').read_text(encoding='utf-8')
        command = json.loads(next(line[4:] for line in dockerfile.splitlines() if line.startswith('CMD ')))
        self.assertNotIn(RETIRED_SWITCH, dockerfile)
        self.assertNotIn(RETIRED_SWITCH, (ROOT / 'docker-compose.yml').read_text(encoding='utf-8'))
        with tempfile.TemporaryDirectory() as directory, socket.socket() as probe:
            root = Path(directory)
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
            probe.close()
            env = {name: os.environ[name] for name in ('PATH', 'SYSTEMROOT') if name in os.environ}
            env.update(HOME=directory, USERPROFILE=directory, TMPDIR=directory, TEMP=directory,
                       CODEBUDDY_AUTH_DIR=str(root / 'auth'), PYTHONDONTWRITEBYTECODE='1')
            # The retired switch must be inert even when an old deployment still sets it.
            env[RETIRED_SWITCH] = 'true'
            process = subprocess.Popen([sys.executable, '-B', str(ROOT / command[1]), *command[2:], '--port', str(port)],
                                       cwd=root, env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                with httpx.Client(base_url=f'http://127.0.0.1:{port}', transport=httpx.HTTPTransport(retries=5),
                                  timeout=10, trust_env=False) as client:
                    self.assertEqual(client.get('/health').json(), {'status': 'ok'})
                    session = client.get('/admin/session')
                    self.assertEqual(session.status_code, 200)
                    self.assertEqual(session.json(), {'authenticated': False, 'csrf_token': None})
                    # No key exists yet: every inference family stays closed, with or
                    # without a placeholder token, and the retired switch changes nothing.
                    for authorization in (None, 'Bearer placeholder', 'Bearer cb-' + '0' * 32):
                        headers = {} if authorization is None else {'Authorization': authorization}
                        for path in ('/v1/chat/completions', '/v1/responses', '/v1/messages'):
                            with self.subTest(path=path, authorization=authorization):
                                body = client.post(path, headers=headers, json={'model': 'synthetic'})
                                self.assertEqual(body.status_code, 401, body.text)
                                payload = body.json()
                                error = payload['error']
                                self.assertEqual(error['code'], 'api_key_required')
                                if path == '/v1/messages':
                                    self.assertEqual(payload['type'], 'error')
                                    self.assertEqual(error['type'], 'authentication_error')
                        with self.subTest(path='/v1/models', authorization=authorization):
                            self.assertEqual(client.get('/v1/models', headers=headers).status_code, 401)
                with contextlib.closing(sqlite3.connect(root / 'auth/control.sqlite3')) as db:
                    self.assertEqual(db.execute('SELECT count(*) FROM gateway_secrets').fetchone()[0], 1)
                    self.assertEqual(db.execute('SELECT count(*) FROM api_keys').fetchone()[0], 0)
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGINT) if os.name == 'posix' else process.terminate()
                try:
                    output, error = process.communicate(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=5)
                    self.fail('Owned fail-closed fixture did not shut down')
            self.assertNotIn(b'cb-', output + error)


if __name__ == '__main__':
    unittest.main()
