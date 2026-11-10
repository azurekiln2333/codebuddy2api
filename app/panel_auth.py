"""Outermost ``/admin`` boundary: the panel key, in front of the existing guards.

The panel key is a credential, not a second administration system. This
middleware only answers the requests it can authorize and hands everything else
to the boundary that was already installed, so legacy password sessions and the
SSO boundary keep their exact behaviour.

Order of decisions for a ``/admin/*`` request (design D2):

1. ``Authorization: Bearer <PANEL_ADMIN_KEY>`` authorizes it outright — the
   service-to-service path, with no cookie, CSRF or origin check.
2. ``GET /sso/config`` is the public login-page contract (installed with the
   SSO routes, so it never reaches this middleware).
3. ``POST /admin/session {"key": ...}`` is the browser key login. A body without
   ``key`` falls through, which is what keeps the legacy username/password
   login working.
4. A panel-key session cookie authorizes the request after CSRF and origin
   checks; the identity is ``panel:key``.
5. Anything else passes to the inner boundary untouched.
"""
from __future__ import annotations

import hmac
from typing import Any, Callable, Mapping

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from . import panel_key
from .admin_auth import same_origin


def _replaying_receive(body: bytes, receive: Callable[[], Any]):
    """Rebuild ``receive`` so the inner boundary can read the body again."""
    sent = False

    async def replay():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await receive()

    return replay


def _no_store_send(send):
    async def send_wrapper(message):
        if message["type"] == "http.response.start":
            headers = [(k, v) for k, v in message.get("headers", [])
                       if k.lower() not in (b"cache-control", b"pragma", b"expires")]
            message = {**message, "headers": headers + [
                (b"cache-control", b"no-store"),
                (b"pragma", b"no-cache"),
                (b"expires", b"0"),
            ]}
        await send(message)
    return send_wrapper


