"""Native confidential OIDC relying-party client (authorization code + S256 PKCE).

Port of the retired Node gateway's ``src/oidc.ts`` onto the existing ``httpx``
transport and ``PyJWT[crypto]`` for RS256 verification. Security rules kept
verbatim:

- discovery is fetched once and cached; every discovered endpoint must belong to
  the configured issuer origin,
- every outbound call is bounded by ``OAUTH_TIMEOUT_MS`` and never follows a
  redirect (a 3xx is a failure, so no credential can be siphoned elsewhere),
- exactly one client-credential placement is used, chosen from the provider's
  advertised ``token_endpoint_auth_methods_supported``,
- ID tokens are verified with RS256 only, with strict issuer/audience/azp/nonce/
  exp/iat/subject checks; roles are never trusted from the ID token,
- failures raise ``OidcError`` with a fixed, secret-free code.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
import jwt

from .sso_config import SSOConfig

# Cap on any single OIDC JSON response body (discovery/token/userinfo).
MAX_JSON_BYTES = 256 * 1024
# Tolerance for an `iat` claim that appears to be in the future.
IAT_FUTURE_TOLERANCE_SECONDS = 60
# Clock skew allowed on expiry/`nbf`.
CLOCK_LEEWAY_SECONDS = 5
# JWKS refresh cooldown after a failed lookup, and key cache lifetime.
JWKS_COOLDOWN_SECONDS = 30
JWKS_CACHE_SECONDS = 600


class OidcError(Exception):
    """Fixed, secret-free OIDC failure code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code
        self.name = "OidcError"


@dataclass
class TokenSet:
    access_token: str
    id_token: str | None
    refresh_token: str | None
    scope: str
    expires_at: float  # absolute wall-clock seconds


@dataclass
class LiveUserInfo:
    sub: str
    username: str | None = None
    name: str | None = None
    role: str | None = None
    is_admin: bool | None = None


@dataclass
class DiscoveryDocument:
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    userinfo_endpoint: str
    jwks_uri: str
    id_token_signing_alg_values_supported: list[str]
    code_challenge_methods_supported: list[str]
    token_endpoint_auth_methods_supported: list[str]


@dataclass
class _DiscoveryCache:
    document: DiscoveryDocument
    jwks: dict[str, Any]


def create_code_verifier() -> str:
    """PKCE S256 verifier: 43+ unreserved characters."""
    return secrets.token_urlsafe(32)


