"""Native SSO session lifecycle over real HTTP: login, callback, session, logout."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import time
import unittest
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient

from app.sso_auth import SESSION_COOKIE, TRANSACTION_COOKIE, safe_return_to
from tests.sso_fixture import FakeIdp, build_sso_app

ORIGIN = {"Origin": "http://localhost"}


def authorize_params(location: str) -> dict[str, str]:
    return {key: values[0] for key, values in parse_qs(urlsplit(location).query).items()}


class LoginFlowTests(unittest.TestCase):
    def setUp(self):
        self.idp = FakeIdp()
        self.app, self.service, self.config = build_sso_app(self.idp)
        self.client = self.enterContext(TestClient(self.app, base_url="http://localhost"))

    def start_login(self, client=None, return_to="/dashboard/"):
        client = client or self.client
        response = client.get(f"/sso/login?return_to={return_to}", follow_redirects=False)
        self.assertEqual(response.status_code, 302, response.text)
        return authorize_params(response.headers["location"])

    def login(self, client=None, subject="admin-1"):
        client = client or self.client
        params = self.start_login(client)
        code = self.idp.issue_code(params["nonce"], subject=subject)
        response = client.get(f"/sso/callback?code={code}&state={params['state']}", follow_redirects=False)
        return response

    # ------------------------------------------------------------- happy path

    def test_login_sets_transaction_cookie_and_no_prompt(self):
        response = self.client.get("/sso/login?return_to=/dashboard/", follow_redirects=False)
        self.assertEqual(response.status_code, 302)
        location = response.headers["location"]
        self.assertIn("code_challenge_method=S256", location)
        self.assertIn("response_type=code", location)
        self.assertNotIn("prompt=", location)
        self.assertIn(TRANSACTION_COOKIE, self.client.cookies)

    def test_callback_authenticates_and_session_returns_contract(self):
        response = self.login()
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "/dashboard/")
        cookie = self.client.cookies.get(SESSION_COOKIE)
        self.assertTrue(cookie)
        # The one-use transaction cookie is cleared.
        self.assertNotIn(TRANSACTION_COOKIE, self.client.cookies)

        session = self.client.get("/sso/session")
        self.assertEqual(session.status_code, 200)
        body = session.json()
        self.assertTrue(body["authenticated"])
        self.assertTrue(body["csrf_token"])
        self.assertEqual(body["user"]["role"], "admin")
        self.assertEqual(body["user"]["sub"], "admin-1")
        self.assertEqual(body["user"]["username"], "ops")

    def test_return_to_is_collapsed_to_a_dashboard_path(self):
        params = self.start_login(return_to="/dashboard/settings")
        code = self.idp.issue_code(params["nonce"])
        response = self.client.get(f"/sso/callback?code={code}&state={params['state']}", follow_redirects=False)
        self.assertEqual(response.headers["location"], "/dashboard/settings")

    # ------------------------------------------------------- transaction rules

    def test_transaction_is_single_use(self):
        params = self.start_login()
        code = self.idp.issue_code(params["nonce"])
        first = self.client.get(f"/sso/callback?code={code}&state={params['state']}", follow_redirects=False)
        self.assertEqual(first.status_code, 302)
        second = self.client.get(f"/sso/callback?code={code}&state={params['state']}", follow_redirects=False)
        self.assertEqual(second.status_code, 403)
        self.assertEqual(second.json()["error"], "login_transaction_invalid")

    def test_transaction_must_be_bound_to_the_same_browser(self):
        params = self.start_login()
        code = self.idp.issue_code(params["nonce"])
        other = self.enterContext(TestClient(self.app, base_url="http://localhost"))
        response = other.get(f"/sso/callback?code={code}&state={params['state']}", follow_redirects=False)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "login_transaction_invalid")

    def test_expired_transaction_is_rejected(self):
        params = self.start_login()
        self.service.transactions[params["state"]].expires_at = time.time() - 1
        code = self.idp.issue_code(params["nonce"])
        response = self.client.get(f"/sso/callback?code={code}&state={params['state']}", follow_redirects=False)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "login_transaction_expired")

    def test_callback_authorize_error_and_token_failure_are_fixed_codes(self):
        params = self.start_login()
        response = self.client.get(
            f"/sso/callback?error=access_denied&state={params['state']}", follow_redirects=False)
        self.assertEqual(response.json()["error"], "authorize_failed")

        failing = FakeIdp(token_status=400, token_error="invalid_grant")
        app, service, config = build_sso_app(failing)
        client = self.enterContext(TestClient(app, base_url="http://localhost"))
        params = self.start_login(client)
        code = failing.issue_code(params["nonce"])
        response = client.get(f"/sso/callback?code={code}&state={params['state']}", follow_redirects=False)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "token_exchange_failed")

    # ---------------------------------------------------------- authorization

    def test_anonymous_session_shape(self):
        response = self.client.get("/sso/session")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"authenticated": False, "csrf_token": None, "user": None})

    def test_non_admin_identity_is_forbidden(self):
        self.idp.role = "user"
        response = self.login()
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "forbidden")
        self.assertNotIn(SESSION_COOKIE, self.client.cookies)

    def test_is_admin_false_is_forbidden(self):
        self.idp.is_admin = False
        self.assertEqual(self.login().status_code, 403)

    def test_live_role_loss_after_login_returns_403(self):
        self.assertEqual(self.login().status_code, 302)
        self.assertEqual(self.client.get("/sso/session").status_code, 200)
        self.idp.role = "user"
        response = self.client.get("/sso/session")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "forbidden")
        # The session survives; only authorization failed.
        self.assertIn(SESSION_COOKIE, self.client.cookies)

    def test_live_userinfo_failure_fails_closed(self):
        self.assertEqual(self.login().status_code, 302)
        self.idp.access_tokens.clear()  # the live UserInfo call now 401s
        self.assertEqual(self.client.get("/sso/session").status_code, 403)

    def test_revoked_session_is_denied_next_request(self):
        self.assertEqual(self.login().status_code, 302)
        self.service.sessions.clear()
        self.assertEqual(self.client.get("/sso/session").status_code, 401)

    def test_absolute_expiry_is_enforced(self):
        self.assertEqual(self.login().status_code, 302)
        sid = self.client.cookies.get(SESSION_COOKIE)
        self.service.sessions[sid].expires_at = time.time() - 1
        self.assertEqual(self.client.get("/sso/session").status_code, 401)
        self.assertNotIn(sid, self.service.sessions)

    def test_idle_expiry_is_enforced(self):
        self.assertEqual(self.login().status_code, 302)
        sid = self.client.cookies.get(SESSION_COOKIE)
        self.service.sessions[sid].last_seen_at = time.time() - 10_000
        self.assertEqual(self.client.get("/sso/session").status_code, 401)

    # ----------------------------------------------------------------- logout

    def test_logout_requires_origin_and_csrf(self):
        self.assertEqual(self.login().status_code, 302)
        csrf = self.client.get("/sso/session").json()["csrf_token"]
        self.assertEqual(self.client.post("/sso/logout").status_code, 403)
        self.assertEqual(self.client.post("/sso/logout", headers={**ORIGIN}).status_code, 403)
        self.assertEqual(self.client.post("/sso/logout", headers={**ORIGIN, "X-CSRF-Token": "wrong"}).status_code, 403)
        response = self.client.post("/sso/logout", headers={**ORIGIN, "X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"authenticated": False})
        self.assertEqual(self.client.get("/sso/session").status_code, 401)

    def test_logout_requires_post(self):
        self.assertEqual(self.client.get("/sso/logout").status_code, 405)

    def test_a_new_login_supersedes_the_previous_session(self):
        self.assertEqual(self.login().status_code, 302)
        first = self.client.cookies.get(SESSION_COOKIE)
        self.assertEqual(self.login().status_code, 302)
        self.assertNotEqual(self.client.cookies.get(SESSION_COOKIE), first)
        self.assertNotIn(first, self.service.sessions)


class ReturnToTests(unittest.TestCase):
    def test_only_dashboard_paths_survive(self):
        for raw, expected in (("/dashboard/", "/dashboard/"), ("/dashboard/settings", "/dashboard/settings"),
                              ("/dashboard?tab=x", "/dashboard?tab=x"), ("/dashboard", "/dashboard/"),
                              ("/sso/login", "/dashboard/"), ("//evil.invalid/x", "/dashboard/"),
                              ("/dashboard/%2fadmin", "/dashboard/"), ("/dashboard/../admin", "/dashboard/"),
                              ("https://evil.invalid/x", "/dashboard/"), (None, "/dashboard/")):
            with self.subTest(raw=raw):
                self.assertEqual(safe_return_to(raw), expected)


if __name__ == "__main__":
    unittest.main()