class PanelKeyMiddleware:
    """Panel-key login plus the management bearer, ahead of the installed guard."""

    def __init__(self, app, *, key: str, settings, sessions: panel_key.PanelSessions | None = None,
                 throttle: panel_key.LoginThrottle | None = None,
                 allowed_origins: Callable[[], Any] | None = None,
                 service=None):
        self.app = app
        self.key = key
        self.settings = settings
        self.sessions = sessions or panel_key.PanelSessions()
        self.throttle = throttle or panel_key.LoginThrottle()
        self._allowed_origins = allowed_origins
        # Set only when the SSO boundary was installed at startup; the outer
        # layer then leaves OIDC session checks to it and never doubles the
        # UserInfo round trip.
        self.service = service

    # ------------------------------------------------------------------ entry

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not str(scope.get("path", "")).startswith("/admin/"):
            return await self.app(scope, receive, send)
        path, method = scope["path"], scope.get("method", "GET")
        send = _no_store_send(send)

        if self._bearer_authorized(scope):
            return await self._machine(scope, receive, send)

        if path == "/admin/session":
            if method == "POST":
                return await self._login(scope, receive, send)
            if method == "GET" and self._session_cookie(scope) is not None:
                return await self._status(scope, receive, send)
            if method == "DELETE" and self._session_cookie(scope) is not None:
                return await self._logout(scope, receive, send)

        session = self._session_cookie(scope)
        if session is not None:
            return await self._authorize(scope, receive, send, session)

        # Hot-applied SSO: when the boundary installed at startup is the legacy
        # one, an OIDC session created after SSO was enabled in the console is
        # only visible here.
        if self.service is not None and self.settings.current().get("enabled"):
            from .sso_auth import SSOAuthError, SESSION_COOKIE as SSO_COOKIE
            cookie = _cookie(scope, SSO_COOKIE)
            if cookie:
                request = Request(scope, receive)
                try:
                    sso_session = await self.service.authorize(request)
                    if method not in ("GET", "HEAD", "OPTIONS") or path == "/admin/oauth/poll":
                        self.service.require_csrf(request, sso_session,
                                                  allow_referer=path == "/admin/oauth/poll")
                except SSOAuthError as error:
                    return await panel_key.json_response(
                        error.status, {"error": error.code})(scope, receive, send)
                scope.setdefault("state", {}).update(
                    admin_identity="sso:" + sso_session.sub, admin_cookie=True,
                    admin_session={"csrf_token": sso_session.csrf_token})
                scope["state"][panel_key.AUTHORIZED] = True
                return await self.app(scope, receive, send)

        return await self.app(scope, receive, send)

    # --------------------------------------------------------------- helpers

    def _bearer_authorized(self, scope) -> bool:
        if not self.key:
            return False
        return panel_key.matches(_bearer(scope), self.key)

    def _session_cookie(self, scope) -> dict[str, Any] | None:
        return self.sessions.resolve(_cookie(scope, panel_key.COOKIE_NAME))

    def _allowed(self):
        return self._allowed_origins() if self._allowed_origins is not None else frozenset()

    def _set_cookie(self, response: Response, sid: str, *, scope) -> None:
        response.set_cookie(
            panel_key.COOKIE_NAME, sid,
            max_age=panel_key.SESSION_TTL_SECONDS,
            httponly=True, samesite="strict",
            secure=scope.get("scheme") == "https",
            path="/admin",
        )

    # ---------------------------------------------------------------- machine

    async def _machine(self, scope, receive, send):
        """The bearer path: no cookie, no CSRF, no origin check (design D2.7)."""
        path, method = scope["path"], scope.get("method", "GET")
        if path == "/admin/session":
            if method == "POST":
                # A machine credential has no browser login to establish.
                return await panel_key.json_response(
                    405, {"error": "method_not_allowed"})(scope, receive, send)
            if method in ("GET", "HEAD"):
                return await panel_key.json_response(200, {
                    "authenticated": True, "csrf_token": None,
                    "user": {"sub": panel_key.IDENTITY, "name": "unified panel",
                             "provider": "key"},
                })(scope, receive, send)
            return await panel_key.json_response(
                200, {"authenticated": False})(scope, receive, send)
        scope.setdefault("state", {}).update(
            admin_identity=panel_key.IDENTITY, admin_cookie=False, admin_session=None)
        scope["state"][panel_key.AUTHORIZED] = True
        return await self.app(scope, receive, send)

    # ------------------------------------------------------------------ login

    async def _login(self, scope, receive, send):
        request = Request(scope, receive)
        body = await request.body()
        try:
            payload = await panel_key.read_json_body(
                Request(scope, _replaying_receive(body, receive)))
        except panel_key.Unauthorized as error:
            return await panel_key.json_response(
                error.status, {"error": {"message": error.message}})(scope, receive, send)
        if panel_key.KEY_LOGIN_FIELD not in payload:
            # Not a key login: let the legacy username/password route have it.
            return await self.app(scope, _replaying_receive(body, receive), send)

        if not self.settings.current().get("keyLoginEnabled", True):
            return await panel_key.json_response(
                403, {"error": {"message": "面板密钥登录已停用，请使用单点登录"}})(
                    scope, receive, send)
        if not self.key:
            return await panel_key.json_response(
                503, {"error": {"message": "未配置面板密钥，请设置 PANEL_ADMIN_KEY 后重启"}})(
                    scope, receive, send)
        if not same_origin(request, self._allowed()):
            return await panel_key.json_response(
                403, {"error": {"message": "登录请求 Origin 校验失败"}})(scope, receive, send)

        address = request.client.host if request.client else "unknown"
        if self.throttle.blocked(address):
            return await panel_key.json_response(
                429, {"error": {"message": "登录尝试过多，请 10 分钟后重试"}},
                headers={"Retry-After": str(panel_key.LOGIN_WINDOW_SECONDS)})(
                    scope, receive, send)
        if not panel_key.matches(payload.get(panel_key.KEY_LOGIN_FIELD), self.key):
            self.throttle.fail(address)
            return await panel_key.json_response(
                401, {"error": {"message": "面板密钥不正确"}})(scope, receive, send)

        self.throttle.clear(address)
        sid, csrf = self.sessions.issue()
        response = panel_key.json_response(200, {
            "authenticated": True,
            "csrf_token": csrf,
            "user": {"sub": panel_key.IDENTITY, "name": "面板密钥", "provider": "key"},
        })
        self.sessions.revoke(_cookie(scope, panel_key.COOKIE_NAME))
        self._set_cookie(response, sid, scope=scope)
        return await response(scope, receive, send)

    async def _status(self, scope, receive, send):
        session = self._session_cookie(scope)
        if session is None:
            return await panel_key.json_response(
                401, {"authenticated": False, "csrf_token": None})(scope, receive, send)
        return await panel_key.json_response(200, {
            "authenticated": True,
            "csrf_token": session["csrf_token"],
            "user": {"sub": panel_key.IDENTITY, "name": "面板密钥", "provider": "key"},
        })(scope, receive, send)

    async def _logout(self, scope, receive, send):
        request = Request(scope, receive)
        session = self._session_cookie(scope)
        if session is None:
            return await panel_key.json_response(
                401, {"authenticated": False})(scope, receive, send)
        if not self._csrf_ok(request, session):
            return await panel_key.json_response(
                403, {"error": {"message": "Origin 或 CSRF 校验失败"}})(scope, receive, send)
        self.sessions.revoke(_cookie(scope, panel_key.COOKIE_NAME))
        response = panel_key.json_response(200, {"authenticated": False})
        response.delete_cookie(panel_key.COOKIE_NAME, path="/admin", httponly=True,
                              samesite="strict", secure=scope.get("scheme") == "https")
        return await response(scope, receive, send)

    # -------------------------------------------------------------- authorize

    async def _authorize(self, scope, receive, send, session):
        request = Request(scope, receive)
        method, path = scope.get("method", "GET"), scope["path"]
        if method not in ("GET", "HEAD", "OPTIONS") or path == "/admin/oauth/poll":
            if not self._csrf_ok(request, session):
                return await panel_key.json_response(
                    403, {"error": {"message": "Origin 或 CSRF 校验失败"}})(scope, receive, send)
        scope.setdefault("state", {}).update(
            admin_identity=panel_key.IDENTITY, admin_cookie=True, admin_session=session)
        scope["state"][panel_key.AUTHORIZED] = True
        return await self.app(scope, receive, send)

    def _csrf_ok(self, request: Request, session: Mapping[str, Any]) -> bool:
        supplied = request.headers.get("x-csrf-token", "")
        expected = session.get("csrf_token", "")
        if not expected or not isinstance(supplied, str) or not supplied:
            return False
        if not same_origin(request, self._allowed()):
            return False
        return hmac.compare_digest(supplied.encode(), expected.encode())


