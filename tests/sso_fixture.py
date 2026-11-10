"""Deterministic in-process OIDC provider for the native SSO tests.

Not a test module (no ``test_`` prefix) so pytest never collects it. It answers
discovery, JWKS, token and UserInfo over ``httpx.MockTransport``, so the tests
exercise the real ``OidcClient`` verification code without any network access.
"""
from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any, Awaitable, Callable

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

ISSUER = "http://localhost"
CLIENT_ID = "cb-client"
CLIENT_SECRET = "cb-secret"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


class FakeIdp:
    """Minimal OIDC provider whose behaviour each test can override."""

    def __init__(
        self,
        *,
        sub: str = "admin-1",
        role: str | None = "admin",
        is_admin: bool | None = True,
        username: str | None = "ops",
        name: str | None = "Console Operator",
        email: str | None = None,
        email_verified: bool = True,
        token_auth_methods: tuple[str, ...] = ("client_secret_basic",),
        signing_alg: str = "RS256",
        discovery_issuer: str | None = None,
        userinfo_status: int = 200,
        token_status: int = 200,
        token_error: str | None = None,
        token_redirect: bool = False,
        expires_in: int = 3600,
        refresh_token: str | None = None,
        refresh_id_token: bool = False,
        refresh_expires_in: int | None = None,
        id_token_overrides: dict[str, Any] | None = None,
        offline_userinfo: bool = False,
        discovery_overrides: dict[str, Any] | None = None,
        pad_discovery_bytes: int = 0,
        discovery_status: int = 200,
        discovery_failures: int = 0,
        jwks_status: int = 200,
    ):
        self.sub = sub
        self.role = role
        self.is_admin = is_admin
        self.username = username
        self.name = name
        self.email = email
        self.email_verified = email_verified
        self.token_auth_methods = list(token_auth_methods)
        self.signing_alg = signing_alg
        self.discovery_issuer = discovery_issuer or ISSUER
        self.userinfo_status = userinfo_status
        self.token_status = token_status
        self.token_error = token_error
        self.token_redirect = token_redirect
        self.expires_in = expires_in
        self.refresh_token = refresh_token
        self.refresh_id_token = refresh_id_token
        self.refresh_expires_in = refresh_expires_in
        self.id_token_overrides = dict(id_token_overrides or {})
        self.offline_userinfo = offline_userinfo
        self.discovery_overrides = dict(discovery_overrides or {})
        self.pad_discovery_bytes = pad_discovery_bytes
        self.discovery_status = discovery_status
        # Number of leading discovery calls answered with 503 before recovering.
        self.discovery_failures = discovery_failures
        self.jwks_status = jwks_status

        self._key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.kid = "test-key"
        # Additional published keys by kid, used to model key rotation.
        self.extra_keys: dict[str, Any] = {}
        # Kids withheld from the published JWKS, used to model revocation.
        self.omit_kids: set[str] = set()
        self.codes: dict[str, str | None] = {}
        self.access_tokens: dict[str, str] = {}
        self.discovery_calls = 0
        self.jwks_calls = 0
        self.token_calls = 0
        self.refresh_calls = 0
        self.userinfo_calls = 0
        self.token_requests: list[dict[str, Any]] = []
        # Optional async hooks to model a slow/blocked provider.
        self.before_refresh: Callable[[], Awaitable[None]] | None = None
        self.refresh_gate: asyncio.Event | None = None
        self.refresh_started: asyncio.Event | None = None

    # ------------------------------------------------------------- signing

    def _jwk(self) -> dict[str, Any]:
        return self._jwk_for(self.kid, self._key)

    @staticmethod
    def _jwk_for(kid: str, key: Any) -> dict[str, Any]:
        public = key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(
            serialization.load_pem_public_key(public)))
        jwk.update({"kid": kid, "alg": "RS256", "use": "sig"})
        return jwk

    def publish_key(self, kid: str) -> Any:
        """Add a fresh signing key the provider announces in its JWKS."""
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.extra_keys[kid] = key
        return key

    def _jwks(self) -> list[dict[str, Any]]:
        keys = [self._jwk()] + [self._jwk_for(kid, key) for kid, key in self.extra_keys.items()]
        return [item for item in keys if item["kid"] not in self.omit_kids]

    def sign(self, *, nonce: str | None = None, sub: str | None = None,
             overrides: dict[str, Any] | None = None, key: Any = None,
             kid: str | None = None) -> str:
        now = int(time.time())
        payload: dict[str, Any] = {
            "iss": self.discovery_issuer,
            "aud": CLIENT_ID,
            "azp": CLIENT_ID,
            "sub": sub or self.sub,
            "iat": now,
            "exp": now + 600,
        }
        if nonce is not None:
            payload["nonce"] = nonce
        payload.update(self.id_token_overrides)
        payload.update(overrides or {})
        headers = {"kid": kid or self.kid}
        if self.signing_alg == "RS256":
            return jwt.encode(payload, key or self._key, algorithm="RS256", headers=headers)
        # A non-RS256 token must be rejected even though it is well-formed.
        return jwt.encode(payload, "shared-secret-value-long-enough-for-hs256", algorithm="HS256",
                          headers={"kid": kid or self.kid})

    def issue_code(self, nonce: str | None = None, *, subject: str | None = None) -> str:
        code = f"code-{len(self.codes) + 1}-{_b64(os_random(8))}"
        self.codes[code] = nonce
        self.codes[code + ":sub"] = subject  # type: ignore[assignment]
        return code

    def access_token_for(self, sub: str) -> str:
        token = "at-" + _b64(os_random(16))
        self.access_tokens[token] = sub
        return token

    # ------------------------------------------------------------- transport

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def _discovery(self) -> dict[str, Any]:
        document = {
            "issuer": self.discovery_issuer,
            "authorization_endpoint": ISSUER + "/authorize",
            "token_endpoint": ISSUER + "/token",
            "userinfo_endpoint": ISSUER + "/userinfo",
            "jwks_uri": ISSUER + "/jwks",
            "id_token_signing_alg_values_supported": [self.signing_alg],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": self.token_auth_methods,
        }
        document.update(self.discovery_overrides)
        if self.pad_discovery_bytes:
            document["padding"] = "x" * self.pad_discovery_bytes
        return document

    async def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/.well-known/openid-configuration":
            self.discovery_calls += 1
            if self.discovery_failures > 0:
                self.discovery_failures -= 1
                return httpx.Response(503, json={"error": "temporarily_unavailable"})
            if self.discovery_status != 200:
                return httpx.Response(self.discovery_status, json={"error": "discovery_error"})
            return httpx.Response(200, json=self._discovery())
        if path == "/jwks":
            self.jwks_calls += 1
            if self.jwks_status != 200:
                return httpx.Response(self.jwks_status, json={"error": "jwks_unavailable"})
            return httpx.Response(200, json={"keys": self._jwks()})
        if path == "/token":
            return await self._token(request)
        if path == "/userinfo":
            return self._userinfo(request)
        return httpx.Response(404, json={"error": "not_found"})

    async def _token(self, request: httpx.Request) -> httpx.Response:
        self.token_calls += 1
        form = {k: v for k, v in httpx.QueryParams(request.content.decode()).items()}
        self.token_requests.append({
            "form": form,
            "authorization": request.headers.get("authorization"),
            "content_type": request.headers.get("content-type"),
        })
        if self.token_redirect:
            return httpx.Response(302, headers={"location": "https://evil.invalid/token"})
        if self.token_status != 200:
            return httpx.Response(self.token_status, json={"error": self.token_error or "invalid_grant"})

        if form.get("grant_type") == "refresh_token":
            return await self._refresh(form)

        nonce = self.codes.get(form.get("code", ""))
        if nonce is None:
            return httpx.Response(400, json={"error": "invalid_grant"})
        sub = self.codes.get(form.get("code", "") + ":sub") or self.sub
        access = self.access_token_for(sub)
        body: dict[str, Any] = {
            "access_token": access,
            "token_type": "Bearer",
            "scope": "openid profile roles",
            "expires_in": self.expires_in,
            "id_token": self.sign(nonce=nonce, sub=sub),
        }
        if self.refresh_token:
            body["refresh_token"] = self.refresh_token
        return httpx.Response(200, json=body)

    async def _refresh(self, form: dict[str, str]) -> httpx.Response:
        self.refresh_calls += 1
        if self.refresh_started is not None:
            self.refresh_started.set()
        if self.before_refresh is not None:
            await self.before_refresh()
        if self.refresh_gate is not None:
            await self.refresh_gate.wait()
        if self.refresh_token and form.get("refresh_token") != self.refresh_token:
            return httpx.Response(400, json={"error": "invalid_grant"})
        access = self.access_token_for(self.sub)
        body: dict[str, Any] = {
            "access_token": access,
            "token_type": "Bearer",
            "scope": "openid profile roles",
            "expires_in": self.expires_in if self.refresh_expires_in is None else self.refresh_expires_in,
            "refresh_token": self.refresh_token or "rotated",
        }
        if self.refresh_id_token:
            body["id_token"] = self.sign(sub=self.sub)
        return httpx.Response(200, json=body)

    def _userinfo(self, request: httpx.Request) -> httpx.Response:
        self.userinfo_calls += 1
        if self.offline_userinfo:
            return httpx.Response(self.userinfo_status, json={"error": "unavailable"})
        authorization = request.headers.get("authorization", "")
        token = authorization[7:] if authorization.lower().startswith("bearer ") else ""
        sub = self.access_tokens.get(token)
        if sub is None:
            return httpx.Response(401, json={"error": "invalid_token"})
        body: dict[str, Any] = {"sub": sub}
        if self.role is not None:
            body["role"] = self.role
        if self.is_admin is not None:
            body["isAdmin"] = self.is_admin
        if self.username is not None:
            body["preferred_username"] = self.username
        if self.name is not None:
            body["name"] = self.name
        if self.email is not None:
            body["email"] = self.email
            body["email_verified"] = self.email_verified
        return httpx.Response(self.userinfo_status, json=body)


