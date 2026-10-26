"""Native SSO configuration: off by default, fail-closed when enabled."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import unittest

from app.sso_config import (DEFAULT_MAX_SESSIONS, DEFAULT_OAUTH_TIMEOUT_MS, DEFAULT_SESSION_IDLE_MS,
                            DEFAULT_SESSION_TTL_MS, DEFAULT_TRANSACTION_TTL_MS, SSOConfigError,
                            load)

BASE = {
    "CODEBUDDY2API_SSO_ENABLED": "true",
    "PUBLIC_ORIGIN": "https://console.example.com",
    "OIDC_ISSUER": "https://idp.example.com/realms/main",
    "OIDC_CLIENT_ID": "cb-client",
    "OIDC_CLIENT_SECRET": "cb-secret",
}


class SSOConfigTests(unittest.TestCase):
    def test_disabled_by_default_and_reads_nothing_else(self):
        config = load({})
        self.assertFalse(config.enabled)
        # A stray OIDC value must not block an existing legacy deployment.
        self.assertFalse(load({"OIDC_ISSUER": "not-a-url"}).enabled)

    def test_enabled_parses_contract_and_defaults(self):
        config = load(BASE)
        self.assertTrue(config.enabled)
        self.assertEqual(config.public_origin, "https://console.example.com")
        self.assertEqual(config.oidc_issuer, "https://idp.example.com/realms/main")
        self.assertEqual(config.redirect_uri, "https://console.example.com/sso/callback")
        self.assertEqual(config.session_ttl_ms, DEFAULT_SESSION_TTL_MS)
        self.assertEqual(config.session_idle_ms, DEFAULT_SESSION_IDLE_MS)
        self.assertEqual(config.transaction_ttl_ms, DEFAULT_TRANSACTION_TTL_MS)
        self.assertEqual(config.max_sessions, DEFAULT_MAX_SESSIONS)
        self.assertEqual(config.oauth_timeout_ms, DEFAULT_OAUTH_TIMEOUT_MS)
        self.assertTrue(config.cookie_secure)
        self.assertEqual(config.scopes, "openid profile roles")

    def test_refresh_adds_offline_access(self):
        self.assertEqual(load({**BASE, "OIDC_REFRESH": "true"}).scopes,
                         "openid profile roles offline_access")

    def test_missing_required_values_are_rejected(self):
        for name in ("PUBLIC_ORIGIN", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"):
            with self.subTest(name=name):
                env = dict(BASE)
                env.pop(name)
                with self.assertRaises(SSOConfigError):
                    load(env)

    def test_public_origin_requires_https_outside_loopback_dev(self):
        with self.assertRaises(SSOConfigError):
            load({**BASE, "PUBLIC_ORIGIN": "http://console.example.com"})
        with self.assertRaises(SSOConfigError):
            load({**BASE, "PUBLIC_ORIGIN": "https://console.example.com/path"})
        # The explicit loopback dev escape allows plain HTTP.
        config = load({**BASE, "PUBLIC_ORIGIN": "http://127.0.0.1:8787",
                       "OIDC_ISSUER": "http://127.0.0.1:9000", "ALLOW_INSECURE_LOCALHOST": "true"})
        self.assertFalse(config.cookie_secure)

    def test_insecure_escape_is_ignored_for_non_loopback_hosts(self):
        with self.assertRaises(SSOConfigError):
            load({**BASE, "PUBLIC_ORIGIN": "http://console.example.com", "ALLOW_INSECURE_LOCALHOST": "true"})

    def test_idle_may_not_exceed_absolute_ttl(self):
        with self.assertRaises(SSOConfigError):
            load({**BASE, "SESSION_TTL_MS": "60000", "SESSION_IDLE_MS": "600000"})

    def test_numeric_ranges_and_boolean_spelling(self):
        self.assertEqual(load({**BASE, "SESSION_TTL_MS": "3600000"}).session_ttl_ms, 3_600_000)
        for bad in ({"MAX_SESSIONS": "0"}, {"OAUTH_TIMEOUT_MS": "10"}, {"SESSION_TTL_MS": "12x"},
                    {"CODEBUDDY2API_SSO_ENABLED": "maybe"}):
            with self.subTest(bad=bad):
                with self.assertRaises(SSOConfigError):
                    load({**BASE, **bad})

    def test_credentials_must_not_carry_whitespace_or_control_characters(self):
        with self.assertRaises(SSOConfigError):
            load({**BASE, "OIDC_CLIENT_SECRET": "secret\nsecond-line"})
        with self.assertRaises(SSOConfigError):
            load({**BASE, "OIDC_CLIENT_ID": " spaced "})


if __name__ == "__main__":
    unittest.main()