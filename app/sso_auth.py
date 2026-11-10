"""Native OIDC session lifecycle and the SSO-aware ``/admin`` boundary.

Port of the retired Node gateway's ``src/auth.ts``, ``src/sessions.ts`` and
``src/http.ts`` onto FastAPI/Starlette so the application runs as one process.

Frozen behaviour (browser contract in ``docs/`` of the retired gateway):

- ``/sso/login`` starts a one-use, browser-bound login transaction holding the
  PKCE verifier, ``state`` and ``nonce`` in an HttpOnly cookie,
- ``/sso/callback`` consumes that transaction once, exchanges the code, verifies
  the RS256 ID token and requires a live UserInfo administrator identity,
- ``/sso/session`` returns the authenticated payload or the unauthenticated
  shape; a session that exists but is not a current administrator stays 403,
- ``POST /sso/logout`` ends the session (Origin + ``X-CSRF-Token`` required),
- ``/admin/*`` requires a live SSO identity on every request; there is no
  API-key fallback once SSO mode is enabled,
- every await is followed by a membership/expiry re-check so a concurrent
  logout, eviction or refresh failure always wins,
- all errors reduce to fixed, secret-free codes.
"""
from __future__ import annotations

import asyncio
import hmac
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response

from .sso_config import SSOConfig
from .sso_oidc import OidcClient, OidcError, create_code_verifier, random_token
from . import auth_settings, platform_token

SESSION_COOKIE = "cb_sso_session"
TRANSACTION_COOKIE = "cb_sso_txn"
MAX_COOKIE_VALUE = 512
MAX_COOKIES = 20
DEFAULT_RETURN_TO = "/dashboard/"
ACCESS_TOKEN_SKEW_SECONDS = 5


class SSOAuthError(Exception):
    """Fixed status + code for a rejected SSO request."""

    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


@dataclass
class LoginTransaction:
    state: str
    nonce: str
    verifier: str
    return_to: str
    expires_at: float


@dataclass
class SSOSession:
    id: str
    csrf_token: str
    sub: str
    access_token: str
    user: dict[str, Any]
    expires_at: float
    last_seen_at: float
    refresh_token: str | None = None
    access_token_expires_at: float = 0.0
    refresh_lock: asyncio.Lock | None = field(default=None, repr=False)

    def public_user(self) -> dict[str, Any]:
        return dict(self.user)


def parse_cookies(header: str | None) -> dict[str, str]:
    """Parse the Cookie header defensively: bounded count, size and charset."""
    jar: dict[str, str] = {}
    if not header:
        return jar
    seen = 0
    for part in header.split(";"):
        if seen >= MAX_COOKIES:
            break
        name, sep, value = part.partition("=")
        if not sep:
            continue
        name, value = name.strip(), value.strip()
        if not name or len(name) > 32 or not value or len(value) > MAX_COOKIE_VALUE:
            continue
        if any(ord(ch) <= 0x20 or ord(ch) == 0x7F or ch in ";," for ch in value):
            continue
        if name in jar:
            continue
        jar[name] = value
        seen += 1
    return jar


def safe_return_to(raw: str | None) -> str:
    """Reduce ``return_to`` to a literal dashboard path (no open redirect)."""
    if not raw:
        return DEFAULT_RETURN_TO
    if len(raw) > 512 or any(ord(ch) <= 0x20 or ord(ch) == 0x7F or ch in "\\#" for ch in raw):
        return DEFAULT_RETURN_TO
    if not raw.startswith("/dashboard"):
        return DEFAULT_RETURN_TO
    if raw != "/dashboard" and not raw.startswith("/dashboard/") and not raw.startswith("/dashboard?"):
        return DEFAULT_RETURN_TO
    path = raw.split("?")[0]
    if re.search(r"/{2,}|(?:^|/)\.{1,2}(?:/|$)|/[/?]$", path):
        return DEFAULT_RETURN_TO
    # Percent-encoding would be reinterpreted downstream, so collapse to default.
    if "%" in raw:
        return DEFAULT_RETURN_TO
    return DEFAULT_RETURN_TO if raw == "/dashboard" else raw


