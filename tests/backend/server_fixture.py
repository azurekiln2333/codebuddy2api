"""Disposable launcher for the ORIGINAL codebuddy2api FastAPI app.

This module is owned by the security/check agent. It boots the real backend
source read-only from D:/My2KProjects/codebuddy2api with fully isolated
temporary state so the gateway bridge can be exercised against the actual
admin_auth / admin_api / AdminMiddleware code rather than an anti-double.

Isolation guarantees:
  - All writable state (auth dir, control db, audit db, bytecode cache) lives in
    a TemporaryDirectory outside the reference repository.
  - ``PYTHONDONTWRITEBYTECODE`` / ``sys.dont_write_bytecode`` keep __pycache__ out
    of the reference tree.
  - The reference repository is never modified.

The script prints a single JSON line ``{"port": <n>, "apiKey": "<k>", "origin":
"http://127.0.0.1:<n>"}`` on stdout once the server is listening, then serves
until the parent closes stdin.
"""

from __future__ import annotations

import json
import hashlib
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

# Resolve the reference repo without importing anything from it yet.
REFERENCE_ROOT = Path(os.environ.get("CODEBUDDY2API_REF", r"D:/My2KProjects/codebuddy2api")).resolve()
if not REFERENCE_ROOT.is_dir():
    raise SystemExit(f"reference backend not found: {REFERENCE_ROOT}")

# Never write bytecode into the reference repository.
sys.dont_write_bytecode = True
sys.path.insert(0, str(REFERENCE_ROOT))

import uvicorn  # noqa: E402

import converter as gateway  # noqa: E402
from app.audit_store import AuditStore  # noqa: E402
from app.control_store import ControlStore  # noqa: E402
from app.gateway_management import Management  # noqa: E402
from app.runtime_management import install, close  # noqa: E402

API_KEY = os.environ.get("BACKEND_FIXTURE_API_KEY", "fixture-server-key")


class LocalAccountOAuth:
    """Replace only external account-provider I/O; retain real admin handlers."""

    def __init__(self):
        self.tasks = {}

    def start(self, site="cn"):
        task_id = f"fixture-account-{len(self.tasks) + 1}"
        self.tasks[task_id] = 0
        return {"login_id": task_id, "verification_uri": f"https://www.codebuddy.cn/fixture/{task_id}", "expires_in": 600}

    def poll(self, task_id):
        self.tasks[task_id] += 1
        if self.tasks[task_id] == 1:
            return {"done": False}
        return {"done": True, "uid": "fixture-account", "nickname": "Fixture account", "cred": {
            "account": {"uid": "fixture-account", "nickname": "Fixture account"},
            "auth": {"accessToken": "synthetic-account-token", "domain": "https://www.codebuddy.cn"},
        }}


class ObserveInference:
    """Observe headers before real inference authentication without replacing it."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/v1/"):
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])

        async def observed_send(message):
            if message["type"] == "http.response.start":
                evidence = [(b"x-fixture-cookie-present", b"true" if b"cookie" in headers else b"false")]
                for source, target in ((b"authorization", b"x-fixture-auth-sha256"), (b"x-api-key", b"x-fixture-key-sha256")):
                    evidence.append((target, hashlib.sha256(headers.get(source, b"")).hexdigest().encode()))
                message = {**message, "headers": list(message.get("headers", [])) + evidence}
            await send(message)

        await self.app(scope, receive, observed_send)


def build(root: Path):
    os.environ["CODEBUDDY_AUTH_DIR"] = str(root)
    gateway.CONFIG.update(
        api_key=API_KEY,
        log_path=None,
        control_store=ControlStore(root / "control.sqlite3"),
        audit_store=AuditStore(root / "logs.sqlite3"),
    )
    state = gateway.CONFIG["control_store"].state
    state.migrate(root)
    gateway.CONFIG.update(
        state_store=state,
        trial_ledger=gateway.trial_rewards.TrialLedger(store=state),
    )
    gateway.CONFIG["management"] = Management(gateway)
    gateway._OAUTH = LocalAccountOAuth()
    # Seed real control-store rules containing the IDs produced by the UI's
    # encodeURIComponent. No reference files or real account catalogs change.
    control = gateway.CONFIG["control_store"]
    for index, source in enumerate(("org/model", "vendor:model", "@org/model")):
        control.update_model(source, {
            "public_id": f"fixture-public-{index}", "upstream_id": source, "custom": True,
        }, control.snapshot()["revision"])
    install(gateway)


def main() -> None:
    tmp = tempfile.TemporaryDirectory(prefix="cb2api-gateway-fixture-")
    try:
        root = Path(tmp.name)
        build(root)
        config = uvicorn.Config(
            ObserveInference(gateway.app),
            host="127.0.0.1",
            port=0,
            log_level="warning",
            lifespan="on",
        )
        server = uvicorn.Server(config)

        def run() -> None:
            server.run()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()

        # Wait for uvicorn to bind an ephemeral port.
        deadline = time.time() + 30
        while time.time() < deadline and not server.started:
            time.sleep(0.05)
        if not server.started:
            raise SystemExit("backend did not start within 30s")

        # uvicorn stores the bound sockets on the server; find the port.
        port = None
        for srv in getattr(server, "servers", []) or []:
            for sock in getattr(srv, "sockets", []) or []:
                try:
                    port = sock.getsockname()[1]
                    break
                except OSError:
                    continue
            if port:
                break
        if port is None:
            raise SystemExit("could not determine backend port")

        print(json.dumps({"port": port, "apiKey": API_KEY, "origin": f"http://127.0.0.1:{port}"}), flush=True)
        # Serve until the parent closes stdin.
        try:
            sys.stdin.read()
        except Exception:
            pass
        server.should_exit = True
        thread.join(timeout=10)
    finally:
        try:
            close(gateway.CONFIG)
        except Exception:
            pass
        tmp.cleanup()


if __name__ == "__main__":
    main()
