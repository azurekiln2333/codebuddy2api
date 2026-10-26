"""Real-socket SSO fixture: a synthetic OIDC IdP plus the real native backend.

Nothing here is mocked. A minimal HTTP/1.1 identity provider listens on a real
TCP port, validates PKCE S256 and the confidential-client credential placement,
signs RS256 identity tokens and answers live UserInfo. The fixture then launches
the actual ``converter.py`` process with ``CODEBUDDY2API_SSO_ENABLED=true`` and
waits for ``/health``, so a test (or a browser) talks to the shipped application
over TCP exactly as a deployment would.

Standalone, for manual or Playwright runs::

    python tests/native_sso_fixture.py --backend-port 8765 --idp-port 8766

It prints a JSON manifest and stays up until killed, which is what
``web/playwright.native.config.ts`` uses as its ``webServer``.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

REPO_ROOT = Path(__file__).resolve().parents[1]

CLIENT_ID = "cb-native-client"
CLIENT_SECRET = "cb-native-secret"
ADMIN_SUB = "native-admin-1"
ID_TOKEN_TTL_SECONDS = 600
ACCESS_TOKEN_TTL_SECONDS = 3600

# Deterministic defaults so the Playwright config can address the fixture without
# reading its output. Both are overrideable from the command line.
DEFAULT_BACKEND_PORT = 8791
DEFAULT_IDP_PORT = 8792

# Names that must never leak from the developer/CI shell into the fixture: a real
# deployment's `.env` or exported variable would silently change what is tested.
_NEVER_INHERIT = {
    "PUBLIC_ORIGIN", "ALLOW_INSECURE_LOCALHOST", "OIDC_REFRESH",
    "SESSION_TTL_MS", "SESSION_IDLE_MS", "TRANSACTION_TTL_MS", "MAX_SESSIONS",
    "OAUTH_TIMEOUT_MS", "ADMIN_ORIGINS", "CODEBUDDY2API_ADMIN_ORIGINS",
}


def _isolated_environment() -> dict[str, str]:
    """Drop every inherited product/OIDC/SSO value before synthetic ones are set."""
    env: dict[str, str] = {}
    for key, value in os.environ.items():
        upper = key.upper()
        if upper.startswith("CODEBUDDY") or upper.startswith("OIDC_") or upper in _NEVER_INHERIT:
            continue
        env[key] = value
    return env


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _pkce_challenge(verifier: str) -> str:
    return _b64url(hashlib.sha256(verifier.encode("ascii")).digest())


@dataclass
class AuthorizeRequest:
    client_id: str
    redirect_uri: str
    state: str
    nonce: str
    scope: str
    code_challenge: str
    code_challenge_method: str


@dataclass
class TokenRequest:
    grant_type: str
    form: dict[str, str]
    authorization: str | None


@dataclass
class SyntheticIdp:
    """Minimal, strict OIDC provider over a real socket."""

    client_id: str = CLIENT_ID
    client_secret: str = CLIENT_SECRET
    sub: str = ADMIN_SUB
    role: str = "admin"
    is_admin: bool = True
    username: str = "native-ops"
    name: str = "Native Operator"
    token_auth_method: str = "client_secret_basic"  # or "client_secret_post"
    offline_access: bool = False

    port: int = 0
    issuer: str = ""
    authorize_requests: list[AuthorizeRequest] = field(default_factory=list)
    token_requests: list[TokenRequest] = field(default_factory=list)
    discovery_calls: int = 0
    jwks_calls: int = 0
    userinfo_calls: int = 0
    reject_userinfo: bool = False

    _codes: dict[str, AuthorizeRequest] = field(default_factory=dict, repr=False)
    _tokens: dict[str, str] = field(default_factory=dict, repr=False)
    _refresh_tokens: set[str] = field(default_factory=set, repr=False)
    _key: object = None
    _server: asyncio.AbstractServer | None = None
    _tasks: set[asyncio.Task] = field(default_factory=set, repr=False)

    # ------------------------------------------------------------- lifecycle

    async def start(self, port: int = 0) -> "SyntheticIdp":
        from cryptography.hazmat.primitives.asymmetric import rsa

        self._key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", port)
        bound = self._server.sockets[0].getsockname()[1]
        self.port = bound
        self.issuer = f"http://127.0.0.1:{bound}"
        return self

    async def stop(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._server is not None:
            self._server.close()
            try:
                await self._server.wait_closed()
            except Exception:
                pass

    # ---------------------------------------------------------------- signing

    def jwk(self) -> dict:
        import jwt
        from cryptography.hazmat.primitives import serialization

        public = self._key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        data = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(
            serialization.load_pem_public_key(public)))
        data.update({"kid": "native-key", "alg": "RS256", "use": "sig"})
        return data

    def id_token(self, nonce: str, *, sub: str | None = None) -> str:
        import jwt

        now = int(time.time())
        payload = {
            "iss": self.issuer,
            "aud": self.client_id,
            "azp": self.client_id,
            "sub": sub or self.sub,
            "iat": now,
            "exp": now + ID_TOKEN_TTL_SECONDS,
        }
        if nonce:
            payload["nonce"] = nonce
        return jwt.encode(payload, self._key, algorithm="RS256", headers={"kid": "native-key"})

    # ------------------------------------------------------------------- HTTP

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._tasks.add(task)
        try:
            await self._serve(reader, writer)
        finally:
            if task is not None:
                self._tasks.discard(task)

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            method, target, headers, body = await _read_request(reader)
        except Exception:
            _close(writer)
            return
        try:
            status, content_type, payload, extra = self._route(method, target, headers, body)
        except Exception:  # pragma: no cover - defensive
            status, content_type, payload, extra = 500, "application/json", b'{"error":"fixture_error"}', {}
        _respond(writer, status, content_type, payload, extra)

    def _route(self, method: str, target: str, headers: dict[str, str], body: bytes):
        parts = urlsplit(target)
        path = parts.path
        if path == "/.well-known/openid-configuration":
            self.discovery_calls += 1
            return 200, "application/json", _json_bytes({
                "issuer": self.issuer,
                "authorization_endpoint": f"{self.issuer}/authorize",
                "token_endpoint": f"{self.issuer}/token",
                "userinfo_endpoint": f"{self.issuer}/userinfo",
                "jwks_uri": f"{self.issuer}/jwks",
                "id_token_signing_alg_values_supported": ["RS256"],
                "code_challenge_methods_supported": ["S256"],
                "token_endpoint_auth_methods_supported": [self.token_auth_method],
            }), {}
        if path == "/jwks":
            self.jwks_calls += 1
            return 200, "application/json", _json_bytes({"keys": [self.jwk()]}), {}
        if path == "/authorize":
            return self._authorize(dict(parse_qsl(parts.query)))
        if path == "/token":
            return self._token(headers, body)
        if path == "/userinfo":
            return self._userinfo(headers)
        return 404, "application/json", b'{"error":"not_found"}', {}

    def _authorize(self, query: dict[str, str]):
        request = AuthorizeRequest(
            client_id=query.get("client_id", ""),
            redirect_uri=query.get("redirect_uri", ""),
            state=query.get("state", ""),
            nonce=query.get("nonce", ""),
            scope=query.get("scope", ""),
            code_challenge=query.get("code_challenge", ""),
            code_challenge_method=query.get("code_challenge_method", ""),
        )
        self.authorize_requests.append(request)
        if (query.get("response_type") != "code" or request.client_id != self.client_id
                or request.code_challenge_method != "S256" or not request.code_challenge
                or not request.redirect_uri or not request.state or not request.nonce):
            return 400, "application/json", b'{"error":"invalid_request"}', {}
        code = "code-" + secrets.token_urlsafe(16)
        self._codes[code] = request
        location = request.redirect_uri + "?" + urlencode({"code": code, "state": request.state})
        return 302, "text/plain", b"", {"location": location}

    def _token(self, headers: dict[str, str], body: bytes):
        form = {k: v for k, v in parse_qsl(body.decode("utf-8"))}
        authorization = headers.get("authorization")
        self.token_requests.append(TokenRequest(form.get("grant_type", ""), form, authorization))
        if not self._credentials_are_correct(form, authorization):
            return 401, "application/json", b'{"error":"invalid_client"}', {}
        if form.get("grant_type") == "refresh_token":
            return self._refresh(form)
        request = self._codes.pop(form.get("code", ""), None)
        if request is None:
            return 400, "application/json", b'{"error":"invalid_grant"}', {}
        verifier = form.get("code_verifier", "")
        if not verifier or _pkce_challenge(verifier) != request.code_challenge:
            return 400, "application/json", b'{"error":"invalid_grant"}', {}
        return self._token_response(request)

    def _credentials_are_correct(self, form: dict[str, str], authorization: str | None) -> bool:
        expected = "Basic " + _b64url_std(f"{self.client_id}:{self.client_secret}")
        if self.token_auth_method == "client_secret_basic":
            # Exactly one placement: the secret must not also appear in the form.
            return authorization == expected and "client_secret" not in form
        return authorization is None and form.get("client_secret") == self.client_secret

    def _token_response(self, request: AuthorizeRequest):
        access = "at-" + secrets.token_urlsafe(16)
        self._tokens[access] = self.sub
        body = {
            "access_token": access,
            "token_type": "Bearer",
            "scope": request.scope,
            "expires_in": ACCESS_TOKEN_TTL_SECONDS,
            "id_token": self.id_token(request.nonce),
        }
        if self.offline_access and "offline_access" in request.scope:
            refresh = "rt-" + secrets.token_urlsafe(16)
            self._refresh_tokens.add(refresh)
            body["refresh_token"] = refresh
        return 200, "application/json", _json_bytes(body), {}

    def _refresh(self, form: dict[str, str]):
        refresh = form.get("refresh_token", "")
        if refresh not in self._refresh_tokens:
            return 400, "application/json", b'{"error":"invalid_grant"}', {}
        access = "at-" + secrets.token_urlsafe(16)
        self._tokens[access] = self.sub
        return 200, "application/json", _json_bytes({
            "access_token": access,
            "token_type": "Bearer",
            "scope": "openid profile roles offline_access",
            "expires_in": ACCESS_TOKEN_TTL_SECONDS,
        }), {}

    def _userinfo(self, headers: dict[str, str]):
        self.userinfo_calls += 1
        if self.reject_userinfo:
            return 401, "application/json", b'{"error":"invalid_token"}', {}
        authorization = headers.get("authorization", "")
        token = authorization[7:] if authorization.lower().startswith("bearer ") else ""
        if token not in self._tokens:
            return 401, "application/json", b'{"error":"invalid_token"}', {}
        return 200, "application/json", _json_bytes({
            "sub": self.sub,
            "role": self.role,
            "isAdmin": self.is_admin,
            "preferred_username": self.username,
            "name": self.name,
        }), {}


def _b64url_std(raw: str) -> str:
    return base64.b64encode(raw.encode("utf-8")).decode("ascii")


def _json_bytes(value: object) -> bytes:
    return json.dumps(value).encode("utf-8")


def _close(writer: asyncio.StreamWriter) -> None:
    try:
        writer.close()
    except Exception:
        pass


def _respond(writer: asyncio.StreamWriter, status: int, content_type: str, body: bytes,
             extra: dict[str, str] | None = None) -> None:
    reason = {200: "OK", 302: "Found", 400: "Bad Request", 401: "Unauthorized",
              404: "Not Found", 500: "Internal Server Error"}.get(status, "OK")
    parts = [f"HTTP/1.1 {status} {reason}", f"content-type: {content_type}"]
    for key, value in (extra or {}).items():
        parts.append(f"{key}: {value}")
    parts.extend([f"content-length: {len(body)}", "cache-control: no-store",
                  "x-content-type-options: nosniff", "connection: close", "", ""])
    try:
        writer.write("\r\n".join(parts).encode("ascii") + body)
    except Exception:
        _close(writer)
        return
    _close(writer)


async def _read_request(reader: asyncio.StreamReader):
    try:
        block = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
    except Exception as error:
        raise ValueError("no request head") from error
    lines = block.decode("latin-1").split("\r\n")
    method, target, _ = (lines[0].split(" ") + ["", ""])[:3]
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    body = b""
    try:
        length = int(headers.get("content-length") or 0)
    except ValueError:
        length = 0
    if length:
        body = await asyncio.wait_for(reader.readexactly(length), timeout=10)
    return method, target, headers, body


@dataclass
class NativeBackend:
    """The real ``converter.py`` process, configured for native SSO."""

    issuer: str
    client_id: str = CLIENT_ID
    client_secret: str = CLIENT_SECRET
    port: int = 0
    repo_root: Path = REPO_ROOT
    python: str = sys.executable
    timeout: float = 120.0

    origin: str = ""
    process: subprocess.Popen | None = None
    log_path: Path | None = None
    _temp_dir: tempfile.TemporaryDirectory | None = None

    async def start(self) -> "NativeBackend":
        import httpx

        self._temp_dir = tempfile.TemporaryDirectory(prefix="native-sso-")
        work = Path(self._temp_dir.name)
        port = self.port or _free_port()
        self.port = port
        self.origin = f"http://127.0.0.1:{port}"
        self.log_path = work / "converter.log"
        # Start with an environment stripped of any real SSO/product configuration,
        # then add only the synthetic values the fixture needs.
        env = {
            **_isolated_environment(),
            "PYTHONUTF8": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "CODEBUDDY2API_KEY": "native-fixture-key",
            "CODEBUDDY_AUTH_DIR": str(work / "auth"),
            "CODEBUDDY2API_SSO_ENABLED": "true",
            "PUBLIC_ORIGIN": self.origin,
            "OIDC_ISSUER": self.issuer,
            "OIDC_CLIENT_ID": self.client_id,
            "OIDC_CLIENT_SECRET": self.client_secret,
            "ALLOW_INSECURE_LOCALHOST": "true",
        }
        (work / "auth").mkdir(parents=True, exist_ok=True)
        log = open(self.log_path, "wb")
        # Run from the temporary work directory so no repository `.env`, audit
        # database or auth file can be read or written by the fixture.
        self.process = subprocess.Popen(
            [self.python, "-B", str((self.repo_root / "converter.py").resolve()),
             "--skip-check", "--host", "127.0.0.1", "--port", str(port)],
            cwd=str(work), env=env, stdout=log, stderr=subprocess.STDOUT,
        )
        log.close()
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"backend exited early: {self.log_tail()}")
            try:
                response = httpx.get(self.origin + "/health", timeout=2)
                if response.status_code == 200:
                    return self
            except Exception:
                pass
            await asyncio.sleep(0.25)
        self.stop()
        raise RuntimeError(f"backend did not become healthy: {self.log_tail()}")

    def log_tail(self, limit: int = 4000) -> str:
        if self.log_path is None or not self.log_path.is_file():
            return ""
        data = self.log_path.read_bytes()[-limit:]
        return data.decode("utf-8", "replace")

    def stop(self) -> None:
        process, self.process = self.process, None
        if process is not None and process.poll() is None:
            if sys.platform.startswith("win"):
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)],
                               capture_output=True, check=False)
            else:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
        if self._temp_dir is not None:
            try:
                self._temp_dir.cleanup()
            except (PermissionError, OSError):
                pass
            self._temp_dir = None


def _free_port() -> int:
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@dataclass
class NativeSsoFixture:
    """A synthetic IdP and the real backend started together."""

    idp: SyntheticIdp = field(default_factory=SyntheticIdp)
    backend: NativeBackend | None = None
    backend_port: int = 0
    idp_port: int = 0

    async def __aenter__(self) -> "NativeSsoFixture":
        await self.idp.start(self.idp_port)
        self.backend = NativeBackend(issuer=self.idp.issuer, port=self.backend_port,
                                     client_id=self.idp.client_id, client_secret=self.idp.client_secret)
        await self.backend.start()
        return self

    async def __aexit__(self, *exc_info) -> None:
        if self.backend is not None:
            self.backend.stop()
        await self.idp.stop()

    @property
    def origin(self) -> str:
        assert self.backend is not None
        return self.backend.origin


async def _amain(args) -> None:
    idp = SyntheticIdp()
    await idp.start(args.idp_port)
    backend = NativeBackend(issuer=idp.issuer, port=args.backend_port)
    try:
        await backend.start()
    except Exception as error:
        await idp.stop()
        print(f"fixture failed to start: {error}", file=sys.stderr)
        raise SystemExit(1)
    manifest = {
        "backend": backend.origin,
        "issuer": idp.issuer,
        "client_id": idp.client_id,
        "dashboard": backend.origin + "/dashboard/",
    }
    print(json.dumps(manifest), flush=True)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, ValueError):  # pragma: no cover - Windows
            pass
    try:
        await stop.wait()
    except asyncio.CancelledError:
        pass
    finally:
        backend.stop()
        await idp.stop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Native SSO fixture (synthetic IdP + real backend)")
    parser.add_argument("--backend-port", type=int, default=DEFAULT_BACKEND_PORT)
    parser.add_argument("--idp-port", type=int, default=DEFAULT_IDP_PORT)
    args = parser.parse_args(argv)
    try:
        asyncio.run(_amain(args))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())