def _json(status: int, payload: dict[str, Any]) -> JSONResponse:
    return JSONResponse(payload, status_code=status, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


def _error(status: int, code: str) -> JSONResponse:
    return _json(status, {"error": code})


def _normalize_origin(value: str, *, allow_path: bool) -> tuple[str, str, int] | None:
    """Return the (scheme, host, port) of a browser ``Origin``/``Referer`` value.

    An ``Origin`` header is exactly ``scheme://host[:port]``, so credentials, a
    path, a query and a fragment are all rejected. A ``Referer`` is a full URL,
    so a path and a query are legitimate, but credentials and a fragment never
    are. Keeping the two strictnesses separate avoids accepting a crafted
    ``Origin`` such as ``http://host/@evil`` or ``http://user@host``.
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    if parts.username is not None or parts.password is not None or parts.fragment:
        return None
    if allow_path:
        if not parts.path.startswith("/"):
            return None
    elif parts.path or parts.query:
        return None
    default = 443 if parts.scheme == "https" else 80
    return (parts.scheme, parts.hostname.lower(), port or default)


class SSOService:
    """Owns the OIDC client, the in-memory session store and CSRF checks.

    When a :class:`auth_settings.SettingsStore` is supplied the service follows
    the console: every entry point calls :meth:`sync`, which rebinds the OIDC
    client and drops the discovery cache when the operator changed the provider
    or the allow-list. That is what makes an SSO change apply without a restart.
    """

    def __init__(self, config: SSOConfig, *, client: OidcClient | None = None,
                 store: auth_settings.SettingsStore | None = None):
        self.config = config
        self.store = store
        self.oidc = client or OidcClient(config)
        self.sessions: dict[str, SSOSession] = {}
        self.transactions: dict[str, LoginTransaction] = {}
        self._signature = self._config_signature()
        # The frozen SSO contract: browser writes are trusted only from the
        # configured PUBLIC_ORIGIN. The legacy ``admin_allowed_origins`` list is
        # deliberately NOT consulted here, because it must never widen SSO scope.
        self._public_origin = _normalize_origin(config.public_origin, allow_path=False)

    # -------------------------------------------------------------- settings

    async def probe(self, settings: dict) -> None:
        """Run discovery for candidate settings before they are saved.

        Reuses this client's transport, so a deployment (or a test) that reaches
        its provider through a specific channel validates against the same one.
        Raises ``OidcError`` when the provider is unusable.
        """
        from .sso_config import from_settings
        from .sso_oidc import OidcClient

        candidate = OidcClient(
            from_settings(settings, allow_local=self.config.allow_insecure_localhost),
            transport=getattr(self.oidc, "_transport", None))
        try:
            await candidate.discover()
        finally:
            await candidate.aclose()

    def _config_signature(self) -> tuple:
        return (self.config.enabled, self.config.public_origin, self.config.oidc_issuer,
                self.config.oidc_client_id, self.config.oidc_client_secret, self.config.scopes,
                self.store.fingerprint() if self.store is not None else "")

    def sync(self) -> None:
        """Adopt the console settings if they changed since the last request."""
        if self.store is None:
            return
        from .sso_config import from_settings

        values = self.store.current()
        projected = from_settings(values, allow_local=self.config.allow_insecure_localhost)
        signature = (projected.enabled, projected.public_origin, projected.oidc_issuer,
                     projected.oidc_client_id, projected.oidc_client_secret, projected.scopes,
                     self.store.fingerprint())
        if signature == self._signature:
            return
        self.config = projected
        self._public_origin = _normalize_origin(projected.public_origin, allow_path=False)
        self._signature = signature
        self.oidc.rebind(projected, keep_transport=True)
        if not projected.enabled:
            # Disabling SSO must not leave usable sessions behind.
            self.revoke_all()

    def current_settings(self) -> dict:
        """The settings the allow-list is read from.

        A service built without a settings store has no allow-list, so it admits
        nobody: admission is never inferred from role claims.
        """
        if self.store is None:
            return auth_settings.with_defaults({**auth_settings.DEFAULT_SSO,
                                                "keyLoginEnabled": False})
        return self.store.current()

    def redirect_uri(self, request: Request | None = None) -> str:
        """Public URL when configured, otherwise derived from the request."""
        if self.config.public_origin:
            return self.config.redirect_uri
        if request is None:
            return self.config.redirect_uri
        return f"{str(request.base_url).rstrip('/')}/sso/callback"

    # ------------------------------------------------------------- lifecycle

    async def aclose(self) -> None:
        self.sessions.clear()
        self.transactions.clear()
        await self.oidc.aclose()

    # ---------------------------------------------------------------- routes

    async def login(self, request: Request) -> Response:
        self.sync()
        if request.method not in ("GET", "HEAD"):
            return _error(405, "method_not_allowed")
        if not self.config.enabled:
            return _error(404, "sso_disabled")
        # A fresh login supersedes whatever this browser already holds.
        existing = self._lookup(request)
        if existing is not None:
            self._forget(existing)

        return_to = safe_return_to(request.query_params.get("return_to"))
        self._sweep()
        if len(self.transactions) >= self.config.max_sessions:
            oldest = next(iter(self.transactions), None)
            if oldest is not None:
                self.transactions.pop(oldest, None)

        state, nonce, verifier = random_token(32), random_token(32), create_code_verifier()
        self.transactions[state] = LoginTransaction(
            state=state, nonce=nonce, verifier=verifier, return_to=return_to,
            expires_at=time.time() + self.config.transaction_ttl_ms / 1000,
        )
        try:
            target = await self.oidc.build_authorize_url(
                redirect_uri=self.redirect_uri(request), state=state, nonce=nonce, verifier=verifier,
            )
        except OidcError as error:
            self.transactions.pop(state, None)
            return _error(502, error.code)
        response = RedirectResponse(target, status_code=302, headers={"Cache-Control": "no-store"})
        self._set_cookie(response, TRANSACTION_COOKIE, state, self.config.transaction_ttl_ms // 1000)
        return response

    async def callback(self, request: Request) -> Response:
        self.sync()
        if request.method not in ("GET", "HEAD"):
            return _error(405, "method_not_allowed")
        if not self.config.enabled:
            return _error(404, "sso_disabled")
        cookies = parse_cookies(request.headers.get("cookie"))
        cookie_state = cookies.get(TRANSACTION_COOKIE, "")
        supplied = request.query_params.get("state") or ""
        # One-use: the transaction is consumed before any exchange is attempted.
        transaction = self.transactions.pop(supplied, None) if supplied else None

        if transaction is None or not cookie_state or not hmac.compare_digest(transaction.state, cookie_state):
            response = _error(403, "login_transaction_invalid")
            self._clear_cookie(response, TRANSACTION_COOKIE)
            return response
        if transaction.expires_at < time.time():
            response = _error(403, "login_transaction_expired")
            self._clear_cookie(response, TRANSACTION_COOKIE)
            return response
        if request.query_params.get("error"):
            response = _error(403, "authorize_failed")
            self._clear_cookie(response, TRANSACTION_COOKIE)
            return response
        code = request.query_params.get("code")
        if not code:
            response = _error(403, "authorize_failed")
            self._clear_cookie(response, TRANSACTION_COOKIE)
            return response

        try:
            tokens = await self.oidc.exchange_code(
                code=code, redirect_uri=self.redirect_uri(request), verifier=transaction.verifier,
            )
        except OidcError:
            response = _error(403, "token_exchange_failed")
            self._clear_cookie(response, TRANSACTION_COOKIE)
            return response
        if not tokens.id_token:
            response = _error(403, "id_token_invalid")
            self._clear_cookie(response, TRANSACTION_COOKIE)
            return response
        try:
            claims = await self.oidc.verify_id_token(id_token=tokens.id_token, nonce=transaction.nonce)
        except OidcError:
            response = _error(403, "id_token_invalid")
            self._clear_cookie(response, TRANSACTION_COOKIE)
            return response
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject:
            response = _error(403, "id_token_invalid")
            self._clear_cookie(response, TRANSACTION_COOKIE)
            return response

        # Allow-list admission (design D2.3): the role claims are informational
        # only, because only the operator can name the admitted identities.
        try:
            info = await self.oidc.user_info(tokens.access_token)
        except OidcError:
            response = _error(403, "forbidden")
            self._clear_cookie(response, TRANSACTION_COOKIE)
            return response
        if not _admits(info, subject, self.current_settings()):
            response = _error(403, "forbidden")
            self._clear_cookie(response, TRANSACTION_COOKIE)
            return response

        previous = self._lookup(request)
        if previous is not None:
            self._forget(previous)
        session = self._create_session(subject, tokens, info)
        response = RedirectResponse(transaction.return_to, status_code=302, headers={"Cache-Control": "no-store"})
        self._set_cookie(response, SESSION_COOKIE, session.id, self.config.session_ttl_ms // 1000)
        self._clear_cookie(response, TRANSACTION_COOKIE)
        return response

    async def session(self, request: Request) -> Response:
        self.sync()
        if request.method not in ("GET", "HEAD"):
            return _error(405, "method_not_allowed")
        try:
            session = await self.authorize(request)
        except SSOAuthError as error:
            if error.status == 403:
                return _error(403, error.code)
            return _json(401, {"authenticated": False, "csrf_token": None, "user": None})
        return _json(200, {
            "authenticated": True,
            "csrf_token": session.csrf_token,
            "user": session.public_user(),
        })

    async def public_config(self, request: Request) -> Response:
        """The unauthenticated login-page contract (design D2.1)."""
        self.sync()
        if request.method not in ("GET", "HEAD"):
            return _error(405, "method_not_allowed")
        from . import panel_key

        settings = self.current_settings()
        return _json(200, panel_key.public_config(
            settings, key_configured=bool(getattr(self, "panel_key", ""))))

    async def logout(self, request: Request) -> Response:
        if request.method != "POST":
            return _error(405, "method_not_allowed")
        session = self.resolve(request)
        if session is None:
            return _error(401, "unauthenticated")
        try:
            self.require_csrf(request, session)
        except SSOAuthError as error:
            return _error(error.status, error.code)
        self._forget(session)
        response = _json(200, {"authenticated": False})
        self._clear_cookie(response, SESSION_COOKIE)
        return response

    # ------------------------------------------------------------ authorize

    async def authorize(self, request: Request) -> SSOSession:
        """Resolve, refresh and verify a live, allow-listed session."""
        self.sync()
        session = self._resolve(request)
        if session is None:
            raise SSOAuthError(401, "unauthenticated")
        try:
            await self._ensure_fresh_token(session)
        except SSOAuthError:
            raise
        self._assert_live(session)

        try:
            info = await self.oidc.user_info(session.access_token)
        except OidcError:
            raise SSOAuthError(403, "forbidden") from None
        # Re-check full liveness after the network round trip: a concurrent logout
        # or an expiry that elapsed mid-flight must not be forgiven.
        self._assert_live(session)
        if not _admits(info, session.sub, self.current_settings()):
            raise SSOAuthError(403, "forbidden")

        session.user = _project_user(info)
        session.last_seen_at = time.time()
        return session

    def revoke_all(self) -> None:
        """Revoke every session, including tokens held by pending refreshes."""
        for session in tuple(self.sessions.values()):
            self._forget(session)

    def resolve(self, request: Request) -> SSOSession | None:
        return self._resolve(request)

    def require_csrf(self, request: Request, session: SSOSession, *, allow_referer: bool = False) -> None:
        """Validate a state-changing browser request.

        Only ``PUBLIC_ORIGIN`` is trusted: an exact matching ``Origin`` header,
        and, for the CSRF-gated ``GET /admin/oauth/poll`` where browsers omit
        ``Origin``, a matching same-origin ``Referer``. Cross-site Fetch
        Metadata is always refused and the legacy admin origin allowlist never
        widens this check. The CSRF token itself is compared in constant time.
        """
        self._require_trusted_origin(request, allow_referer=allow_referer)
        supplied = request.headers.get("x-csrf-token")
        if not isinstance(supplied, str) or not supplied or not session.csrf_token:
            raise SSOAuthError(403, "csrf_denied")
        if not hmac.compare_digest(supplied.encode(), session.csrf_token.encode()):
            raise SSOAuthError(403, "csrf_denied")

    def _require_trusted_origin(self, request: Request, *, allow_referer: bool) -> None:
        site = request.headers.get("sec-fetch-site")
        if site is not None and site not in ("same-origin", "none"):
            raise SSOAuthError(403, "origin_denied")
        origin = request.headers.get("origin")
        if origin is not None:
            if self._public_origin is not None \
                    and _normalize_origin(origin, allow_path=False) == self._public_origin:
                return
            raise SSOAuthError(403, "origin_denied")
        # No `Origin`: a browser never attaches one to a same-origin GET, so the
        # CSRF-gated OAuth poll may fall back to a matching same-origin Referer.
        if not allow_referer:
            raise SSOAuthError(403, "origin_denied")
        referer = request.headers.get("referer")
        if referer is None or self._public_origin is None \
                or _normalize_origin(referer, allow_path=True) != self._public_origin:
            raise SSOAuthError(403, "origin_denied")

    # ------------------------------------------------------------- internals

    def _create_session(self, sub: str, tokens: Any, info: Any) -> SSOSession:
        self._sweep()
        if len(self.sessions) >= self.config.max_sessions:
            oldest = next(iter(self.sessions), None)
            if oldest is not None:
                self.sessions.pop(oldest, None)
        now = time.time()
        session = SSOSession(
            id=secrets.token_urlsafe(32),
            csrf_token=secrets.token_urlsafe(32),
            sub=sub,
            access_token=tokens.access_token,
            user=_project_user(info),
            expires_at=now + self.config.session_ttl_ms / 1000,
            last_seen_at=now,
            refresh_token=tokens.refresh_token,
            access_token_expires_at=tokens.expires_at,
        )
        self.sessions[session.id] = session
        return session

    def _forget(self, session: SSOSession) -> None:
        self.sessions.pop(session.id, None)
        session.access_token = ""
        session.refresh_token = None

    def _lookup(self, request: Request) -> SSOSession | None:
        cookie = parse_cookies(request.headers.get("cookie")).get(SESSION_COOKIE)
        return self.sessions.get(cookie) if cookie else None

    def _resolve(self, request: Request) -> SSOSession | None:
        session = self._lookup(request)
        if session is None:
            return None
        now = time.time()
        if now >= session.expires_at or now - session.last_seen_at >= self.config.session_idle_ms / 1000:
            self._forget(session)
            return None
        return session

    def _assert_live(self, session: SSOSession) -> None:
        if self.sessions.get(session.id) is not session:
            raise SSOAuthError(401, "unauthenticated")
        now = time.time()
        if now >= session.expires_at or now - session.last_seen_at >= self.config.session_idle_ms / 1000:
            self._forget(session)
            raise SSOAuthError(401, "unauthenticated")

    async def _ensure_fresh_token(self, session: SSOSession) -> None:
        if time.time() < session.access_token_expires_at - ACCESS_TOKEN_SKEW_SECONDS:
            return
        if not self.config.oidc_refresh or not session.refresh_token:
            raise SSOAuthError(403, "forbidden")
        if session.refresh_lock is None:
            session.refresh_lock = asyncio.Lock()
        async with session.refresh_lock:
            # Another waiter may already have rotated the token.
            if time.time() < session.access_token_expires_at - ACCESS_TOKEN_SKEW_SECONDS:
                self._assert_live(session)
                return
            refresh_token = session.refresh_token
            if not refresh_token:
                raise SSOAuthError(403, "forbidden")
            try:
                tokens = await self.oidc.refresh(refresh_token)
            except OidcError:
                self._forget(session)
                raise SSOAuthError(403, "forbidden") from None
            # A concurrent logout may have removed the session mid-flight.
            if self.sessions.get(session.id) is not session:
                raise SSOAuthError(401, "unauthenticated")
            if tokens.id_token:
                try:
                    await self.oidc.verify_id_token(id_token=tokens.id_token, expected_sub=session.sub)
                except OidcError:
                    self._forget(session)
                    raise SSOAuthError(403, "forbidden") from None
                if self.sessions.get(session.id) is not session:
                    raise SSOAuthError(401, "unauthenticated")
            session.access_token = tokens.access_token
            session.access_token_expires_at = tokens.expires_at
            session.refresh_token = tokens.refresh_token or refresh_token

    def _sweep(self) -> None:
        now = time.time()
        for sid, session in list(self.sessions.items()):
            if now >= session.expires_at or now - session.last_seen_at >= self.config.session_idle_ms / 1000:
                self.sessions.pop(sid, None)
        for state, transaction in list(self.transactions.items()):
            if transaction.expires_at < now:
                self.transactions.pop(state, None)

    def _set_cookie(self, response: Response, name: str, value: str, max_age: int) -> None:
        response.set_cookie(
            name, value,
            max_age=max(0, int(max_age)),
            path="/",
            httponly=True,
            samesite="lax",
            secure=self.config.cookie_secure,
        )

    def _clear_cookie(self, response: Response, name: str) -> None:
        response.delete_cookie(name, path="/", httponly=True, samesite="lax", secure=self.config.cookie_secure)


def _admits(info: Any, expected_sub: str, settings) -> bool:
    """The allow-list rule, shared by the callback and every later request."""
    if info.sub != expected_sub:
        return False
    return auth_settings.admits(
        settings, subject=info.sub, email=info.email or "",
        email_verified=bool(info.email_verified))


def _project_user(info: Any) -> dict[str, Any]:
    user: dict[str, Any] = {"sub": info.sub, "role": "admin"}
    if info.username:
        user["username"] = info.username
    if info.name:
        user["name"] = info.name
    if info.email:
        user["email"] = info.email
    return user


class SSOAdminMiddleware:
    """Guard ``/admin/*`` with a live SSO identity; owns ``/admin/session``.

    The legacy ``AdminMiddleware`` (API-key cookie or Bearer key) is not
    installed in SSO mode, so neither a stored key session nor an API-key header
    can authorize management routes. The ``dispatch`` hook is still honoured so
    management adaptations (credential inventory shape, account-OAuth task
    ownership) keep working.
    """

    def __init__(self, app, sso: SSOService, config: dict, dispatch=None, token: str = ""):
        self.app = app
        self.sso = sso
        self.config = config
        self.dispatch = dispatch
        self.token = token

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not str(scope.get("path", "")).startswith("/admin/"):
            return await self.app(scope, receive, send)
        request = Request(scope, receive)
        path = scope["path"]
        method = scope.get("method", "GET")
        if await platform_token.authorize(
                scope, receive, send, token=self.token, dispatch=self.dispatch, app=self.app):
            return
        if path == "/admin/session":
            return await self._session(scope, receive, send, request, method)
        try:
            session = await self.sso.authorize(request)
            # A GET that mutates account state still requires the gateway CSRF.
            if method not in ("GET", "HEAD", "OPTIONS") or path == "/admin/oauth/poll":
                self.sso.require_csrf(request, session, allow_referer=path == "/admin/oauth/poll")
        except SSOAuthError as error:
            return await _error(error.status, error.code)(scope, receive, send)
        scope.setdefault("state", {}).update(
            admin_identity="sso:" + session.sub, admin_cookie=True,
            admin_session={"csrf_token": session.csrf_token})
        downstream = scope
        if self.dispatch is not None:
            adapted = await self.dispatch(request)
            if adapted is not None:
                return await adapted(downstream, receive, _no_store_send(send))
        return await self.app(downstream, receive, _no_store_send(send))

    async def _session(self, scope, receive, send, request: Request, method: str):
        if method == "POST":
            # The API-key login is disabled in SSO mode; reject before any CSRF work.
            return await _error(405, "method_not_allowed")(scope, receive, send)
        if method not in ("GET", "HEAD", "DELETE"):
            return await _error(405, "method_not_allowed")(scope, receive, send)
        if method == "DELETE":
            session = self.sso.resolve(request)
            if session is None:
                return await _error(401, "unauthenticated")(scope, receive, send)
            try:
                self.sso.require_csrf(request, session)
            except SSOAuthError as error:
                return await _error(error.status, error.code)(scope, receive, send)
            response = _json(200, {"authenticated": False})
            self.sso._forget(session)
            self.sso._clear_cookie(response, SESSION_COOKIE)
            return await response(scope, receive, send)
        try:
            session = await self.sso.authorize(request)
        except SSOAuthError as error:
            if error.status == 403:
                return await _error(403, error.code)(scope, receive, send)
            return await _json(401, {"authenticated": False, "csrf_token": None})(scope, receive, send)
        return await _json(200, {"authenticated": True, "csrf_token": session.csrf_token})(scope, receive, send)


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


def install_sso(app, config: dict, *, client: OidcClient | None = None,
                store=None) -> SSOService:
    """Register ``/sso/*`` routes for an SSO-capable application.

    The routes are always installed so the login page can ask for the public
    auth contract and so enabling SSO from the console takes effect without a
    restart; each handler answers ``404 sso_disabled`` until SSO is enabled.
    """
    settings: SSOConfig = config["sso"]
    store = store if store is not None else config.get("auth_settings")
    service = SSOService(settings, client=client, store=store)
    # Only tells the login page whether to offer the key field at all.
    service.panel_key = config.get("panel_key", "")
    app.state.sso = service
    app.add_api_route("/sso/config", service.public_config, methods=["GET", "HEAD"],
                      include_in_schema=False)
    app.add_api_route("/sso/login", service.login, methods=["GET", "HEAD"], include_in_schema=False)
    app.add_api_route("/sso/callback", service.callback, methods=["GET", "HEAD"], include_in_schema=False)
    app.add_api_route("/sso/session", service.session, methods=["GET", "HEAD"], include_in_schema=False)
    app.add_api_route("/sso/logout", service.logout, methods=["POST"], include_in_schema=False)
    return service