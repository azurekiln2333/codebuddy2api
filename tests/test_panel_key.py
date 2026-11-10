"""The panel key: console key login and the management bearer (design D1/D2).

One value, ``PANEL_ADMIN_KEY``, has two independent uses and the tests below pin
both of them, plus the rule that disabling the browser login must not revoke the
service-to-service path.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import unittest
from unittest.mock import AsyncMock, Mock

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette.responses import JSONResponse

from app import auth_settings, panel_key
from app.admin_auth import AdminMiddleware
from app.panel_auth import install_panel_key
from app.sso_auth import SSOAdminMiddleware, SSOAuthError

KEY = "panel-admin-key-0123456789"
ORIGIN = {"Origin": "http://localhost"}
COOKIE = panel_key.COOKIE_NAME


def build_application(*, key=KEY, settings=None, token=""):
    """A legacy-bounded app with the panel-key layer in front, as installed live."""
    application = FastAPI()

    @application.post("/admin/thing")
    async def thing(request: Request):
        return JSONResponse({"identity": getattr(request.state, "admin_identity", None),
                             "cookie": getattr(request.state, "admin_cookie", None)})

    @application.get("/admin/thing")
    async def read_thing():
        return {"ok": True}

    auth = Mock()
    auth.enabled.return_value = False
    config = {"auth_settings": settings or auth_settings.SettingsStore()}
    install_panel_key(application, {**config, "panel_key": key})
    return application, config


def build_legacy_application(*, key=KEY, token=""):
    """The same app, but the inner boundary is the real legacy one."""
    application = FastAPI()

    @application.get("/admin/thing")
    async def read_thing():
        return {"ok": True}

    auth = Mock()
    auth.enabled.return_value = False
    config = {"auth_settings": auth_settings.SettingsStore()}
    application.add_middleware(AdminMiddleware, auth=auth, dispatch=None, token=token,
                               config=config)
    install_panel_key(application, {**config, "panel_key": key})
    return application, config


def build_bounded_application(*, key=KEY, sso_enabled=False):
    """A live-shaped app: panel key outside, the real password boundary inside.

    The inner boundary is fully working (not the 503 fallback), it simply has no
    knowledge of panel-key sessions. Its account is enabled and carries no
    session of its own, which is exactly the deployment shape: one console, key
    login in front, the legacy password surface unchanged underneath.
    """
    application = FastAPI()

    @application.get("/admin/thing")
    async def read_thing():
        return {"ok": True}

    auth = Mock()
    auth.enabled.return_value = True
    auth.account_mode.return_value = True
    auth.header_identity.return_value = ""
    auth.session.return_value = (None, None)
    auth.csrf_enabled.return_value = True
    auth.allowed_origins.return_value = ()
    store = auth_settings.SettingsStore()
    config = {"auth_settings": store}
    if sso_enabled:
        store.update({"enabled": True, "issuer": "https://idp.example.com",
                      "clientId": "c", "clientSecret": "s", "allowedSubjects": ["a"]})
    application.add_middleware(AdminMiddleware, auth=auth, dispatch=None, token="",
                               config=config)
    install_panel_key(application, {**config, "panel_key": key})
    return application, config


def build_sso_bounded_application(*, key=KEY):
    """SSO boundary inside, panel key outside, console SSO switched on."""
    application = FastAPI()

    @application.get("/admin/thing")
    async def read_thing():
        return {"ok": True}

    store = auth_settings.SettingsStore()
    store.update({"enabled": True, "issuer": "https://idp.example.com",
                  "clientId": "cid", "clientSecret": "sec",
                  "allowedSubjects": ["ops"]})
    sso = Mock()

    async def refuse(request):
        # Mimics the real service, which raises rather than returning a response.
        raise SSOAuthError(401, "unauthenticated")

    sso.authorize = AsyncMock(side_effect=refuse)
    config = {"auth_settings": store, "sso": sso}
    install_panel_key(application, {**config, "panel_key": key})
    return application, config, sso


class SsoEnabledTests(unittest.TestCase):
    """With console SSO on, both key paths must still work (design D2.2/D2.7)."""

    def setUp(self):
        self.app, _, self.sso = build_sso_bounded_application()
        self.client = self.enterContext(TestClient(self.app, base_url="http://localhost"))

    def test_key_login_is_not_rejected_in_sso_mode(self):
        response = self.client.post("/admin/session", headers=ORIGIN, json={"key": KEY})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["csrf_token"])

    def test_a_key_session_reaches_the_route_in_sso_mode(self):
        self.client.post("/admin/session", headers=ORIGIN, json={"key": KEY})
        read = self.client.get("/admin/thing")
        self.assertEqual(read.status_code, 200, read.text)

    def test_the_bearer_still_works_in_sso_mode(self):
        read = self.client.get("/admin/thing", headers={"Authorization": f"Bearer {KEY}"})
        self.assertEqual(read.status_code, 200, read.text)


class SsoBoundaryDefersTests(unittest.TestCase):
    """The SSO boundary must stand down once the panel key authorized a request.

    Driving the middleware directly keeps the assertion unambiguous: the real
    stack places it inside the panel-key layer, which a TestClient with
    add_middleware does not reproduce faithfully.
    """

    def build(self, *, marked, path="/admin/session"):
        seen = []

        async def endpoint(scope, receive, send):
            seen.append("endpoint")
            await JSONResponse({"ok": True})(scope, receive, send)

        sso = Mock()

        async def authorize(request):
            seen.append("sso")
            raise SSOAuthError(401, "unauthenticated")

        sso.authorize = authorize
        middleware = SSOAdminMiddleware(endpoint, sso=sso, dispatch=None, token="",
                                        config={"auth_settings": auth_settings.SettingsStore()})
        state = {panel_key.AUTHORIZED: True} if marked else {}
        return middleware, {
            "type": "http", "method": "POST", "path": path,
            "headers": [(b"origin", b"http://localhost")],
            "state": state,
        }, seen

    def test_an_authorized_request_never_reaches_the_sso_boundary(self):
        middleware, scope, seen = self.build(marked=True)

        async def receive():
            return {"type": "http.request", "body": b"{}"}

        sent = []

        async def send(message):
            sent.append(message)

        asyncio.run(middleware(scope, receive, send))
        self.assertEqual(seen, ["endpoint"], "the SSO boundary intercepted the key login")

    def test_an_unauthenticated_request_is_still_refused_by_sso(self):
        middleware, scope, seen = self.build(marked=False, path="/admin/keys")

        async def receive():
            return {"type": "http.request", "body": b"{}"}

        sent = []

        async def send(message):
            sent.append(message)

        asyncio.run(middleware(scope, receive, send))
        self.assertIn("sso", seen)
        self.assertEqual(sent[0]["status"], 401)


class InnerBoundaryTests(unittest.TestCase):
    """The panel key must satisfy the inner boundary, not just the outer one."""

    def setUp(self):
        self.app, self.config = build_bounded_application()
        self.client = self.enterContext(TestClient(self.app, base_url="http://localhost"))

    def test_a_key_session_reaches_the_route_through_the_real_boundary(self):
        response = self.client.post("/admin/session", headers=ORIGIN, json={"key": KEY})
        self.assertEqual(response.status_code, 200, response.text)
        # The inner boundary knows nothing about this session; before the marker
        # it answered 401 here even though the outer layer had authorized it.
        read = self.client.get("/admin/thing")
        self.assertEqual(read.status_code, 200, read.text)
        self.assertEqual(read.json(), {"ok": True})

    def test_the_bearer_reaches_the_route_through_the_real_boundary(self):
        read = self.client.get("/admin/thing", headers={"Authorization": f"Bearer {KEY}"})
        self.assertEqual(read.status_code, 200, read.text)

    def test_an_unauthenticated_request_is_still_refused(self):
        self.assertEqual(self.client.get("/admin/thing").status_code, 401)

    def test_a_stale_session_cookie_is_refused(self):
        self.client.cookies.set(COOKIE, "not-a-real-session")
        self.assertEqual(self.client.get("/admin/thing").status_code, 401)

    def test_a_forged_header_cannot_claim_authorization(self):
        # The marker lives in the ASGI scope; an HTTP header must not stand in for it.
        response = self.client.get("/admin/thing", headers={
            "X-Panel-Key-Authorized": "1",
            "Authorization": "Bearer " + "z" * 24})
        self.assertEqual(response.status_code, 401)

    def test_the_route_is_never_cacheable(self):
        self.client.post("/admin/session", headers=ORIGIN, json={"key": KEY})
        read = self.client.get("/admin/thing")
        self.assertEqual(read.headers.get("cache-control"), "no-store")

    def test_a_key_session_outlives_the_inner_password_boundary_being_sso_gated(self):
        app, _ = build_bounded_application(sso_enabled=True)
        with TestClient(app, base_url="http://localhost") as client:
            login = client.post("/admin/session", headers=ORIGIN, json={"key": KEY})
            self.assertEqual(login.status_code, 200, login.text)
            read = client.get("/admin/thing")
            self.assertEqual(read.status_code, 200, read.text)


class KeyResolutionTests(unittest.TestCase):
    def test_the_new_name_wins_and_legacy_names_still_work(self):
        self.assertEqual(panel_key.key_from_env({"PANEL_ADMIN_KEY": KEY}), (KEY, "PANEL_ADMIN_KEY"))
        self.assertEqual(panel_key.key_from_env({"PANEL_KEY": KEY}), (KEY, "PANEL_KEY"))
        self.assertEqual(panel_key.key_from_env({"PLATFORM_TOKEN": KEY}), (KEY, "PLATFORM_TOKEN"))
        self.assertEqual(
            panel_key.key_from_env({"PANEL_ADMIN_KEY": KEY, "PLATFORM_TOKEN": "x" * 12})[1],
            "PANEL_ADMIN_KEY")

    def test_a_short_or_control_character_key_is_treated_as_unset(self):
        for value in ("", "   ", "short", KEY[:-1] + "\x01"):
            with self.subTest(value=value):
                self.assertEqual(panel_key.key_from_env({"PANEL_ADMIN_KEY": value}), ("", ""))
        self.assertEqual(panel_key.key_from_env({}), ("", ""))

    def test_comparison_is_exact(self):
        self.assertTrue(panel_key.matches(KEY, KEY))
        for candidate in ("", KEY + "x", KEY[:-1], None, 123, KEY.upper()):
            with self.subTest(candidate=candidate):
                self.assertFalse(panel_key.matches(candidate, KEY))
        self.assertFalse(panel_key.matches(KEY, ""))


class PublicConfigTests(unittest.TestCase):
    def test_key_login_is_offered_only_when_it_can_succeed(self):
        config = panel_key.public_config({"keyLoginEnabled": True, "enabled": False},
                                         key_configured=False)
        self.assertFalse(config["keyLoginEnabled"])
        self.assertEqual(config["sso"], {"enabled": False, "providerName": "SSO", "loginUrl": ""})

    def test_sso_reports_its_login_url_and_provider_name(self):
        config = panel_key.public_config(
            {"keyLoginEnabled": True, "enabled": True, "providerName": "公司 SSO"},
            key_configured=True)
        self.assertTrue(config["keyLoginEnabled"])
        self.assertEqual(config["sso"], {"enabled": True, "providerName": "公司 SSO",
                                        "loginUrl": "/sso/login"})
        default = panel_key.public_config({"enabled": True}, key_configured=True)
        self.assertEqual(default["sso"]["providerName"], "SSO")


class KeyLoginTests(unittest.TestCase):
    def setUp(self):
        self.app, self.config = build_application()
        self.client = self.enterContext(TestClient(self.app, base_url="http://localhost"))

    def test_the_key_establishes_a_browser_session(self):
        response = self.client.post("/admin/session", headers=ORIGIN, json={"key": KEY})
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["authenticated"])
        self.assertEqual(payload["user"], {"sub": "panel:key", "name": "面板密钥", "provider": "key"})
        self.assertTrue(payload["csrf_token"])
        self.assertIn(COOKIE, self.client.cookies)

    def test_the_session_authorises_reads_and_mutations_with_csrf(self):
        csrf = self.client.post("/admin/session", headers=ORIGIN, json={"key": KEY}).json()["csrf_token"]
        self.assertEqual(self.client.get("/admin/thing").status_code, 200)
        denied = self.client.post("/admin/thing", headers=ORIGIN)
        self.assertEqual(denied.status_code, 403)
        allowed = self.client.post("/admin/thing", headers={**ORIGIN, "X-CSRF-Token": csrf})
        self.assertEqual(allowed.status_code, 200, allowed.text)
        self.assertEqual(allowed.json(), {"identity": "panel:key", "cookie": True})

    def test_a_wrong_key_is_rejected_and_throttled(self):
        for _ in range(panel_key.MAX_LOGIN_FAILURES):
            response = self.client.post("/admin/session", headers=ORIGIN, json={"key": "wrong-key-012345"})
            self.assertEqual(response.status_code, 401)
        blocked = self.client.post("/admin/session", headers=ORIGIN, json={"key": KEY})
        self.assertEqual(blocked.status_code, 429)
        self.assertNotIn(COOKIE, self.client.cookies)

    def test_a_foreign_origin_cannot_post_the_key(self):
        response = self.client.post("/admin/session", headers={"Origin": "https://evil.invalid"},
                                    json={"key": KEY})
        self.assertEqual(response.status_code, 403)
        self.assertNotIn(COOKIE, self.client.cookies)

    def test_logout_revokes_the_session(self):
        csrf = self.client.post("/admin/session", headers=ORIGIN, json={"key": KEY}).json()["csrf_token"]
        sid = self.client.cookies.get(COOKIE)
        self.assertEqual(self.client.delete("/admin/session").status_code, 403)
        response = self.client.delete("/admin/session", headers={**ORIGIN, "X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(COOKIE, self.client.cookies)
        # The old cookie value is dead server-side, not merely dropped by the
        # client: a request that carries it is no longer authorized.
        app, _ = build_legacy_application()
        with TestClient(app, base_url="http://localhost") as other:
            other.cookies.set(COOKIE, sid)
            self.assertEqual(other.get("/admin/thing").status_code, 503)

    def test_status_reports_the_key_session(self):
        csrf = self.client.post("/admin/session", headers=ORIGIN, json={"key": KEY}).json()["csrf_token"]
        response = self.client.get("/admin/session")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["csrf_token"], csrf)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_key_login_is_refused_when_the_operator_disabled_it(self):
        store = auth_settings.SettingsStore(auth_settings.with_defaults({"keyLoginEnabled": False}))
        app, _ = build_application(settings=store)
        with TestClient(app, base_url="http://localhost") as client:
            response = client.post("/admin/session", headers=ORIGIN, json={"key": KEY})
            self.assertEqual(response.status_code, 403)
            self.assertNotIn(COOKIE, client.cookies)

    def test_a_legacy_username_password_body_is_left_to_the_inner_boundary(self):
        # The key layer must not swallow the legacy login: a body without `key`
        # passes through untouched, body included, to the installed boundary.
        app, _ = build_legacy_application()
        with TestClient(app, base_url="http://localhost") as client:
            response = client.post("/admin/session", headers=ORIGIN,
                                   json={"username": "admin", "password": "x"})
        self.assertEqual(response.status_code, 503)  # the mocked legacy auth is disabled
        self.assertEqual(response.json()["error"]["message"], "管理账户未初始化")


class ManagementBearerTests(unittest.TestCase):
    def setUp(self):
        self.app, self.config = build_application()
        self.client = self.enterContext(TestClient(self.app, base_url="http://localhost"))

    def test_the_bearer_authorises_management_without_cookie_or_csrf(self):
        headers = {"Authorization": f"Bearer {KEY}"}
        response = self.client.post("/admin/thing", headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"identity": "panel:key", "cookie": False})
        self.assertNotIn(COOKIE, self.client.cookies)

    def test_the_bearer_reports_a_machine_session(self):
        headers = {"Authorization": f"Bearer {KEY}"}
        response = self.client.get("/admin/session", headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["csrf_token"])
        self.assertTrue(response.json()["authenticated"])

    def test_a_machine_credential_cannot_start_a_browser_login(self):
        headers = {"Authorization": f"Bearer {KEY}"}
        response = self.client.post("/admin/session", headers=headers, json={"key": KEY})
        self.assertEqual(response.status_code, 405)

    def test_a_wrong_bearer_falls_through_to_the_inner_boundary(self):
        app, _ = build_legacy_application()
        with TestClient(app, base_url="http://localhost") as client:
            for value in ("wrong", "", KEY[:-1]):
                with self.subTest(value=value):
                    response = client.get("/admin/thing",
                                          headers={"Authorization": f"Bearer {value}"})
                    self.assertNotEqual(response.status_code, 200)

    def test_the_bearer_survives_key_login_being_disabled(self):
        # Design D2.7: the machine path is the service-to-service credential and
        # must not be revoked by a browser-side policy change.
        store = auth_settings.SettingsStore(auth_settings.with_defaults({"keyLoginEnabled": False}))
        app, _ = build_application(settings=store)
        with TestClient(app, base_url="http://localhost") as client:
            self.assertEqual(client.post("/admin/session", headers=ORIGIN,
                                         json={"key": KEY}).status_code, 403)
            response = client.post("/admin/thing", headers={"Authorization": f"Bearer {KEY}"})
            self.assertEqual(response.status_code, 200, response.text)

    def test_the_key_never_appears_in_a_response(self):
        response = self.client.get("/admin/session", headers={"Authorization": f"Bearer {KEY}"})
        self.assertNotIn(KEY, response.text)


class SettingsIntegrationTests(unittest.TestCase):
    def test_disabling_key_login_needs_an_enabled_sso(self):
        store = auth_settings.SettingsStore()
        with self.assertRaises(auth_settings.AuthSettingsError):
            store.update({"keyLoginEnabled": False})

    def test_saving_settings_publishes_them_immediately(self):
        store = auth_settings.SettingsStore()
        store.update({"providerName": "企业 SSO"})
        self.assertEqual(store.current()["providerName"], "企业 SSO")


if __name__ == "__main__":
    unittest.main()
