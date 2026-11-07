"""End-to-end native SSO against real sockets: synthetic IdP + real backend.

This is not an ASGI-level test. A synthetic OIDC provider listens on a TCP port,
the actual ``converter.py`` process listens on another, and the assertions drive
the documented browser contract with a normal HTTP client, the way a deployment
is exercised. It covers the full lifecycle the PRD cares about: click-login
redirect, callback, a real admin read, a CSRF mutation, logout and post-logout
denial.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import os
import unittest
from unittest import mock

import httpx

from app.admin_api import CLEAR_CONFIRMATION
from tests.native_sso_fixture import NativeSsoFixture, _isolated_environment

BUILD_DOCUMENTS = ("LICENSE.upstream.txt", "THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_LICENSES.txt")


class NativeSsoIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = NativeSsoFixture()
        await self.fixture.__aenter__()
        self.addAsyncCleanup(self.fixture.__aexit__, None, None, None)
        self.origin = self.fixture.origin
        self.idp = self.fixture.idp
        self.client = httpx.AsyncClient(base_url=self.origin, follow_redirects=False, timeout=20)
        self.addAsyncCleanup(self.client.aclose)

    async def login(self):
        """Follow the real redirect chain exactly as a browser would."""
        start = await self.client.get("/sso/login?return_to=/dashboard/")
        self.assertEqual(start.status_code, 302, start.text)
        authorize = await self.client.get(start.headers["location"])
        self.assertEqual(authorize.status_code, 302, authorize.text)
        callback = await self.client.get(authorize.headers["location"])
        self.assertEqual(callback.status_code, 302, callback.text)
        self.assertTrue(callback.headers["location"].startswith("/dashboard"), callback.headers["location"])
        session = await self.client.get("/sso/session")
        self.assertEqual(session.status_code, 200, session.text)
        return session.json()

    def origin_headers(self, csrf=None):
        headers = {"Origin": self.origin}
        if csrf is not None:
            headers["X-CSRF-Token"] = csrf
        return headers

    # ---------------------------------------------------------------- health

    async def test_health_and_anonymous_state(self):
        self.assertEqual((await self.client.get("/health")).status_code, 200)
        self.assertEqual((await self.client.get("/admin/session")).status_code, 401)
        self.assertEqual((await self.client.get("/admin/models")).status_code, 401)
        anonymous = await self.client.get("/sso/session")
        self.assertEqual(anonymous.status_code, 401)
        self.assertEqual(anonymous.json(), {"authenticated": False, "csrf_token": None, "user": None})

    # ----------------------------------------------------------------- login

    async def test_the_provider_sees_pkce_and_one_credential_placement(self):
        await self.login()
        self.assertGreaterEqual(len(self.idp.authorize_requests), 1)
        request = self.idp.authorize_requests[0]
        self.assertEqual(request.code_challenge_method, "S256")
        self.assertTrue(request.code_challenge)
        self.assertTrue(request.nonce)
        self.assertNotIn("prompt", request.scope)
        self.assertIn("openid", request.scope)
        self.assertIn("roles", request.scope)
        token = self.idp.token_requests[0]
        self.assertEqual(token.grant_type, "authorization_code")
        self.assertTrue((token.authorization or "").startswith("Basic "))
        self.assertNotIn("client_secret", token.form)
        self.assertGreaterEqual(self.idp.userinfo_calls, 1)

    async def test_login_then_read_poll_mutate_and_logout(self):
        session = await self.login()
        self.assertTrue(session["authenticated"])
        self.assertEqual(session["user"]["role"], "admin")
        self.assertEqual(session["user"]["sub"], self.idp.sub)
        self.assertTrue(session["csrf_token"])
        csrf = session["csrf_token"]

        # The management session endpoint agrees with the SSO session.
        management = await self.client.get("/admin/session")
        self.assertEqual(management.status_code, 200)
        self.assertEqual(management.json(), {"authenticated": True, "csrf_token": csrf})

        # A real admin read backed by the real audit store.
        dashboard = await self.client.get("/admin/dashboard?days=1")
        self.assertEqual(dashboard.status_code, 200)
        self.assertIn("summary", dashboard.json())

        # The API-key login is gone in SSO mode.
        self.assertEqual((await self.client.post("/admin/session", headers=self.origin_headers(),
                                                 json={"api_key": "native-fixture-key"})).status_code, 405)
        self.assertEqual((await self.client.post("/admin/session",
                                                 headers={**self.origin_headers(), "Authorization": "Bearer native-fixture-key"}
                                                 )).status_code, 405)

        # CSRF-gated mutation performed through the documented contract.
        settings = await self.client.get("/admin/settings")
        revision = settings.json()["revision"]
        denied = await self.client.patch("/admin/settings", headers=self.origin_headers(),
                                         json={"revision": revision, "values": {"max_images": 16}})
        self.assertEqual(denied.status_code, 403)
        denied_origin = await self.client.patch(
            "/admin/settings", headers={"Origin": "http://127.0.0.1:1", "X-CSRF-Token": csrf},
            json={"revision": revision, "values": {"max_images": 16}})
        self.assertEqual(denied_origin.status_code, 403)
        applied = await self.client.patch(
            "/admin/settings", headers=self.origin_headers(csrf),
            json={"revision": revision, "values": {"max_images": 16}})
        self.assertEqual(applied.status_code, 200, applied.text)
        items = {item["key"]: item for item in (await self.client.get("/admin/settings")).json()["items"]}
        self.assertEqual(items["max_images"]["value"], 16)

        # The OAuth poll is a CSRF-gated GET: browsers send a same-origin Referer.
        poll_denied = await self.client.get("/admin/oauth/poll?login_id=x", headers=self.origin_headers())
        self.assertEqual(poll_denied.status_code, 403)
        poll_allowed = await self.client.get("/admin/oauth/poll?login_id=x", headers={
            "Referer": self.origin + "/dashboard/credentials", "X-CSRF-Token": csrf})
        self.assertEqual(poll_allowed.status_code, 404)  # CSRF passed, task unknown

        # The full log clear is trusted only from the live SSO identity.
        bad = await self.client.post("/admin/logs/clear", headers=self.origin_headers(csrf),
                                     json={"scope": "all", "confirmation": "wrong"})
        self.assertEqual(bad.status_code, 403)
        cleared = await self.client.post("/admin/logs/clear", headers=self.origin_headers(csrf),
                                         json={"scope": "all", "confirmation": CLEAR_CONFIRMATION})
        self.assertEqual(cleared.status_code, 200)

        # Encoded route aliases stay rejected.
        self.assertEqual((await self.client.get("/admin/%73ession")).status_code, 400)

        # Inference keeps using caller credentials only.
        self.assertEqual((await self.client.get("/v1/models")).status_code, 401)
        self.assertEqual((await self.client.get("/v1/models",
                                                headers={"Authorization": "Bearer native-fixture-key"})).status_code, 200)

        # Logout, then the revocation is immediate.
        logout = await self.client.delete("/admin/session", headers=self.origin_headers(csrf))
        self.assertEqual(logout.status_code, 200)
        self.assertEqual(logout.json(), {"authenticated": False})
        self.assertEqual((await self.client.get("/sso/session")).status_code, 401)
        self.assertEqual((await self.client.get("/admin/session")).status_code, 401)

    async def test_static_routes_match_the_web_build_state(self):
        # The backend gate runs before the WebUI build in a clean checkout. Its
        # real-socket contract includes the explicit unbuilt response; the native
        # browser gate later requires the actual shell and all three documents.
        build_root = self.fixture.backend.repo_root / "web" / "dist"
        built = (build_root / "index.html").is_file()
        for page in ("/dashboard/", "/dashboard/storage", "/dashboard/settings"):
            with self.subTest(page=page):
                response = await self.client.get(page)
                self.assertEqual(response.status_code, 200 if built else 503, page)
                self.assertEqual(response.headers["cache-control"], "no-store")
                if built:
                    self.assertEqual(response.text, (build_root / "index.html").read_text(encoding="utf-8"))
                else:
                    self.assertIn("WebUI 尚未构建", response.json()["detail"])
        for name in BUILD_DOCUMENTS:
            with self.subTest(document=name):
                response = await self.client.get(f"/dashboard/{name}")
                self.assertEqual(response.status_code, 200 if built else 404, name)
                if built:
                    self.assertGreater(len(response.content), 0)
                    self.assertIn("text/plain", response.headers["content-type"])
        self.assertEqual((await self.client.get("/sso/missing")).status_code, 404)
        self.assertEqual((await self.client.get("/dashboard/nope")).status_code, 302)


class EnvironmentIsolationTests(unittest.IsolatedAsyncioTestCase):
    """A real deployment's environment must never leak into the fixture."""

    HOSTILE = {
        "CODEBUDDY2API_SSO_ENABLED": "false",
        "CODEBUDDY2API_KEY": "real-management-key",
        "CODEBUDDY2API_ADMIN_ORIGINS": "https://console.production.invalid",
        "CODEBUDDY_AUTH_DIR": "/real/auth",
        "PUBLIC_ORIGIN": "https://console.production.invalid",
        "OIDC_ISSUER": "https://idp.production.invalid",
        "OIDC_CLIENT_ID": "real-client",
        "OIDC_CLIENT_SECRET": "real-secret",
        "OIDC_REFRESH": "true",
        "ALLOW_INSECURE_LOCALHOST": "false",
        "SESSION_TTL_MS": "60000",
        "SESSION_IDLE_MS": "60000",
    }

    def test_the_isolated_environment_drops_every_product_and_oidc_value(self):
        with mock.patch.dict(os.environ, self.HOSTILE):
            env = _isolated_environment()
        for name in self.HOSTILE:
            self.assertNotIn(name, env)
        # Unrelated variables still pass through, otherwise the toolchain breaks.
        self.assertIn("PATH", env)

    async def test_a_polluted_shell_cannot_hijack_the_fixture(self):
        with mock.patch.dict(os.environ, self.HOSTILE):
            fixture = NativeSsoFixture()
            await fixture.__aenter__()
            self.addAsyncCleanup(fixture.__aexit__, None, None, None)
            self.assertTrue(fixture.origin.startswith("http://127.0.0.1:"))
            self.assertTrue(fixture.idp.issuer.startswith("http://127.0.0.1:"))
            async with httpx.AsyncClient(base_url=fixture.origin, follow_redirects=False,
                                         timeout=20) as client:
                self.assertEqual((await client.get("/health")).status_code, 200)
                # SSO is on (not the inherited "false") and pointed at the synthetic IdP.
                start = await client.get("/sso/login?return_to=/dashboard/")
                self.assertEqual(start.status_code, 302)
                self.assertTrue(start.headers["location"].startswith(fixture.idp.issuer))
                authorize = await client.get(start.headers["location"])
                callback = await client.get(authorize.headers["location"])
                self.assertEqual(callback.status_code, 302)
                session = await client.get("/sso/session")
                self.assertEqual(session.status_code, 200)
                self.assertEqual(session.json()["user"]["sub"], fixture.idp.sub)


if __name__ == "__main__":
    unittest.main()
