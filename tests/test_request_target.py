"""Raw request-target guard: encoded route aliases rejected, model IDs preserved."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.request_target import RequestTargetError, install_request_target_guard, validate_request_target


class ValidateTargetTests(unittest.TestCase):
    def assertRejected(self, target, method="GET"):
        with self.assertRaises(RequestTargetError):
            validate_request_target(target, method)

    def test_plain_targets_are_accepted(self):
        for target in ("/", "/health", "/dashboard/", "/dashboard/settings", "/admin/session",
                       "/admin/models", "/v1/models", "/sso/callback?code=x&state=y"):
            with self.subTest(target=target):
                validate_request_target(target)

    def test_encoded_route_aliases_are_rejected(self):
        for target in ("/admin/%73ession", "/admin/session%00", "/admin/%2e%2e/admin",
                       "/dashboard/%2e%2e/admin", "/v1/%6dodels"):
            with self.subTest(target=target):
                self.assertRejected(target)

    def test_traversal_duplicate_separators_and_backslashes_are_rejected(self):
        for target in ("/admin//session", "/admin/./session", "/admin/../admin", "/admin\\session",
                       "//admin/session", "admin/session", "/admin/session#fragment",
                       "/admin/session with space"):
            with self.subTest(target=target):
                self.assertRejected(target)

    def test_session_alias_spellings_are_rejected(self):
        for target in ("/admin/session/", "/Admin/Session", "/admin/SESSION//"):
            with self.subTest(target=target):
                self.assertRejected(target)

    def test_encoded_model_ids_are_preserved_for_the_model_routes(self):
        legal = ("/admin/models/org%2Fmodel", "/admin/models/vendor%3Amodel",
                 "/admin/models/%40org%2Fmodel", "/admin/models/custom%3A0123abcd")
        for target in legal:
            with self.subTest(target=target):
                validate_request_target(target, "PUT")
                validate_request_target(target, "DELETE")
        validate_request_target("/admin/models/org%2Fmodel/preview", "POST")

    def test_illegal_encoded_model_ids_are_rejected(self):
        for target, method in (("/admin/models/..%2Fadmin", "PUT"),
                               ("/admin/models/org%2F%2Fmodel", "PUT"),
                               ("/admin/models/a%20b", "PUT"),
                               ("/admin/models/" + "x" * 200, "PUT"),
                               ("/admin/models/%2540x", "PUT")):
            with self.subTest(target=target):
                self.assertRejected(target, method)

    def test_encoding_is_not_allowed_outside_the_model_id_window(self):
        for target, method in (("/admin/models%2Forg%2Fmodel", "PUT"),
                               ("/admin/models/preview%2F", "POST"),
                               ("/admin/models/org%2Fmodel/previewx", "POST")):
            with self.subTest(target=target):
                self.assertRejected(target, method)


class MiddlewareTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()

        @app.get("/admin/session")
        async def session():
            return {"authenticated": True}

        @app.put("/admin/models/{model_id:path}")
        async def update_model(model_id: str):
            return {"id": model_id}

        install_request_target_guard(app)
        self.client = self.enterContext(TestClient(app))

    def test_rejected_targets_return_400_before_routing(self):
        # httpx normalizes literal dot segments on the client, so the HTTP cases
        # here are the ones that survive client-side normalization.
        for target in ("/admin/%73ession", "/admin//session", "/v1/%6dodels"):
            with self.subTest(target=target):
                response = self.client.get(target)
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.json())

    def test_encoded_model_id_still_routes(self):
        response = self.client.put("/admin/models/org%2Fmodel", json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["id"], "org/model")


if __name__ == "__main__":
    unittest.main()