"""Native OIDC/SSO configuration, resolved once at startup and fail-closed.

SSO mode is off by default so the original API-key administration keeps working
for existing deployments and regression tests. When ``CODEBUDDY2API_SSO_ENABLED``
is true every value below is mandatory and validated before any store is opened,
so a misconfigured deployment refuses to start instead of serving a weaker
authentication surface.

The variable names deliberately match the retired Node gateway so operators can
carry their existing deployment notes across unchanged.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlsplit

ENV_ENABLED = "CODEBUDDY2API_SSO_ENABLED"
ENV_PUBLIC_ORIGIN = "PUBLIC_ORIGIN"
ENV_OIDC_ISSUER = "OIDC_ISSUER"
ENV_OIDC_CLIENT_ID = "OIDC_CLIENT_ID"
ENV_OIDC_CLIENT_SECRET = "OIDC_CLIENT_SECRET"
ENV_OIDC_REFRESH = "OIDC_REFRESH"
ENV_ALLOW_INSECURE_LOCALHOST = "ALLOW_INSECURE_LOCALHOST"

DEFAULT_SESSION_TTL_MS = 28_800_000
DEFAULT_SESSION_IDLE_MS = 1_800_000
DEFAULT_TRANSACTION_TTL_MS = 300_000
DEFAULT_MAX_SESSIONS = 1000
DEFAULT_OAUTH_TIMEOUT_MS = 5000

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_MAX_SECRET_CHARS = 4096


class SSOConfigError(ValueError):
    """SSO mode was requested but its configuration is missing or unsafe."""


@dataclass(frozen=True)
class SSOConfig:
    """Immutable SSO settings; ``enabled`` is False for legacy deployments."""

    enabled: bool = False
    public_origin: str = ""
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_refresh: bool = False
    allow_insecure_localhost: bool = False
    session_ttl_ms: int = DEFAULT_SESSION_TTL_MS
    session_idle_ms: int = DEFAULT_SESSION_IDLE_MS
    transaction_ttl_ms: int = DEFAULT_TRANSACTION_TTL_MS
    max_sessions: int = DEFAULT_MAX_SESSIONS
    oauth_timeout_ms: int = DEFAULT_OAUTH_TIMEOUT_MS

    @property
    def cookie_secure(self) -> bool:
        """Secure is mandatory on HTTPS; omitted only for explicit loopback dev."""
        if self.public_origin.startswith("https://"):
            return True
        return not self.allow_insecure_localhost

    @property
    def redirect_uri(self) -> str:
        return f"{self.public_origin}/sso/callback"

    @property
    def scopes(self) -> str:
        base = "openid profile roles"
        return f"{base} offline_access" if self.oidc_refresh else base

    @property
    def timeout_seconds(self) -> float:
        return self.oauth_timeout_ms / 1000


def is_loopback(host: str) -> bool:
    return host.lower() in _LOOPBACK_HOSTS


def _bool(environ: Mapping[str, str], name: str, default: bool = False) -> bool:
    raw = environ.get(name)
    if raw is None or raw == "":
        return default
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    raise SSOConfigError(f"{name} 必须为 true 或 false")


def _integer(environ: Mapping[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = environ.get(name)
    if raw is None or raw == "":
        return default
    text = raw.strip()
    if not text.isdigit() or (len(text) > 1 and text.startswith("0")):
        raise SSOConfigError(f"{name} 必须为十进制整数")
    value = int(text)
    if not minimum <= value <= maximum:
        raise SSOConfigError(f"{name} 超出允许范围 {minimum}..{maximum}")
    return value


def _secret(environ: Mapping[str, str], name: str) -> str:
    raw = environ.get(name)
    if raw is None:
        raise SSOConfigError(f"SSO 模式必须设置 {name}")
    if raw != raw.strip() or not raw:
        raise SSOConfigError(f"{name} 不能为空且首尾不得包含空白")
    if len(raw) > _MAX_SECRET_CHARS or any(ord(ch) < 32 or ch == "\x7f" for ch in raw):
        raise SSOConfigError(f"{name} 含不允许的字符")
    return raw


def _origin(value: str, name: str, allow_insecure: bool, allow_path: bool = False) -> str:
    """Validate an origin; HTTPS is required except for the loopback dev escape."""
    if value != value.strip() or not value:
        raise SSOConfigError(f"{name} 不能为空且首尾不得包含空白")
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        raise SSOConfigError(f"{name} 不是合法 URL") from None
    if (parts.username is not None or parts.password is not None
            or parts.query or parts.fragment or parts.scheme not in ("http", "https")):
        raise SSOConfigError(f"{name} 必须是不含凭据、查询或片段的 http(s) 地址")
    if not allow_path and parts.path not in ("", "/"):
        raise SSOConfigError(f"{name} 不得包含路径")
    if port is not None and not 1 <= port <= 65535:
        raise SSOConfigError(f"{name} 端口无效")
    if not parts.hostname:
        raise SSOConfigError(f"{name} 缺少主机名")
    if parts.scheme != "https" and not (allow_insecure and is_loopback(parts.hostname)):
        raise SSOConfigError(f"{name} 必须使用 HTTPS（仅显式回环开发可放宽）")
    if parts.path in ("", "/"):
        return value.rstrip("/")
    return value.rstrip("/")


def load(environ: Mapping[str, str] | None = None) -> SSOConfig:
    """Resolve SSO settings; raises ``SSOConfigError`` when the mode is unsafe."""
    environ = os.environ if environ is None else environ
    allow_insecure = _bool(environ, ENV_ALLOW_INSECURE_LOCALHOST)
    if not _bool(environ, ENV_ENABLED):
        # Legacy mode: nothing else is read so an unrelated stray variable cannot
        # block an existing deployment.
        return SSOConfig(allow_insecure_localhost=allow_insecure)

    public_origin = _origin(_secret(environ, ENV_PUBLIC_ORIGIN), ENV_PUBLIC_ORIGIN, allow_insecure)
    oidc_issuer = _origin(_secret(environ, ENV_OIDC_ISSUER), ENV_OIDC_ISSUER, allow_insecure, allow_path=True)
    config = SSOConfig(
        enabled=True,
        public_origin=public_origin,
        oidc_issuer=oidc_issuer,
        oidc_client_id=_secret(environ, ENV_OIDC_CLIENT_ID),
        oidc_client_secret=_secret(environ, ENV_OIDC_CLIENT_SECRET),
        oidc_refresh=_bool(environ, ENV_OIDC_REFRESH),
        allow_insecure_localhost=allow_insecure,
        session_ttl_ms=_integer(environ, "SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS, 60_000, 86_400_000),
        session_idle_ms=_integer(environ, "SESSION_IDLE_MS", DEFAULT_SESSION_IDLE_MS, 60_000, 86_400_000),
        transaction_ttl_ms=_integer(environ, "TRANSACTION_TTL_MS", DEFAULT_TRANSACTION_TTL_MS, 10_000, 600_000),
        max_sessions=_integer(environ, "MAX_SESSIONS", DEFAULT_MAX_SESSIONS, 1, 100_000),
        oauth_timeout_ms=_integer(environ, "OAUTH_TIMEOUT_MS", DEFAULT_OAUTH_TIMEOUT_MS, 100, 30_000),
    )
    if config.session_idle_ms > config.session_ttl_ms:
        raise SSOConfigError("SESSION_IDLE_MS 不得大于 SESSION_TTL_MS")
    return config

def deployment_origin(environ: Mapping[str, str] | None = None) -> str:
    """The deployment's public origin from ``PUBLIC_ORIGIN``; empty when unset.

    A console served on its own domain sets it once in the deployment, so it is
    read live rather than copied into the console settings.
    """
    environ = os.environ if environ is None else environ
    return (environ.get(ENV_PUBLIC_ORIGIN) or "").strip().rstrip("/")


def from_settings(settings: Mapping[str, Any], *, allow_local: bool = False,
                  environ: Mapping[str, str] | None = None) -> SSOConfig:
    """Project a console settings document onto the immutable OIDC config.

    The origin comes from the console's callback URL, then ``PUBLIC_ORIGIN``.
    It may be empty: the service then derives the redirect URI from the request,
    which is what design D2.3 asks for.
    """
    environ = os.environ if environ is None else environ
    origin = str(settings.get("callbackUrl") or "")
    if origin.endswith("/sso/callback"):
        origin = origin[: -len("/sso/callback")]
    origin = origin or deployment_origin(environ)
    return SSOConfig(
        enabled=settings.get("enabled") is True,
        public_origin=origin,
        oidc_issuer=str(settings.get("issuer") or ""),
        oidc_client_id=str(settings.get("clientId") or ""),
        oidc_client_secret=str(settings.get("clientSecret") or ""),
        oidc_refresh="offline_access" in str(settings.get("scope") or ""),
        allow_insecure_localhost=allow_local,
        session_ttl_ms=_integer(environ, "SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS, 60_000, 86_400_000),
        session_idle_ms=_integer(environ, "SESSION_IDLE_MS", DEFAULT_SESSION_IDLE_MS, 60_000, 86_400_000),
        transaction_ttl_ms=_integer(environ, "TRANSACTION_TTL_MS", DEFAULT_TRANSACTION_TTL_MS, 10_000, 600_000),
        max_sessions=_integer(environ, "MAX_SESSIONS", DEFAULT_MAX_SESSIONS, 1, 100_000),
        oauth_timeout_ms=_integer(environ, "OAUTH_TIMEOUT_MS", DEFAULT_OAUTH_TIMEOUT_MS, 100, 30_000),
    )