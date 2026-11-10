"""Console-managed authentication settings: validation, persistence, hot apply.

Design D2.4/D2.5/D2.6. The console is the only place SSO is configured, the
client secret is never returned, and a saved change is visible to the next
request without a restart.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from fastapi.testclient import TestClient

from app import auth_settings
from app.control_store import ControlStore
from tests.sso_fixture import FakeIdp, build_sso_app, settings_store

ORIGIN = {"Origin": "http://localhost"}
KEY = "panel-admin-key-0123456789"


def full(**overrides):
    values = {
        "enabled": True,
        "keyLoginEnabled": True,
        "issuer": "https://idp.example.com",
        "clientId": "cb-client",
        "clientSecret": "super-secret",
        "scope": "openid profile email",
        "providerName": "Corp SSO",
        "allowedSubjects": ["ops-1"],
        "allowedEmails": [],
    }
    values.update(overrides)
    return values


class ValidationTests(unittest.TestCase):
    def test_enabling_sso_requires_a_provider_and_an_allow_list(self):
        cases = {
            "no issuer": full(issuer=""),
            "no client id": full(clientId=""),
            "no secret": full(clientSecret=""),
            "no allow list": full(allowedSubjects=[], allowedEmails=[]),
        }
        for label, values in cases.items():
            with self.subTest(case=label):
                with self.assertRaises(auth_settings.AuthSettingsError):
                    auth_settings.validate(values, auth_settings.DEFAULT_SSO)

    def test_key_login_cannot_be_the_only_method_turned_off(self):
        with self.assertRaises(auth_settings.AuthSettingsError):
            auth_settings.validate({"keyLoginEnabled": False},
                                   auth_settings.with_defaults({"enabled": False}))

    def test_the_issuer_must_be_https_outside_loopback_development(self):
        with self.assertRaises(auth_settings.AuthSettingsError):
            auth_settings.validate(full(issuer="http://idp.example.com"),
                                   auth_settings.DEFAULT_SSO)
        accepted = auth_settings.validate(full(issuer="http://localhost:9000"),
                                          auth_settings.DEFAULT_SSO, allow_local=True)
        self.assertEqual(accepted["issuer"], "http://localhost:9000")

    def test_the_scope_must_keep_openid(self):
        with self.assertRaises(auth_settings.AuthSettingsError):
            auth_settings.validate(full(scope="profile email"), auth_settings.DEFAULT_SSO)

    def test_allow_lists_are_deduplicated_and_emails_lowercased(self):
        values = auth_settings.validate(
            full(allowedSubjects=["ops-1", "ops-1", " "],
                 allowedEmails=["Ops@Example.com", "ops@example.com"]),
            auth_settings.DEFAULT_SSO)
        self.assertEqual(values["allowedSubjects"], ["ops-1"])
        self.assertEqual(values["allowedEmails"], ["ops@example.com"])

    def test_a_malformed_email_is_rejected(self):
        with self.assertRaises(auth_settings.AuthSettingsError):
            auth_settings.validate(full(allowedEmails=["not-an-email"]),
                                   auth_settings.DEFAULT_SSO)

    def test_a_blank_secret_keeps_the_stored_one(self):
        previous = auth_settings.validate(full(), auth_settings.DEFAULT_SSO)
        saved = auth_settings.validate({"clientSecret": "   "}, previous)
        self.assertEqual(saved["clientSecret"], "super-secret")

    def test_boolean_flags_must_be_booleans(self):
        for value in ("true", 1, None):
            with self.subTest(value=value):
                with self.assertRaises(auth_settings.AuthSettingsError):
                    auth_settings.validate({"enabled": value}, auth_settings.DEFAULT_SSO)


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.settings = auth_settings.validate(full(allowedEmails=["ops@example.com"]),
                                               auth_settings.DEFAULT_SSO)

    def test_a_listed_subject_is_admitted(self):
        self.assertTrue(auth_settings.admits(self.settings, subject="ops-1", email="",
                                             email_verified=False))

    def test_a_verified_listed_email_is_admitted(self):
        self.assertTrue(auth_settings.admits(self.settings, subject="other",
                                             email="ops@example.com", email_verified=True))

    def test_an_unverified_email_is_never_admitted(self):
        self.assertFalse(auth_settings.admits(self.settings, subject="other",
                                              email="ops@example.com", email_verified=False))

    def test_an_unlisted_identity_is_refused(self):
        self.assertFalse(auth_settings.admits(self.settings, subject="other",
                                              email="other@example.com", email_verified=True))


class SanitizeTests(unittest.TestCase):
    def test_the_client_secret_is_replaced_by_a_presence_flag(self):
        values = auth_settings.validate(full(), auth_settings.DEFAULT_SSO)
        public = auth_settings.sanitize(values)
        self.assertNotIn("clientSecret", public)
        self.assertTrue(public["hasClientSecret"])
        self.assertNotIn("super-secret", json.dumps(public))
        self.assertTrue(public["ssoEnabled"])
        self.assertEqual(public["allowedSubjects"], ["ops-1"])


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.control = ControlStore(self.root / "control.sqlite3")
        self.addCleanup(self.control.close)

    def test_saved_settings_round_trip_through_the_control_database(self):
        values = auth_settings.validate(full(), auth_settings.DEFAULT_SSO)
        auth_settings.save(self.control, values)
        self.assertEqual(auth_settings.load(self.control), values)

    def test_an_unsaved_console_reports_none(self):
        self.assertIsNone(auth_settings.load(self.control))

    def test_corrupt_settings_raise_instead_of_silently_resetting(self):
        with self.control._lock:
            self.control._db.execute(
                "INSERT INTO gateway_secrets(name,value,announced) VALUES(?,?,1)",
                (auth_settings.STORE_NAME, "{not json"))
        with self.assertRaises(auth_settings.AuthSettingsError):
            auth_settings.load(self.control)

    def test_concurrent_updates_are_serialized_and_persist_what_they_publish(self):
        """Two PATCHes must not interleave read-modify-write.

        Without the lock both threads read the same previous document and then
        persist and publish in whatever order they happen to finish, so memory
        and disk can disagree. Detecting overlap inside the critical section is
        deterministic, unlike racing SQLite writes.
        """
        store = auth_settings.SettingsStore(control=self.control)
        store.update(full(providerName="start"))
        active = {"now": 0, "peak": 0}
        guard = threading.Lock()
        real_save = auth_settings.save

        def slow_save(control, values):
            with guard:
                active["now"] += 1
                active["peak"] = max(active["peak"], active["now"])
            try:
                time.sleep(0.05)
                real_save(control, values)
            finally:
                with guard:
                    active["now"] -= 1

        with mock.patch.object(auth_settings, "save", slow_save):
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda i: store.update({"providerName": f"name-{i}"}),
                              range(4)))

        self.assertEqual(active["peak"], 1, "updates entered the critical section together")
        self.assertEqual(auth_settings.load(self.control), store.current())

    def test_a_failed_update_leaves_the_previous_settings_in_place(self):
        store = auth_settings.SettingsStore(control=self.control)
        store.update(full(providerName="keep-me"))
        with self.assertRaises(auth_settings.AuthSettingsError):
            store.update({"allowedEmails": ["not-an-email"]})
        self.assertEqual(store.current()["providerName"], "keep-me")
        self.assertEqual(auth_settings.load(self.control)["providerName"], "keep-me")


class EnvironmentSeedTests(unittest.TestCase):
    def test_an_absent_environment_seeds_nothing(self):
        self.assertIsNone(auth_settings.seeded({}, allow_local=False))

    def test_a_seed_without_an_allow_list_carries_values_but_stays_disabled(self):
        seed = auth_settings.seeded({
            "CODEBUDDY2API_SSO_ENABLED": "true",
            "OIDC_ISSUER": "https://idp.example.com",
            "OIDC_CLIENT_ID": "cb-client",
            "OIDC_CLIENT_SECRET": "s",
            "PUBLIC_ORIGIN": "https://cb.example.com",
        }, allow_local=False)
        self.assertFalse(seed["enabled"])
        self.assertEqual(seed["issuer"], "https://idp.example.com")
        self.assertEqual(seed["callbackUrl"], "https://cb.example.com/sso/callback")

    def test_a_seed_with_an_allow_list_can_enable_sso(self):
        seed = auth_settings.seeded({
            "CODEBUDDY2API_SSO_ENABLED": "true",
            "OIDC_ISSUER": "https://idp.example.com",
            "OIDC_CLIENT_ID": "cb-client",
            "OIDC_CLIENT_SECRET": "s",
            "CODEBUDDY2API_SSO_ALLOWED_SUBJECTS": "ops-1, ops-2",
        }, allow_local=False)
        self.assertTrue(seed["enabled"])
        self.assertEqual(seed["allowedSubjects"], ["ops-1", "ops-2"])


class RouteTests(unittest.TestCase):
    """The authenticated GET/PATCH surface, driven through the real app."""

    def setUp(self):
        self.idp = FakeIdp()
        self.store = settings_store()
        self.app, self.service, self.config = build_sso_app(
            self.idp, store=self.store, key=KEY)
        self.client = self.enterContext(TestClient(self.app, base_url="http://localhost"))

    def login(self):
        from urllib.parse import parse_qs, urlsplit

        response = self.client.get("/sso/login?return_to=/dashboard/", follow_redirects=False)
        params = {k: v[0] for k, v in parse_qs(urlsplit(response.headers["location"]).query).items()}
        code = self.idp.issue_code(params["nonce"])
        self.client.get(f"/sso/callback?code={code}&state={params['state']}",
                        follow_redirects=False)
        return self.client.get("/sso/session").json()["csrf_token"]

    def test_the_public_config_is_unauthenticated(self):
        response = self.client.get("/sso/config")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["sso"]["enabled"])
        self.assertEqual(payload["sso"]["loginUrl"], "/sso/login")
        self.assertTrue(payload["keyLoginEnabled"])
        self.assertNotIn("clientSecret", response.text)

    def test_the_public_config_hides_the_key_field_when_no_key_is_set(self):
        app, _, _ = build_sso_app(FakeIdp(), store=settings_store())
        with TestClient(app, base_url="http://localhost") as client:
            self.assertFalse(client.get("/sso/config").json()["keyLoginEnabled"])

    def test_settings_require_authentication(self):
        self.assertEqual(self.client.get("/admin/auth/settings").status_code, 401)
        self.assertEqual(self.client.patch("/admin/auth/settings", headers=ORIGIN,
                                           json={"providerName": "x"}).status_code, 401)

    def test_reading_the_settings_never_returns_the_secret(self):
        self.login()
        response = self.client.get("/admin/auth/settings")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["hasClientSecret"])
        self.assertNotIn("clientSecret", payload)
        self.assertNotIn("cb-secret", response.text)
        self.assertEqual(payload["allowedSubjects"], ["admin-1"])

    def test_patching_settings_applies_without_a_restart(self):
        csrf = self.login()
        response = self.client.patch("/admin/auth/settings", headers={**ORIGIN, "X-CSRF-Token": csrf},
                                     json={"providerName": "改名后的 SSO",
                                           "allowedEmails": ["ops@example.com"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["providerName"], "改名后的 SSO")
        # The live service reports the new values on the very next request.
        public = self.client.get("/sso/config").json()
        self.assertEqual(public["sso"]["providerName"], "改名后的 SSO")
        self.assertEqual(self.store.current()["allowedEmails"], ["ops@example.com"])

    def test_mutations_require_csrf(self):
        self.login()
        response = self.client.patch("/admin/auth/settings", headers=ORIGIN,
                                     json={"providerName": "x"})
        self.assertEqual(response.status_code, 403)

    def test_an_invalid_patch_is_refused_with_the_reason(self):
        csrf = self.login()
        response = self.client.patch("/admin/auth/settings", headers={**ORIGIN, "X-CSRF-Token": csrf},
                                     json={"allowedEmails": ["not-an-email"]})
        self.assertEqual(response.status_code, 400)
        self.assertIn("邮箱", response.json()["error"]["message"])

    def test_disabling_key_login_needs_an_sso_session(self):
        csrf = self.login()
        response = self.client.patch("/admin/auth/settings", headers={**ORIGIN, "X-CSRF-Token": csrf},
                                     json={"keyLoginEnabled": False})
        # This session *is* an SSO session under the same configuration, so the
        # guard accepts it and the setting is saved.
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(self.store.current()["keyLoginEnabled"])


if __name__ == "__main__":
    unittest.main()