def _cookie(scope, name: str) -> str:
    for key, value in scope.get("headers") or ():
        if key != b"cookie":
            continue
        for part in value.decode("latin-1").split(";"):
            field, sep, raw = part.partition("=")
            if sep and field.strip() == name:
                return raw.strip()
    return ""


def _bearer(scope) -> str:
    for key, value in scope.get("headers") or ():
        if key != b"authorization":
            continue
        text = value.decode("latin-1").strip()
        scheme, _, credential = text.partition(" ")
        return credential.strip() if scheme.lower() == "bearer" else ""
    return ""


def install_panel_key(app, config, *, service=None) -> PanelKeyMiddleware:
    """Add the outermost panel-key boundary and return it."""
    from . import auth_settings as _settings

    settings = config.get("auth_settings")
    if settings is None:
        # A management surface built without the console (embeddings, tests)
        # simply has no key login and cannot enable SSO.
        settings = _settings.SettingsStore()
        config["auth_settings"] = settings
    sessions = panel_key.PanelSessions()
    config["panel_key_sessions"] = sessions
    app.add_middleware(
        PanelKeyMiddleware,
        key=config.get("panel_key", ""),
        settings=settings,
        sessions=sessions,
        allowed_origins=lambda: config.get("_allowed_origins", frozenset()),
        service=service,
    )
    return app


__all__ = ["PanelKeyMiddleware", "install_panel_key", "JSONResponse"]
