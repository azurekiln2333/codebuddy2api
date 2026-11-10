"""SSO-aware ``/admin`` boundary: no key fallback, CSRF, log clear, inference intact."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import unittest
import tempfile
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette.responses import JSONResponse

from app import admin_account, auth_settings, runtime_management
from app.admin_api import CLEAR_CONFIRMATION
from app.control_store import ControlStore
from app.inference_auth import InferenceAuthMiddleware, require_api_key
from app.media_store import MediaStore
from app.sso_auth import SESSION_COOKIE
from app.sso_config import load as load_sso_config
from tests.sso_fixture import FakeIdp, _Gateway, build_sso_app

ORIGIN = {"Origin": "http://localhost"}
LEGACY_KEY = "synthetic-management-key"


def probe_routes(app):
    @app.post("/admin/probe")
    async def probe(request: Request):
        return JSONResponse({
            "identity": getattr(request.state, "admin_identity", None),
            "cookie_scoped": getattr(request.state, "admin_cookie", False),
            "has_authorization": bool(request.headers.get("authorization")),
            "csrf_header": request.headers.get("x-csrf-token"),
        })

    @app.get("/v1/models")
    async def models(request: Request):
        require_api_key(LEGACY_KEY, request.headers.get("authorization"), request.headers.get("x-api-key"))
        return {"object": "list", "data": []}


class SSOAdminBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.idp = FakeIdp()
        self.app, self.service, self.config = build_sso_app(self.idp, extra_routes=probe_routes)
        self.client = self.enterContext(TestClient(self.app, base_url="http://localhost"))

    # --------------------------------------------------------------- helpers

    def login(self):
        response = self.client.get("/sso/login?return_to=/dashboard/", follow_redirects=False)
        params = {k: v[0] for k, v in parse_qs(urlsplit(response.headers["location"]).query).items()}
        code = self.idp.issue_code(params["nonce"])
        response = self.client.get(f"/sso/callback?code={code}&state={params['state']}",
                                   follow_redirects=False)
        self.assertEqual(response.status_code, 302, response.text)
        return self.client.get("/sso/session").json()["csrf_token"]

    # ------------------------------------------------------- key login removal

    def test_api_key_session_login_is_disabled(self):
        for path, kwargs in (("/admin/session", {"json": {"api_key": LEGACY_KEY}}),
                             ("/admin/session", {"json": {"api_key": "anything"}})):
            with self.subTest(kwargs=kwargs):
                response = self.client.post(path, headers=ORIGIN, **kwargs)
                self.assertEqual(response.status_code, 405)
                self.assertEqual(response.json()["error"], "method_not_allowed")
        # No legacy management cookie is ever issued.
        self.assertNotIn("cb_admin_session", self.client.cookies)

    def test_bearer_api_key_cannot_authorize_management(self):
        response = self.client.post("/admin/probe", headers={"Authorization": f"Bearer {LEGACY_KEY}"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"], "unauthenticated")
        response = self.client.post("/admin/probe", headers={"X-Api-Key": LEGACY_KEY})
        self.assertEqual(response.status_code, 401)

    def test_unauthenticated_management_requests_are_rejected(self):
        self.assertEqual(self.client.post("/admin/probe").status_code, 401)
        self.assertEqual(self.client.get("/admin/settings").status_code, 401)
        self.assertEqual(self.client.get("/admin/models").status_code, 401)

    # ------------------------------------------------------------ authenticated

    def test_session_endpoint_returns_gateway_shape(self):
        self.assertEqual(self.client.get("/admin/session").status_code, 401)
        self.assertEqual(self.client.get("/admin/session").json(),
                         {"authenticated": False, "csrf_token": None})
        csrf = self.login()
        response = self.client.get("/admin/session")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"authenticated": True, "csrf_token": csrf})
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_authenticated_cookie_session_reaches_downstream_with_identity(self):
        csrf = self.login()
        response = self.client.post("/admin/probe", headers={**ORIGIN, "X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["identity"], "sso:admin-1")
        self.assertTrue(body["cookie_scoped"])
        self.assertFalse(body["has_authorization"])  # no server key injected into scope
        self.assertEqual(body["csrf_header"], csrf)

    def test_mutations_require_the_gateway_csrf_and_origin(self):
        csrf = self.login()
        self.assertEqual(self.client.post("/admin/probe").status_code, 403)
        self.assertEqual(self.client.post("/admin/probe", headers={**ORIGIN}).status_code, 403)
        self.assertEqual(self.client.post("/admin/probe",
                                          headers={**ORIGIN, "X-CSRF-Token": "nope"}).status_code, 403)
        response = self.client.post("/admin/probe", headers={"Origin": "https://evil.invalid",
                                                            "X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "origin_denied")

    def test_enrollment_poll_requires_csrf_even_though_it_is_a_get(self):
        self.login()
        self.assertEqual(self.client.get("/admin/oauth/poll?login_id=x").status_code, 403)
        csrf = self.client.get("/sso/session").json()["csrf_token"]
        # Authorized by CSRF, then the dispatcher rejects the unknown task.
        response = self.client.get("/admin/oauth/poll?login_id=x",
                                   headers={**ORIGIN, "X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 404)

    def test_reads_do_not_require_csrf(self):
        self.login()
        self.assertEqual(self.client.get("/admin/settings").status_code, 200)
        self.assertEqual(self.client.get("/admin/models").status_code, 200)

    def test_delete_admin_session_logs_out(self):
        csrf = self.login()
        self.assertEqual(self.client.delete("/admin/session").status_code, 403)
        response = self.client.delete("/admin/session", headers={**ORIGIN, "X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"authenticated": False})
        self.assertNotIn(SESSION_COOKIE, self.client.cookies)
        self.assertEqual(self.client.get("/sso/session").status_code, 401)

    def test_unlisted_identity_loses_management_access_next_request(self):
        csrf = self.login()
        self.assertEqual(self.client.post("/admin/probe", headers={**ORIGIN, "X-CSRF-Token": csrf}).status_code, 200)
        # Admission is the allow-list (design D2.3): removing the subject revokes
        # access immediately, even though the provider still calls them an admin.
        self.service.store.update({"allowedSubjects": ["another-operator"]})
        self.assertEqual(self.client.post("/admin/probe", headers={**ORIGIN, "X-CSRF-Token": csrf}).status_code, 403)

    # -------------------------------------------------------- full log clearing

    def test_full_log_clear_uses_the_trusted_identity_not_a_browser_key(self):
        csrf = self.login()
        audit = self.config["audit_store"]
        response = self.client.post("/admin/logs/clear", headers={**ORIGIN, "X-CSRF-Token": csrf},
                                    json={"scope": "all", "confirmation": CLEAR_CONFIRMATION})
        self.assertEqual(response.status_code, 200)
        audit.clear.assert_called_once_with("all")

        audit.clear.reset_mock()
        bad = self.client.post("/admin/logs/clear", headers={**ORIGIN, "X-CSRF-Token": csrf},
                               json={"scope": "all", "confirmation": "wrong"})
        self.assertEqual(bad.status_code, 403)
        audit.clear.assert_not_called()

        # A browser-supplied api_key is never read or required in SSO mode.
        audit.clear.reset_mock()
        ignored = self.client.post("/admin/logs/clear", headers={**ORIGIN, "X-CSRF-Token": csrf},
                                   json={"scope": "all", "confirmation": CLEAR_CONFIRMATION,
                                         "api_key": "browser-key"})
        self.assertEqual(ignored.status_code, 200)
        audit.clear.assert_called_once_with("all")

    def test_details_only_clear_needs_no_key(self):
        csrf = self.login()
        response = self.client.post("/admin/logs/clear", headers={**ORIGIN, "X-CSRF-Token": csrf},
                                    json={"scope": "details"})
        self.assertEqual(response.status_code, 200)

    # ------------------------------------------------------- inference untouched

    def test_inference_api_key_behaviour_is_unchanged(self):
        self.assertEqual(self.client.get("/v1/models").status_code, 401)
        good = self.client.get("/v1/models", headers={"Authorization": f"Bearer {LEGACY_KEY}"})
        self.assertEqual(good.status_code, 200)
        # The console session cookie must not authorize inference.
        self.login()
        self.assertEqual(self.client.get("/v1/models").status_code, 401)


class SSONewManagementRoutesTests(unittest.TestCase):
    """Exercise new management routes with real key/media persistence behind SSO."""

    login = SSOAdminBoundaryTests.login

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        control = ControlStore(self.root / "control.sqlite3")
        self.addCleanup(control.close)
        admin_account.save(control, admin_account.new("local-admin", "synthetic-password", "user"))
        media = MediaStore(self.root)
        self.addCleanup(media.close)
        gateway = _Gateway()
        self.updater = Mock()
        self.updater.view.return_value = {"current": "1.5.4", "job": {"status": "idle"}}
        self.updater.check.return_value = self.updater.view.return_value
        gateway.config.update(control_store=control, media_store=media, updater=self.updater)
        gateway._media_ttl_hours = Mock(return_value=24)
        gateway._media_max_bytes = Mock(return_value=1024 * 1024)
        self.idp = FakeIdp()
        self.app, self.service, self.config = build_sso_app(self.idp, gateway=gateway)
        self.app.add_middleware(InferenceAuthMiddleware, config=self.config)

        @self.app.post("/v1/chat/completions")
        async def inference_probe(request: Request):
            principal = request.state.api_principal
            return {"id": principal.id, "type": principal.type}

        self.client = self.enterContext(TestClient(self.app, base_url="http://localhost"))

    def test_new_reads_require_sso_and_accept_an_authenticated_session(self):
        paths = ("/admin/keys", "/admin/media", "/admin/media/assets", "/admin/media/tasks", "/admin/update")
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path, headers={"Authorization": f"Bearer {LEGACY_KEY}"}).status_code, 401)
        self.login()
        for path in paths:
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.headers["cache-control"], "no-store")

    def test_local_password_login_and_account_management_stay_disabled(self):
        response = self.client.post("/admin/session", headers=ORIGIN,
                                    json={"username": "local-admin", "password": "synthetic-password"})
        self.assertEqual(response.status_code, 405)
        self.assertNotIn("cb_admin_session", self.client.cookies)
        csrf = self.login()
        self.assertEqual(self.client.get("/admin/account").status_code, 405)
        self.assertEqual(self.client.put("/admin/account", headers={**ORIGIN, "X-CSRF-Token": csrf},
                                         json={"current_password": "synthetic-password",
                                               "new_password": "new-synthetic-password"}).status_code, 405)

    def test_new_mutations_require_csrf_before_invoking_their_handlers(self):
        csrf = self.login()
        operations = (("POST", "/admin/keys", {"type": "standard", "name": "test"}),
                      ("DELETE", "/admin/sessions", None),
                      ("POST", "/admin/update/check", None),
                      ("DELETE", "/admin/media/assets/missing", None),
                      ("POST", "/admin/logs/clear", {"scope": "all", "confirmation": CLEAR_CONFIRMATION}))
        for method, path, body in operations:
            with self.subTest(path=path):
                self.assertEqual(self.client.request(method, path, json=body, headers=ORIGIN).status_code, 403)
                self.assertEqual(self.client.request(method, path, json=body,
                                 headers={"Origin": "https://evil.invalid", "X-CSRF-Token": csrf}).status_code, 403)
        self.assertEqual(self.config["key_store"].list(), [])
        self.updater.check.assert_not_called()
        self.config["audit_store"].clear.assert_not_called()
        self.assertTrue(self.service.sessions)
        headers = {**ORIGIN, "X-CSRF-Token": csrf}
        self.assertEqual(self.client.post("/admin/update/check", headers=headers).status_code, 200)
        self.updater.check.assert_called_once_with(True)
        self.assertEqual(self.client.delete("/admin/media/assets/missing", headers=headers).status_code, 404)

    def test_revoking_all_sessions_invalidates_other_browser_sessions(self):
        self.login()
        previous = self.client.cookies.get(SESSION_COOKIE)
        self.client.cookies.clear()
        csrf = self.login()
        self.assertEqual(len(self.service.sessions), 2)
        response = self.client.delete("/admin/sessions", headers={**ORIGIN, "X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(self.service.sessions)
        self.assertNotIn(SESSION_COOKIE, self.client.cookies)
        self.client.cookies.set(SESSION_COOKIE, previous)
        self.assertEqual(self.client.get("/admin/keys").status_code, 401)

    def test_inference_keys_created_under_sso_cannot_authorize_management(self):
        csrf = self.login()
        headers = {**ORIGIN, "X-CSRF-Token": csrf}
        standard = self.client.post("/admin/keys", headers=headers, json={"type": "standard", "name": "test"})
        self.assertEqual(standard.status_code, 200, standard.text)
        self.config["api_key"] = ""
        admin = self.client.post("/admin/keys", headers=headers, json={"type": "admin", "name": "test admin"})
        self.assertEqual(admin.status_code, 200, admin.text)
        self.assertEqual(self.client.post("/v1/chat/completions", json={}).status_code, 401)
        self.client.cookies.clear()
        for created in (standard.json(), admin.json()):
            with self.subTest(kind=created["type"]):
                for key_header in ({"Authorization": f"Bearer {created['secret']}"}, {"X-Api-Key": created["secret"]}):
                    response = self.client.post("/v1/chat/completions", headers=key_header, json={})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json(), {"id": created["id"], "type": created["type"]})
                    self.assertEqual(self.client.get("/admin/keys", headers=key_header).status_code, 401)
                    self.assertEqual(self.client.post("/admin/logs/clear", headers=key_header,
                                                     json={"scope": "details"}).status_code, 401)


class RuntimeWiringTests(unittest.TestCase):
    def gateway(self, sso, store=None):
        app = FastAPI()
        config = {"sso": sso, "management": object(), "api_key": "synthetic-management-key",
                  "control_store": None, "audit_store": None,
                  "auth_settings": store or auth_settings.SettingsStore()}
        return SimpleNamespace(app=app, CONFIG=config,
                               __file__=str(Path(__file__).resolve().parents[1] / "converter.py"))

    def test_disabled_sso_installs_the_key_boundary_and_the_legacy_one(self):
        # SSO routes are always installed so the login page can read the public
        # contract and the console can enable SSO without a restart; the admin
        # boundary is still the legacy one because SSO is off at startup.
        gateway = self.gateway(load_sso_config({}))
        with patch.object(runtime_management, "install_admin") as admin, \
                patch.object(runtime_management, "install_pages"), \
                patch.object(runtime_management, "install_sso") as sso:
            sso.return_value = object()
            service = runtime_management.install(gateway)
        sso.assert_called_once()
        self.assertIsNotNone(service)
        self.assertIsNone(admin.call_args.kwargs["sso"])

    def test_enabled_sso_installs_the_service_and_raw_target_guard(self):
        settings = load_sso_config({
            "CODEBUDDY2API_SSO_ENABLED": "true",
            "PUBLIC_ORIGIN": "http://localhost",
            "OIDC_ISSUER": "http://localhost",
            "OIDC_CLIENT_ID": "cb-client",
            "OIDC_CLIENT_SECRET": "cb-secret",
            "ALLOW_INSECURE_LOCALHOST": "true",
        })
        gateway = self.gateway(settings)
        gateway.CONFIG["panel_key"] = "panel-admin-key-0123456"
        with patch.object(runtime_management, "install_admin") as admin, \
                patch.object(runtime_management, "install_pages"), \
                patch.object(runtime_management, "install_sso") as sso:
            sso.return_value = object()
            service = runtime_management.install(gateway)
        self.assertIsNotNone(service)
        self.assertIs(admin.call_args.kwargs["sso"], service)
        # install_request_target_guard was added, so the encoded alias is rejected.
        client = self.enterContext(TestClient(gateway.app))
        self.assertEqual(client.get("/admin/%73ession").status_code, 400)


class CsrfOriginContractTests(unittest.TestCase):
    """Only PUBLIC_ORIGIN is trusted; the legacy admin allowlist never widens it."""

    def setUp(self):
        self.idp = FakeIdp()
        self.app, self.service, self.config = build_sso_app(self.idp, extra_routes=probe_routes)
        self.client = self.enterContext(TestClient(self.app, base_url="http://localhost"))
        self.csrf = self.login()

    def login(self):
        response = self.client.get("/sso/login?return_to=/dashboard/", follow_redirects=False)
        params = {k: v[0] for k, v in parse_qs(urlsplit(response.headers["location"]).query).items()}
        code = self.idp.issue_code(params["nonce"])
        self.client.get(f"/sso/callback?code={code}&state={params['state']}", follow_redirects=False)
        return self.client.get("/sso/session").json()["csrf_token"]

    def test_a_legacy_allowlisted_origin_cannot_extend_sso_trust(self):
        # The legacy admin surface accepts extra origins; SSO must ignore them.
        self.config["admin_allowed_origins"] = "https://console.example.com"
        self.assertFalse(hasattr(self.service, "set_admin_allowed_origins"))
        response = self.client.post("/admin/probe", headers={
            "Origin": "https://console.example.com", "X-CSRF-Token": self.csrf})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "origin_denied")

    def test_the_public_origin_must_match_scheme_host_and_port(self):
        for origin in ("https://localhost", "http://localhost:8080", "http://127.0.0.1",
                       "http://localhost.evil.invalid", "null"):
            with self.subTest(origin=origin):
                response = self.client.post("/admin/probe", headers={
                    "Origin": origin, "X-CSRF-Token": self.csrf})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["error"], "origin_denied")

    def test_an_origin_header_must_be_a_bare_origin(self):
        # `Origin` is scheme://host[:port] only: credentials, a path, a query and a
        # fragment are all malformed and must never be normalized into a match.
        for origin in ("http://localhost/", "http://localhost/dashboard",
                       "http://localhost?x=1", "http://localhost#frag",
                       "http://user@localhost", "http://user:pass@localhost",
                       "http://localhost:80/dashboard"):
            with self.subTest(origin=origin):
                response = self.client.post("/admin/probe", headers={
                    "Origin": origin, "X-CSRF-Token": self.csrf})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["error"], "origin_denied")

    def test_a_referer_may_carry_a_path_and_query_but_not_credentials(self):
        accepted = ("http://localhost/dashboard/", "http://localhost/dashboard/settings?tab=1",
                    "http://localhost:80/dashboard/credentials")
        for referer in accepted:
            with self.subTest(accepted=referer):
                response = self.client.get("/admin/oauth/poll?login_id=x", headers={
                    "Referer": referer, "X-CSRF-Token": self.csrf})
                self.assertEqual(response.status_code, 404)
        rejected = ("http://user@localhost/dashboard/", "http://user:pass@localhost/dashboard/",
                    "http://localhost/dashboard/#frag", "https://localhost/dashboard/",
                    "http://localhost:8080/dashboard/", "https://evil.invalid/dashboard/",
                    "not-a-url", "")
        for referer in rejected:
            with self.subTest(rejected=referer):
                response = self.client.get("/admin/oauth/poll?login_id=x", headers={
                    "Referer": referer, "X-CSRF-Token": self.csrf})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["error"], "origin_denied")

    def test_cross_site_fetch_metadata_is_always_refused(self):
        for site in ("cross-site", "same-site"):
            with self.subTest(site=site):
                response = self.client.post("/admin/probe", headers={
                    "Origin": "http://localhost", "Sec-Fetch-Site": site, "X-CSRF-Token": self.csrf})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["error"], "origin_denied")

    def test_same_origin_and_user_initiated_fetch_metadata_are_accepted(self):
        for site in ("same-origin", "none"):
            with self.subTest(site=site):
                response = self.client.post("/admin/probe", headers={
                    "Origin": "http://localhost", "Sec-Fetch-Site": site, "X-CSRF-Token": self.csrf})
                self.assertEqual(response.status_code, 200)

    def test_a_write_without_origin_is_refused_even_with_a_matching_referer(self):
        response = self.client.post("/admin/probe", headers={
            "Referer": "http://localhost/dashboard/credentials", "X-CSRF-Token": self.csrf})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "origin_denied")

    def test_the_oauth_poll_accepts_a_same_origin_referer_instead_of_origin(self):
        # A browser does not attach `Origin` to a same-origin GET.
        response = self.client.get("/admin/oauth/poll?login_id=x", headers={
            "Referer": "http://localhost/dashboard/credentials",
            "Sec-Fetch-Site": "same-origin", "X-CSRF-Token": self.csrf})
        self.assertEqual(response.status_code, 404)  # CSRF passed; unknown task

    def test_the_oauth_poll_still_needs_a_matching_referer_and_csrf(self):
        cases = {
            "no referer": {"Sec-Fetch-Site": "same-origin", "X-CSRF-Token": self.csrf},
            "foreign referer": {"Referer": "https://evil.invalid/dashboard/", "X-CSRF-Token": self.csrf},
            "wrong port referer": {"Referer": "http://localhost:8080/dashboard/", "X-CSRF-Token": self.csrf},
            "cross-site": {"Referer": "http://localhost/dashboard/", "Sec-Fetch-Site": "cross-site",
                           "X-CSRF-Token": self.csrf},
            "no csrf": {"Referer": "http://localhost/dashboard/"},
        }
        for label, headers in cases.items():
            with self.subTest(case=label):
                self.assertEqual(self.client.get("/admin/oauth/poll?login_id=x", headers=headers).status_code, 403)

    def test_the_oauth_poll_also_accepts_an_exact_origin(self):
        response = self.client.get("/admin/oauth/poll?login_id=x", headers={
            "Origin": "http://localhost", "X-CSRF-Token": self.csrf})
        self.assertEqual(response.status_code, 404)

    def test_the_csrf_token_is_compared_in_full(self):
        for token in ("", " ", self.csrf[:-1], self.csrf + "x", self.csrf.upper()):
            with self.subTest(token=token[:8]):
                response = self.client.post("/admin/probe", headers={
                    "Origin": "http://localhost", "X-CSRF-Token": token})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["error"], "csrf_denied")


class StartupFailClosedTests(unittest.TestCase):
    def test_missing_sso_configuration_no_longer_blocks_startup(self):
        # Design D2.6: SSO is configured in the console, so an unset OIDC block is
        # not a startup error. The process must still refuse to run with a key
        # login that cannot work, which is what the panel key provides.
        import os
        import subprocess

        from app import auth_settings

        seed = auth_settings.seeded({}, allow_local=False)
        self.assertIsNone(seed)
        store = auth_settings.SettingsStore()
        self.assertFalse(store.current()["enabled"])
        self.assertTrue(store.current()["keyLoginEnabled"])

        root = Path(__file__).resolve().parents[1]
        env = {**os.environ, "PYTHONPATH": str(root), "PYTHONUTF8": "1",
               "CODEBUDDY2API_KEY": "synthetic", "PANEL_ADMIN_KEY": "panel-admin-key-0123456"}
        for name in ("CODEBUDDY2API_SSO_ENABLED", "PUBLIC_ORIGIN", "OIDC_ISSUER",
                     "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"):
            env.pop(name, None)
        process = subprocess.run([sys.executable, "-B", "converter.py", "--help"],
                                 cwd=root, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(process.returncode, 0, process.stderr)


if __name__ == "__main__":
    unittest.main()