def code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def random_token(size: int = 32) -> str:
    return secrets.token_urlsafe(size)


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _as_mapping(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _normalize_issuer(issuer: str) -> str:
    return issuer.rstrip("/")


class OidcClient:
    def __init__(self, config: SSOConfig, *, transport: httpx.AsyncBaseTransport | None = None):
        self.config = config
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._client_loop = None
        self._discovery: _DiscoveryCache | None = None
        self._jwks_fetched_at = 0.0
        self._jwks_attempt_at = 0.0
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------- lifecycle

    def _http(self) -> httpx.AsyncClient:
        """One client per running event loop, bounded by the configured timeout."""
        loop = asyncio.get_running_loop()
        if self._client is None or self._client_loop is not loop:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.config.timeout_seconds),
                follow_redirects=False,
                transport=self._transport,
                headers={"accept": "application/json"},
            )
            self._client_loop = loop
        return self._client

    async def aclose(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                pass

    # ------------------------------------------------------------- public API

    async def build_authorize_url(self, *, redirect_uri: str, state: str, nonce: str, verifier: str) -> str:
        document = (await self._load()).document
        query = urlencode({
            "response_type": "code",
            "client_id": self.config.oidc_client_id,
            "redirect_uri": redirect_uri,
            "scope": self.config.scopes,
            "state": state,
            "nonce": nonce,
            "code_challenge": code_challenge(verifier),
            "code_challenge_method": "S256",
        })
        # Deliberately no `prompt` and no `max_age`: the provider rejects both.
        separator = "&" if "?" in document.authorization_endpoint else "?"
        return document.authorization_endpoint + separator + query

    async def exchange_code(self, *, code: str, redirect_uri: str, verifier: str) -> TokenSet:
        document = (await self._load()).document
        method = self._token_auth_method(document)
        body = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
            "client_id": self.config.oidc_client_id,
        }
        headers: dict[str, str] = {}
        if method == "client_secret_basic":
            headers["authorization"] = self._basic_auth_header()
        elif method == "client_secret_post":
            body["client_secret"] = self.config.oidc_client_secret
        status, payload = await self._post_form(document.token_endpoint, body, headers)
        if status != 200:
            raise OidcError(_optional_string(payload.get("error")) or "token_exchange_failed")
        return self._to_token_set(payload, require_id_token=True)

    async def verify_id_token(
        self,
        *,
        id_token: str,
        nonce: str | None = None,
        expected_sub: str | None = None,
        audience: str | None = None,
    ) -> dict[str, Any]:
        cache = await self._load()
        required_audience = audience or self.config.oidc_client_id
        try:
            header = jwt.get_unverified_header(id_token)
        except jwt.PyJWTError:
            raise OidcError("id_token_invalid") from None
        if header.get("alg") != "RS256":
            raise OidcError("id_token_invalid")
        key = await self._key_for(header.get("kid"))
        try:
            payload = jwt.decode(
                id_token,
                key,
                algorithms=["RS256"],
                audience=required_audience,
                issuer=cache.document.issuer,
                leeway=CLOCK_LEEWAY_SECONDS,
                options={
                    "require": ["exp", "iat", "iss", "aud", "sub"],
                    "verify_exp": True,
                    "verify_iat": False,  # checked manually with the wider tolerance below
                    "verify_nbf": False,
                    "verify_signature": True,
                    "verify_aud": True,
                    "verify_iss": True,
                },
            )
        except jwt.PyJWTError:
            raise OidcError("id_token_invalid") from None

        if payload.get("azp") is not None and payload.get("azp") != self.config.oidc_client_id:
            raise OidcError("azp_mismatch")
        aud = payload.get("aud")
        if isinstance(aud, list) and len(aud) > 1 and not isinstance(payload.get("azp"), str):
            raise OidcError("azp_missing")
        if nonce is not None and payload.get("nonce") != nonce:
            raise OidcError("nonce_mismatch")
        iat = payload.get("iat")
        if isinstance(iat, (int, float)) and iat > time.time() + IAT_FUTURE_TOLERANCE_SECONDS:
            raise OidcError("iat_in_future")
        sub = payload.get("sub")
        if not isinstance(sub, str) or not sub:
            raise OidcError("id_token_invalid")
        if expected_sub is not None and sub != expected_sub:
            raise OidcError("subject_mismatch")
        return payload

    async def refresh(self, refresh_token: str) -> TokenSet:
        document = (await self._load()).document
        method = self._token_auth_method(document)
        body = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": self.config.oidc_client_id,
        }
        headers: dict[str, str] = {}
        if method == "client_secret_basic":
            headers["authorization"] = self._basic_auth_header()
        elif method == "client_secret_post":
            body["client_secret"] = self.config.oidc_client_secret
        status, payload = await self._post_form(document.token_endpoint, body, headers)
        if status != 200:
            raise OidcError(_optional_string(payload.get("error")) or "refresh_failed")
        return self._to_token_set(payload)

    async def user_info(self, access_token: str) -> LiveUserInfo:
        document = (await self._load()).document
        status, payload = await self._request_json(
            "GET",
            document.userinfo_endpoint,
            headers={"authorization": f"Bearer {access_token}"},
            error_code="userinfo_failed",
        )
        if status != 200 or payload is None:
            raise OidcError("userinfo_failed")
        sub = _optional_string(payload.get("sub"))
        if not sub:
            raise OidcError("userinfo_invalid")
        is_admin = payload.get("isAdmin")
        return LiveUserInfo(
            sub=sub,
            username=_optional_string(payload.get("preferred_username")) or _optional_string(payload.get("username")),
            name=_optional_string(payload.get("name")),
            role=_optional_string(payload.get("role")),
            is_admin=is_admin if isinstance(is_admin, bool) else None,
        )

    # ------------------------------------------------------------- discovery

    async def _load(self) -> _DiscoveryCache:
        if self._discovery is not None:
            return self._discovery
        async with self._lock:
            if self._discovery is not None:
                return self._discovery
            # A failed discovery is never cached: the provider may be briefly
            # unavailable, so the next request retries instead of refusing for
            # the lifetime of the process.
            self._discovery = await self._discover()
        return self._discovery

    async def _discover(self) -> _DiscoveryCache:
        issuer = _normalize_issuer(self.config.oidc_issuer)
        discovery_url = f"{issuer}/.well-known/openid-configuration"
        status, payload = await self._request_json("GET", discovery_url, error_code="discovery_failed")
        if status != 200 or payload is None:
            raise OidcError("discovery_failed")
        advertised = _normalize_issuer(_optional_string(payload.get("issuer")) or "")
        if advertised != issuer:
            raise OidcError("issuer_mismatch")
        algs = [a for a in payload.get("id_token_signing_alg_values_supported", []) if isinstance(a, str)] \
            if isinstance(payload.get("id_token_signing_alg_values_supported"), list) else []
        if algs and "RS256" not in algs:
            raise OidcError("rs256_unsupported")
        methods = [m for m in payload.get("code_challenge_methods_supported", []) if isinstance(m, str)] \
            if isinstance(payload.get("code_challenge_methods_supported"), list) else []
        if methods and "S256" not in methods:
            raise OidcError("s256_unsupported")
        auth_methods = [m for m in payload.get("token_endpoint_auth_methods_supported", []) if isinstance(m, str)] \
            if isinstance(payload.get("token_endpoint_auth_methods_supported"), list) else []
        document = DiscoveryDocument(
            issuer=issuer,
            authorization_endpoint=_resolve_endpoint(issuer, payload.get("authorization_endpoint")),
            token_endpoint=_resolve_endpoint(issuer, payload.get("token_endpoint")),
            userinfo_endpoint=_resolve_endpoint(issuer, payload.get("userinfo_endpoint")),
            jwks_uri=_resolve_endpoint(issuer, payload.get("jwks_uri")),
            id_token_signing_alg_values_supported=algs,
            code_challenge_methods_supported=methods,
            token_endpoint_auth_methods_supported=auth_methods,
        )
        return _DiscoveryCache(document=document, jwks={})

    # ------------------------------------------------------------------ JWKS

    async def _key_for(self, kid: Any):
        cache = self._discovery
        if cache is None:
            raise OidcError("discovery_failed")
        known = isinstance(kid, str)
        cached = cache.jwks.get(kid) if known else None
        # A cached key is only usable while the set is fresh, so an expired
        # entry forces a refetch and a revoked/rotated key stops verifying
        # within ``JWKS_CACHE_SECONDS``.
        if cached is not None and self._jwks_is_fresh(cache):
            return cached
        if self._jwks_may_refresh(cache):
            await self._fetch_jwks(cache)
            cached = cache.jwks.get(kid) if known else None
            if cached is None:
                raise OidcError("id_token_invalid")
            return cached
        # The set is stale (or the kid is unknown) and the provider may not be
        # contacted again yet. Refuse rather than trust a key that could have
        # been revoked since the last successful fetch.
        if cached is not None:
            raise OidcError("discovery_failed")
        raise OidcError("id_token_invalid")

    def _jwks_is_fresh(self, cache: _DiscoveryCache) -> bool:
        if not cache.jwks:
            return False
        return time.time() - self._jwks_fetched_at < JWKS_CACHE_SECONDS

    def _jwks_may_refresh(self, cache: _DiscoveryCache) -> bool:
        """Cooldown between refetches, so an unknown `kid` cannot hammer the provider."""
        if not cache.jwks:
            return True
        return time.time() - self._jwks_attempt_at >= JWKS_COOLDOWN_SECONDS

    async def _fetch_jwks(self, cache: _DiscoveryCache) -> None:
        # Record the attempt up-front so a failing endpoint is also throttled.
        self._jwks_attempt_at = time.time()
        status, payload = await self._request_json("GET", cache.document.jwks_uri, error_code="discovery_failed")
        if status != 200 or payload is None or not isinstance(payload.get("keys"), list):
            raise OidcError("discovery_failed")
        keys: dict[str, Any] = {}
        for item in payload["keys"]:
            if not isinstance(item, dict) or item.get("kty") != "RSA":
                continue
            if item.get("alg") not in (None, "RS256"):
                continue
            try:
                key = jwt.PyJWK(item).key
            except (jwt.PyJWTError, ValueError, TypeError):
                continue
            kid = item.get("kid")
            keys[kid if isinstance(kid, str) else ""] = key
        if not keys:
            raise OidcError("discovery_failed")
        cache.jwks = keys
        self._jwks_fetched_at = time.time()

    # --------------------------------------------------------------- helpers

    def _token_auth_method(self, document: DiscoveryDocument) -> str:
        advertised = document.token_endpoint_auth_methods_supported
        if not advertised:
            return "client_secret_basic"
        post = advertised.index("client_secret_post") if "client_secret_post" in advertised else -1
        basic = advertised.index("client_secret_basic") if "client_secret_basic" in advertised else -1
        if basic >= 0 and (post < 0 or basic < post):
            return "client_secret_basic"
        if post >= 0:
            return "client_secret_post"
        # The provider only offers a method we do not implement (e.g. private_key_jwt).
        raise OidcError("token_auth_unsupported")

    def _basic_auth_header(self) -> str:
        raw = f"{self.config.oidc_client_id}:{self.config.oidc_client_secret}".encode("utf-8")
        return "Basic " + base64.b64encode(raw).decode("ascii")

    def _to_token_set(self, payload: dict[str, Any], *, require_id_token: bool = False) -> TokenSet:
        access_token = _optional_string(payload.get("access_token"))
        if not access_token:
            raise OidcError("token_response_invalid")
        token_type = _optional_string(payload.get("token_type"))
        if not token_type or token_type.lower() != "bearer":
            raise OidcError("token_type_unsupported")
        id_token = _optional_string(payload.get("id_token"))
        if require_id_token and not id_token:
            raise OidcError("token_response_invalid")
        expires_in = payload.get("expires_in")
        if isinstance(expires_in, bool) or not isinstance(expires_in, (int, float)) \
                or not math.isfinite(expires_in) or expires_in < 0:
            raise OidcError("expires_in_invalid")
        return TokenSet(
            access_token=access_token,
            id_token=id_token,
            refresh_token=_optional_string(payload.get("refresh_token")),
            scope=_optional_string(payload.get("scope")) or self.config.scopes,
            expires_at=time.time() + math.floor(expires_in),
        )

    async def _post_form(self, endpoint: str, body: dict[str, str],
                         extra_headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
        headers = {"content-type": "application/x-www-form-urlencoded", **extra_headers}
        status, payload = await self._request_json("POST", endpoint, headers=headers, data=body,
                                                   error_code="token_timeout")
        return status, payload or {}

    async def _request_json(self, method: str, url: str, *, headers: dict[str, str] | None = None,
                            data: dict[str, str] | None = None,
                            error_code: str = "oidc_unavailable") -> tuple[int, dict[str, Any] | None]:
        """One bounded request; a 3xx is a failure because redirects are never followed.

        The response is consumed as a stream: ``MAX_JSON_BYTES`` limits what is
        actually read off the socket, so an oversized reply is aborted instead of
        being buffered whole first. The deadline covers connect, headers and body.
        """
        status = 0
        try:
            async with asyncio.timeout(self.config.timeout_seconds):
                async with self._http().stream(method, url, headers=headers, data=data) as response:
                    status = response.status_code
                    if 300 <= status < 400:
                        raise OidcError("oidc_redirect_denied")
                    raw = await _read_bounded(response)
        except OidcError:
            raise
        except (TimeoutError, asyncio.TimeoutError):
            raise OidcError(error_code) from None
        except Exception:
            raise OidcError(error_code) from None
        payload = _decode_json(raw)
        return status, payload


async def _read_bounded(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > MAX_JSON_BYTES:
            raise OidcError("response_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


def _decode_json(raw: bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def _resolve_endpoint(issuer: str, raw: Any) -> str:
    """Join a discovered endpoint to the issuer; it must share the issuer origin."""
    if not isinstance(raw, str) or not raw:
        raise OidcError("discovery_invalid")
    try:
        url = urlsplit(raw)
        issuer_url = urlsplit(issuer)
    except ValueError:
        raise OidcError("discovery_invalid") from None
    if url.username is not None or url.password is not None or url.fragment:
        raise OidcError("discovery_invalid")
    if url.scheme not in ("http", "https") or not url.hostname:
        raise OidcError("discovery_invalid")
    default_port = 443 if url.scheme == "https" else 80
    issuer_default = 443 if issuer_url.scheme == "https" else 80
    origin = (url.scheme, url.hostname.lower(), url.port or default_port)
    issuer_origin = (issuer_url.scheme, (issuer_url.hostname or "").lower(), issuer_url.port or issuer_default)
    if origin != issuer_origin:
        raise OidcError("discovery_invalid")
    return raw