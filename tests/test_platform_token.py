"""PLATFORM_TOKEN is the only management credential the unified panel can use.

These tests pin the contract of the env-gated service token: it authorises
``/admin/*``, it is off unless configured, and it never weakens the browser
guards that stay in place when the token is absent or wrong.
"""

import os
import unittest
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import platform_token
from app.admin_auth import AdminMiddleware

TOKEN = "platform-service-token-0123456789"


def build_application(token=""):
    application = FastAPI()

    @application.get("/admin/thing")
    async def thing():
        return {"ok": True}

    @application.post("/admin/thing")
    async def mutate():
        return {"ok": True}

    @application.get("/health")
    async def health():
        return {"ok": True}

    auth = Mock()
    # The browser guard is unreachable once the token authorises the request.
    auth.enabled.return_value = False
    application.add_middleware(AdminMiddleware, auth=auth, dispatch=None, token=token)
    return application


class TokenContractTests(unittest.TestCase):
    def test_token_authorises_management_routes(self):
        with TestClient(build_application(TOKEN)) as client:
            response = client.get("/admin/thing", headers={"Authorization": f"Bearer {TOKEN}"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"ok": True})

    def test_token_authorises_mutations_without_csrf(self):
        with TestClient(build_application(TOKEN)) as client:
            response = client.post("/admin/thing", headers={"Authorization": f"Bearer {TOKEN}"})
            self.assertEqual(response.status_code, 200)

    def test_token_never_leaks_into_the_response(self):
        with TestClient(build_application(TOKEN)) as client:
            response = client.get("/admin/thing", headers={"Authorization": f"Bearer {TOKEN}"})
            self.assertNotIn(TOKEN, response.text)
            self.assertNotIn(TOKEN, response.headers.get("cache-control", ""))
            self.assertEqual(response.headers["cache-control"], "no-store")

    def test_wrong_or_missing_token_falls_back_to_the_browser_guard(self):
        with TestClient(build_application(TOKEN)) as client:
            for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": ""},
                            {"Authorization": f"Basic {TOKEN}"}, {"Authorization": TOKEN}):
                with self.subTest(headers=headers):
                    response = client.get("/admin/thing", headers=headers)
                    self.assertNotEqual(response.status_code, 200)

    def test_unset_token_disables_the_branch(self):
        with TestClient(build_application("")) as client:
            response = client.get("/admin/thing", headers={"Authorization": f"Bearer {TOKEN}"})
            self.assertNotEqual(response.status_code, 200)

    def test_non_admin_paths_are_untouched(self):
        with TestClient(build_application(TOKEN)) as client:
            self.assertEqual(client.get("/health").status_code, 200)


class SessionRouteTests(unittest.TestCase):
    def test_get_reports_an_authenticated_machine_session(self):
        with TestClient(build_application(TOKEN)) as client:
            response = client.get("/admin/session", headers={"Authorization": f"Bearer {TOKEN}"})
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertTrue(payload["authenticated"])
            self.assertIsNone(payload["csrf_token"])

    def test_post_is_rejected_because_there_is_no_key_login(self):
        with TestClient(build_application(TOKEN)) as client:
            response = client.post("/admin/session", headers={"Authorization": f"Bearer {TOKEN}"},
                                   json={"key": TOKEN})
            self.assertEqual(response.status_code, 405)


class EnvironmentTests(unittest.TestCase):
    def test_short_or_empty_values_disable_the_branch(self):
        for value in ("", "   ", "short", "x" * (platform_token.MIN_TOKEN_LENGTH - 1)):
            with self.subTest(value=value):
                self.assertEqual(platform_token.platform_token_from_env({"PLATFORM_TOKEN": value}), "")

    def test_configured_value_is_trimmed_and_returned(self):
        self.assertEqual(platform_token.platform_token_from_env({"PLATFORM_TOKEN": f"  {TOKEN}  "}), TOKEN)
        self.assertEqual(platform_token.platform_token_from_env({}), "")

    def test_token_is_read_from_the_process_environment(self):
        previous = os.environ.get("PLATFORM_TOKEN")
        os.environ["PLATFORM_TOKEN"] = TOKEN
        try:
            self.assertEqual(platform_token.platform_token_from_env(os.environ), TOKEN)
        finally:
            if previous is None:
                del os.environ["PLATFORM_TOKEN"]
            else:
                os.environ["PLATFORM_TOKEN"] = previous


if __name__ == "__main__":
    unittest.main()
