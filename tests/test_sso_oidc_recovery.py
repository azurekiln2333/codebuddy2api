"""Regressions for discovery recovery and JWKS lifetime in the native OIDC client.

Both cases were real defects: a single failed discovery disabled SSO for the
life of the process, and a cached signing key was served forever, so key
revocation and rotation never took effect. These tests drive the real
``OidcClient`` against the synthetic provider and assert the observable
behaviour (how many network calls happen, and whether verification flips).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asyncio
import unittest
from unittest import mock

from app import sso_oidc
from app.sso_oidc import OidcClient, OidcError
from tests.sso_fixture import FakeIdp, sso_settings

REDIRECT_URI = "http://localhost/sso/callback"


class DiscoveryRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_transient_discovery_failure_is_retried(self):
        idp = FakeIdp(discovery_failures=1)
        client = OidcClient(sso_settings(), transport=idp.transport())
        self.addAsyncCleanup(client.aclose)

        with self.assertRaises(OidcError) as raised:
            await client.build_authorize_url(redirect_uri=REDIRECT_URI, state="s", nonce="n", verifier="v")
        self.assertEqual(raised.exception.code, "discovery_failed")
        self.assertEqual(idp.discovery_calls, 1)

        # The provider recovers: the very next request must succeed, not stay locked.
        url = await client.build_authorize_url(redirect_uri=REDIRECT_URI, state="s2", nonce="n2", verifier="v2")
        self.assertIn("code_challenge_method=S256", url)
        self.assertEqual(idp.discovery_calls, 2)

    async def test_recovery_also_works_after_several_failures(self):
        idp = FakeIdp(discovery_failures=3)
        client = OidcClient(sso_settings(), transport=idp.transport())
        self.addAsyncCleanup(client.aclose)

        for attempt in range(3):
            with self.subTest(attempt=attempt):
                with self.assertRaises(OidcError):
                    await client.build_authorize_url(redirect_uri=REDIRECT_URI,
                                                     state="s", nonce="n", verifier="v")
        await client.build_authorize_url(redirect_uri=REDIRECT_URI, state="s", nonce="n", verifier="v")
        self.assertEqual(idp.discovery_calls, 4)

    async def test_successful_discovery_is_still_cached(self):
        idp = FakeIdp()
        client = OidcClient(sso_settings(), transport=idp.transport())
        self.addAsyncCleanup(client.aclose)
        for _ in range(3):
            await client.build_authorize_url(redirect_uri=REDIRECT_URI, state="s", nonce="n", verifier="v")
        self.assertEqual(idp.discovery_calls, 1)


class JwksLifetimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.idp = FakeIdp()
        self.client = OidcClient(sso_settings(), transport=self.idp.transport())
        self.addAsyncCleanup(self.client.aclose)
        await self.client.build_authorize_url(redirect_uri=REDIRECT_URI, state="s", nonce="n", verifier="v")

    def age_the_jwks_cache(self, seconds: float) -> None:
        """Pretend the key set was fetched ``seconds`` ago."""
        self.client._jwks_fetched_at -= seconds
        self.client._jwks_attempt_at -= seconds

    async def test_a_fresh_key_set_is_reused_without_another_fetch(self):
        for _ in range(3):
            await self.client.verify_id_token(id_token=self.idp.sign(nonce="n"), nonce="n")
        self.assertEqual(self.idp.jwks_calls, 1)

    async def test_an_expired_key_set_is_refetched(self):
        await self.client.verify_id_token(id_token=self.idp.sign(nonce="n"), nonce="n")
        self.assertEqual(self.idp.jwks_calls, 1)

        self.age_the_jwks_cache(sso_oidc.JWKS_CACHE_SECONDS + 1)
        await self.client.verify_id_token(id_token=self.idp.sign(nonce="n"), nonce="n")
        self.assertEqual(self.idp.jwks_calls, 2)

    async def test_a_revoked_key_stops_verifying_after_the_cache_expires(self):
        # A second key keeps the published JWKS non-empty once the first is revoked.
        self.idp.publish_key("surviving-key")
        token = self.idp.sign(nonce="n")
        await self.client.verify_id_token(id_token=token, nonce="n")

        # The provider revokes the key but keeps serving a valid JWKS document.
        self.idp.omit_kids.add(self.idp.kid)
        # Still inside the freshness window: the cached key keeps working.
        await self.client.verify_id_token(id_token=token, nonce="n")
        self.assertEqual(self.idp.jwks_calls, 1)

        self.age_the_jwks_cache(sso_oidc.JWKS_CACHE_SECONDS + 1)
        with self.assertRaises(OidcError) as raised:
            await self.client.verify_id_token(id_token=token, nonce="n")
        self.assertEqual(raised.exception.code, "id_token_invalid")
        self.assertEqual(self.idp.jwks_calls, 2)

    async def test_a_rotated_key_is_picked_up_after_the_cache_expires(self):
        key = self.idp.publish_key("rotated-key")
        token = self.idp.sign(nonce="n", key=key, kid="rotated-key")

        # The unknown kid forces one fetch, which already carries the rotated key.
        await self.client.verify_id_token(id_token=token, nonce="n")
        self.assertEqual(self.idp.jwks_calls, 1)

        rotated = self.idp.publish_key("rotated-again")
        self.age_the_jwks_cache(sso_oidc.JWKS_CACHE_SECONDS + 1)
        await self.client.verify_id_token(id_token=self.idp.sign(nonce="n", key=rotated, kid="rotated-again"),
                                          nonce="n")
        self.assertEqual(self.idp.jwks_calls, 2)

    async def test_an_unknown_kid_is_refetched_but_rate_limited(self):
        await self.client.verify_id_token(id_token=self.idp.sign(nonce="n"), nonce="n")
        self.assertEqual(self.idp.jwks_calls, 1)

        # A bogus kid right after a fetch is suppressed by the cooldown.
        with self.assertRaises(OidcError) as raised:
            await self.client.verify_id_token(id_token=self.idp.sign(nonce="n", kid="bogus"), nonce="n")
        self.assertEqual(raised.exception.code, "id_token_invalid")
        self.assertEqual(self.idp.jwks_calls, 1)

        # Once the cooldown passes, exactly one refetch happens...
        self.age_the_jwks_cache(sso_oidc.JWKS_COOLDOWN_SECONDS + 1)
        for _ in range(4):
            with self.assertRaises(OidcError):
                await self.client.verify_id_token(id_token=self.idp.sign(nonce="n", kid="bogus"), nonce="n")
        self.assertEqual(self.idp.jwks_calls, 2)

        # The cooldown starts again, so a new key is still discovered in time.
        key = self.idp.publish_key("late-key")
        self.age_the_jwks_cache(sso_oidc.JWKS_COOLDOWN_SECONDS + 1)
        await self.client.verify_id_token(id_token=self.idp.sign(nonce="n", key=key, kid="late-key"), nonce="n")
        self.assertEqual(self.idp.jwks_calls, 3)

    async def test_a_failed_refetch_is_also_throttled(self):
        await self.client.verify_id_token(id_token=self.idp.sign(nonce="n"), nonce="n")
        self.idp.jwks_status = 503
        self.age_the_jwks_cache(sso_oidc.JWKS_CACHE_SECONDS + 1)

        with self.assertRaises(OidcError):
            await self.client.verify_id_token(id_token=self.idp.sign(nonce="n"), nonce="n")
        first = self.idp.jwks_calls
        with self.assertRaises(OidcError):
            await self.client.verify_id_token(id_token=self.idp.sign(nonce="n"), nonce="n")
        self.assertEqual(self.idp.jwks_calls, first)

    async def test_short_ttl_configuration_behaves_the_same(self):
        with mock.patch.object(sso_oidc, "JWKS_CACHE_SECONDS", 0.05), \
                mock.patch.object(sso_oidc, "JWKS_COOLDOWN_SECONDS", 0.0):
            await self.client.verify_id_token(id_token=self.idp.sign(nonce="n"), nonce="n")
            calls = self.idp.jwks_calls
            await asyncio.sleep(0.1)
            await self.client.verify_id_token(id_token=self.idp.sign(nonce="n"), nonce="n")
            self.assertEqual(self.idp.jwks_calls, calls + 1)


if __name__ == "__main__":
    unittest.main()