def os_random(size: int) -> bytes:
    import secrets

    return secrets.token_bytes(size)


def sso_settings(**overrides: str):
    """Build a validated ``SSOConfig`` for loopback tests."""
    from app.sso_config import load as load_sso_config

    env = {
        "CODEBUDDY2API_SSO_ENABLED": "true",
        "PUBLIC_ORIGIN": "http://localhost",
        "OIDC_ISSUER": ISSUER,
        "OIDC_CLIENT_ID": CLIENT_ID,
        "OIDC_CLIENT_SECRET": CLIENT_SECRET,
        "ALLOW_INSECURE_LOCALHOST": "true",
    }
    env.update(overrides)
    return load_sso_config(env)


def settings_store(*, subjects=("admin-1",), emails=(), enabled=True, key_login=True,
                   scope="openid profile email roles"):
    """A console settings document admitting exactly the given identities.

    Admission is an allow-list (design D2.3), so every SSO test needs one; the
    default matches ``FakeIdp``'s subject so the login flows keep working.
    """
    from app import auth_settings

    return auth_settings.SettingsStore(auth_settings.with_defaults({
        "enabled": enabled,
        "keyLoginEnabled": key_login,
        "issuer": ISSUER,
        "clientId": CLIENT_ID,
        "clientSecret": CLIENT_SECRET,
        "scope": scope,
        "providerName": "Test IdP",
        "allowedSubjects": list(subjects),
        "allowedEmails": list(emails),
        "callbackUrl": "http://localhost/sso/callback",
    }), allow_local=True)


