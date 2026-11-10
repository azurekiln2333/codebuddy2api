"""The panel key: one credential for the console and for service-to-service calls.

Design D1/D2 of the unified-auth task. A single variable, ``PANEL_ADMIN_KEY``,
is both

* the console login key of this service (``POST /admin/session {"key": ...}``),
* the bearer credential the unified panel uses on ``/admin/*``.

Design D2.2/D2.7 require the two uses to stay independent: disabling the browser
key login must not revoke the machine path, because the panel keeps managing the
service with the same value.

Legacy names remain accepted, newest wins: ``PANEL_ADMIN_KEY`` -> ``PANEL_KEY``
-> ``PLATFORM_TOKEN``.

Example
-------
>>> key_from_env({"PANEL_ADMIN_KEY": "x" * 12})[1]
'PANEL_ADMIN_KEY'
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
from typing import Any, Mapping

from starlette.requests import Request
from starlette.responses import JSONResponse

MIN_KEY_LENGTH = 12
MAX_KEY_LENGTH = 4096
# Newest name first: the first configured alias wins.
ALIASES = ("PANEL_ADMIN_KEY", "PANEL_KEY", "PLATFORM_TOKEN")

COOKIE_NAME = "cb_panel_session"
SESSION_TTL_SECONDS = 12 * 3600
MAX_SESSIONS = 100
LOGIN_WINDOW_SECONDS = 600
MAX_LOGIN_FAILURES = 10
IDENTITY = "panel:key"
KEY_LOGIN_FIELD = "key"


def key_from_env(environ: Mapping[str, str]) -> tuple[str, str]:
    """Return ``(key, source)`` for the first configured alias, else ``("", "")``."""
    for name in ALIASES:
        raw = environ.get(name)
        if not isinstance(raw, str):
            continue
        value = raw.strip()
        if not value:
            continue
        if not MIN_KEY_LENGTH <= len(value) <= MAX_KEY_LENGTH:
            # A too-short value is not silently ignored: it is treated as unset
            # so a typo cannot degrade into a weak credential.
            return "", ""
        if any(ord(ch) < 32 or ch == "\x7f" for ch in value):
            return "", ""
        return value, name
    return "", ""


def matches(candidate: Any, key: str) -> bool:
    """Constant-time comparison that never raises on a non-string candidate."""
    if not key or not isinstance(candidate, str) or not candidate:
        return False
    return hmac.compare_digest(candidate.encode("utf-8"), key.encode("utf-8"))


class LoginThrottle:
    """Per-address failure budget, so a wrong key cannot be brute-forced."""

    def __init__(self, *, limit: int = MAX_LOGIN_FAILURES,
                 window: float = LOGIN_WINDOW_SECONDS, clock=time.monotonic):
        self.limit = limit
        self.window = window
        self.clock = clock
        self._failures: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()

    def blocked(self, address: str) -> bool:
        with self._lock:
            entry = self._failures.get(address)
            if entry is None:
                return False
            started, count = entry
            if self.clock() - started >= self.window:
                self._failures.pop(address, None)
                return False
            return count >= self.limit

    def fail(self, address: str) -> None:
        with self._lock:
            now = self.clock()
            started, count = self._failures.get(address, (now, 0))
            if now - started >= self.window:
                started, count = now, 0
            self._failures[address] = (started, count + 1)
            while len(self._failures) > 1024:
                self._failures.pop(next(iter(self._failures)), None)

    def clear(self, address: str) -> None:
        with self._lock:
            self._failures.pop(address, None)


class PanelSessions:
    """In-memory browser sessions issued by the panel-key login."""

    def __init__(self, *, ttl: float = SESSION_TTL_SECONDS, clock=time.time,
                 limit: int = MAX_SESSIONS):
        self.ttl = ttl
        self.clock = clock
        self.limit = limit
        self._items: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def current(self) -> dict[str, Any] | None:
        with self._lock:
            return dict(self._items) or None

    def issue(self) -> tuple[str, str]:
        sid = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        with self._lock:
            self._sweep()
            while len(self._items) >= self.limit:
                self._items.pop(next(iter(self._items)), None)
            self._items[sid] = {"csrf_token": csrf, "expires": self.clock() + self.ttl}
        return sid, csrf

    def resolve(self, sid: str | None) -> dict[str, Any] | None:
        if not sid:
            return None
        with self._lock:
            item = self._items.get(sid)
            if item is None:
                return None
            if item["expires"] <= self.clock():
                self._items.pop(sid, None)
                return None
            return dict(item)

    def revoke(self, sid: str | None) -> None:
        if not sid:
            return
        with self._lock:
            self._items.pop(sid, None)

    def revoke_all(self) -> None:
        with self._lock:
            self._items.clear()

    def _sweep(self) -> None:
        now = self.clock()
        for sid in [key for key, item in self._items.items() if item["expires"] <= now]:
            self._items.pop(sid, None)


def public_config(settings: Mapping[str, Any], *, key_configured: bool) -> dict[str, Any]:
    """The unauthenticated login-page contract (design D2.1).

    ``keyLoginEnabled`` reports the effective capability: the operator setting
    AND a configured key, because offering a key field that cannot succeed
    would strand the operator on the login page.
    """
    enabled = settings.get("enabled") is True
    return {
        "keyLoginEnabled": bool(settings.get("keyLoginEnabled", True)) and key_configured,
        "sso": {
            "enabled": enabled,
            "providerName": settings.get("providerName") or "SSO",
            "loginUrl": "/sso/login" if enabled else "",
        },
    }


def fingerprint(key: str) -> str:
    """Stable, non-reversible label used only for diagnostics and audit."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12] if key else ""


class Unauthorized(Exception):
    """A panel-key request that must be answered with a fixed error."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def json_response(status: int, payload: dict[str, Any],
                  headers: Mapping[str, str] | None = None) -> JSONResponse:
    merged = {"Cache-Control": "no-store", "Pragma": "no-cache"}
    merged.update(headers or {})
    return JSONResponse(payload, status_code=status, headers=merged)


async def read_json_body(request: Request, limit: int = 8192) -> dict[str, Any]:
    """Read a small JSON object body, rejecting oversized or non-object payloads."""
    raw = await request.body()
    if len(raw) > limit:
        raise Unauthorized(413, "请求体过大")
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise Unauthorized(400, "请求体不是合法 JSON") from None
    if not isinstance(value, dict):
        raise Unauthorized(400, "请求体必须是 JSON 对象")
    return value
