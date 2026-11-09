"""Service-to-service management access for the unified platform2api panel.

The platform2api panel is a server-side proxy: browsers never talk to this
service directly. SSO or password sessions therefore cannot be reused by the
panel, so this module adds one explicit, env-gated credential.

Contract
--------
* Enabled only when ``PLATFORM_TOKEN`` is set to at least 12 characters.
  When unset the module has no effect at all, so existing key-login and SSO
  behaviour is unchanged (backward compatible by default).
* A request to ``/admin/*`` carrying ``Authorization: Bearer <PLATFORM_TOKEN>``
  is authorised without a session and without CSRF, because there is no
  browser and no cookie to protect.
* The comparison is constant time and the token is never echoed back.
"""

from __future__ import annotations

import hmac

from starlette.requests import Request

MIN_TOKEN_LENGTH = 12
IDENTITY = "platform:token"


def platform_token_from_env(environ) -> str:
    """Return the configured service token, or ``""`` when the branch is off."""
    raw = environ.get("PLATFORM_TOKEN", "")
    token = raw.strip() if isinstance(raw, str) else ""
    if len(token) < MIN_TOKEN_LENGTH:
        return ""
    return token


def supplied_token(scope) -> str:
    """Extract a bearer token from the raw ASGI scope without consuming the body."""
    for key, value in scope.get("headers") or ():
        if key == b"authorization":
            text = value.decode("latin-1").strip()
            scheme, _, credential = text.partition(" ")
            if scheme.lower() == "bearer":
                return credential.strip()
            return ""
    return ""


def request_matches(scope, token: str) -> bool:
    """True when the request carries the configured service token."""
    if not token:
        return False
    candidate = supplied_token(scope)
    if not candidate:
        return False
    return hmac.compare_digest(candidate.encode("utf-8"), token.encode("utf-8"))


def _no_store_send(send):
    async def send_wrapper(message):
        if message["type"] == "http.response.start":
            headers = [(k, v) for k, v in message.get("headers", [])
                       if k.lower() not in (b"cache-control", b"pragma", b"expires")]
            message = {**message, "headers": headers + [
                (b"cache-control", b"no-store"), (b"pragma", b"no-cache"), (b"expires", b"0")]}
        await send(message)
    return send_wrapper


def _json(status: int, payload: dict):
    import json

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    async def respond(scope, receive, send):
        await send({"type": "http.response.start", "status": status, "headers": [
            (b"content-type", b"application/json; charset=utf-8"),
            (b"content-length", str(len(body)).encode("latin-1"))]})
        await send({"type": "http.response.body", "body": body})
    return respond


async def authorize(scope, receive, send, *, token: str, dispatch=None, app=None) -> bool:
    """Handle an ``/admin/`` request that carries the service token.

    Returns ``True`` once the response has been produced (the caller must stop),
    or ``False`` when the token is absent or wrong and the caller must fall back
    to its normal session / OIDC / CSRF checks.
    """
    if not request_matches(scope, token):
        return False
    path = scope.get("path", "")
    method = scope.get("method", "GET")
    no_store = _no_store_send(send)
    if path == "/admin/session":
        if method == "POST":
            # Key login is meaningless for a machine credential.
            await _json(405, {"detail": {"error": "method_not_allowed"}})(scope, receive, no_store)
            return True
        if method in ("GET", "HEAD"):
            await _json(200, {"authenticated": True, "csrf_token": None,
                              "user": {"name": "platform2api", "provider": "token"}})(scope, receive, no_store)
            return True
        await _json(200, {"authenticated": False})(scope, receive, no_store)
        return True
    scope.setdefault("state", {}).update(
        admin_identity=IDENTITY, admin_cookie=False, admin_session=None)
    if dispatch is not None:
        adapted = await dispatch(Request(scope, receive))
        if adapted is not None:
            await adapted(scope, receive, no_store)
            return True
    await app(scope, receive, no_store)
    return True