def build_sso_app(idp: FakeIdp, settings=None, *, gateway=None, extra_routes=None,
                  store=None, key=""):
    """Assemble a minimal app with native SSO and the SSO-aware admin boundary.

    Returns ``(app, service, config)`` so tests can inspect the session store.
    """
    from fastapi import FastAPI
    from unittest.mock import Mock

    from app.admin_api import install_admin
    from app.sso_auth import install_sso
    from app.panel_auth import install_panel_key
    from app.sso_oidc import OidcClient

    settings = settings or sso_settings()
    # The store drives the live settings, so it must agree with the injected
    # SSOConfig on the scope (offline_access decides whether refresh happens).
    store = store if store is not None else settings_store(scope=settings.scopes)
    app = FastAPI()
    control = Mock()
    control.snapshot.return_value = {"revision": 0, "models": {}, "settings": {}}
    audit = Mock()
    audit.storage.return_value = {"available": True, "degraded": False, "last_error": None}
    audit.list_records.return_value = {"items": [], "next_cursor": None, "has_more": False}
    audit.get_request.return_value = None
    audit.dashboard.return_value = {"summary": {}, "series": [], "models": [], "profiles": []}
    audit.credential_stats.return_value = {}
    audit.clear.return_value = {"ok": True, "scope": "all", "cleared": True}
    config: dict[str, Any] = {
        "api_key": "synthetic-management-key",
        "admin_allowed_origins": "",
        "sso": settings,
        "auth_settings": store,
        "panel_key": key,
        "control_store": control,
        "audit_store": audit,
    }
    if gateway is not None:
        config.update(gateway.config)
        config["management"] = gateway
    service = install_sso(app, config, client=OidcClient(settings, transport=idp.transport()),
                          store=store)
    install_admin(app, config, gateway or _Gateway(), sso=service)
    if extra_routes:
        extra_routes(app)
    # Outermost, exactly as runtime_management.install adds it.
    install_panel_key(app, config, service=None if settings.enabled else service)
    return app, service, config


class _Gateway:
    """Minimal management gateway used when a test does not need real stores."""

    def __init__(self):
        from unittest.mock import Mock

        self.config = {
            "api_key": "synthetic-management-key",
            "admin_allowed_origins": "",
        }
        self.admin_credential_inventory = Mock(return_value=[])
        self.admin_model_inventory = Mock(return_value=[])
        self.catalog_status = Mock(return_value={})
        self.admin_model_preview = Mock(return_value={"candidates": [], "excluded": []})
        self.admin_set_credential_enabled = Mock()
        self.admin_apply_settings = Mock()
        self.admin_delete_guard = Mock()
        self.managed_auth_dir = Mock(return_value=None)
        self._store_credential = Mock()
        self._credential_identity = Mock(return_value=None)
        self._save_oauth_credential = Mock()
        self._OAUTH = Mock()
