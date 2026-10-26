"""Native OIDC client: discovery, PKCE, RS256 verification and bounded I/O."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asyncio
import base64
import hashlib
import time
import unittest

from app.sso_oidc import OidcClient, OidcError, code_challenge, create_code_verifier
from tests.sso_fixture import CLIENT_ID, CLIENT_SECRET, FakeIdp, sso_settings


def client_for(idp, **overrides):
    return OidcClient(sso_settings(**overrides), transport=idp.transport())


class PkceTests(unittest.TestCase):
    def test_verifier_and_s256_challenge_shape(self):
        verifier = create_code_verifier()
        self.assertRegex(verifier, r"^[A-Za-z0-9_-]{43,}$")
        digest = hashlib.sha256(verifier.encode("ascii")).digest()
        self.assertEqual(code_challenge(verifier), base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii"))


class OidcClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.idp = FakeIdp()
        self.client = client_for(self.idp)
        self.addAsyncCleanup(self.client.aclose)

    async def login_tokens(self, idp=None, client=None):
        idp = idp or self.idp
        client = client or self.client
        await client.build_authorize_url(
            redirect_uri="http://localhost/sso/callback", state="s", nonce="n", verifier="v")
        code = idp.issue_code("n")
        tokens = await client.exchange_code(
            code=code, redirect_uri="http://localhost/sso/callback", verifier="v")
        return tokens

    async def test_discovery_is_cached(self):
        await self.client.build_authorize_url(redirect_uri="http://localhost/sso/callback",
                                              state="s", nonce="n", verifier="v")
        await self.client.build_authorize_url(redirect_uri="http://localhost/sso/callback",
                                              state="s2", nonce="n2", verifier="v2")
        self.assertEqual(self.idp.discovery_calls, 1)

    async def test_authorize_url_carries_pkce_and_no_prompt(self):
        url = await self.client.build_authorize_url(
            redirect_uri="http://localhost/sso/callback", state="st", nonce="no", verifier="verifier-value")
        self.assertIn("code_challenge_method=S256", url)
        self.assertIn("response_type=code", url)
        self.assertNotIn("prompt=", url)
        self.assertNotIn("max_age=", url)
        self.assertIn("scope=openid+profile+roles", url)

    async def test_issuer_mismatch_is_rejected(self):
        idp = FakeIdp(discovery_issuer="https://other.example.com")
        client = client_for(idp)
        self.addAsyncCleanup(client.aclose)
        with self.assertRaises(OidcError) as raised:
            await client.build_authorize_url(redirect_uri="http://localhost/sso/callback",
                                             state="s", nonce="n", verifier="v")
        self.assertEqual(raised.exception.code, "issuer_mismatch")

    async def test_off_origin_endpoint_is_rejected(self):
        idp = FakeIdp(discovery_overrides={"token_endpoint": "https://evil.invalid/token"})
        client = client_for(idp)
        self.addAsyncCleanup(client.aclose)
        with self.assertRaises(OidcError) as raised:
            await client.build_authorize_url(redirect_uri="http://localhost/sso/callback",
                                             state="s", nonce="n", verifier="v")
        self.assertEqual(raised.exception.code, "discovery_invalid")

    async def test_non_rs256_provider_is_rejected(self):
        idp = FakeIdp(signing_alg="HS256")
        client = client_for(idp)
        self.addAsyncCleanup(client.aclose)
        with self.assertRaises(OidcError) as raised:
            await client.build_authorize_url(redirect_uri="http://localhost/sso/callback",
                                             state="s", nonce="n", verifier="v")
        self.assertEqual(raised.exception.code, "rs256_unsupported")

    async def test_unsupported_token_auth_method_is_rejected_before_network(self):
        idp = FakeIdp(token_auth_methods=("private_key_jwt",))
        client = client_for(idp)
        self.addAsyncCleanup(client.aclose)
        idp.issue_code("n")
        with self.assertRaises(OidcError) as raised:
            await client.exchange_code(code="code-1-x", redirect_uri="http://localhost/sso/callback", verifier="v")
        self.assertEqual(raised.exception.code, "token_auth_unsupported")

    async def test_basic_auth_sends_secret_only_in_header(self):
        idp = FakeIdp(token_auth_methods=("client_secret_basic",))
        client = client_for(idp)
        self.addAsyncCleanup(client.aclose)
        tokens = await self.login_tokens()
        self.assertTrue(tokens.access_token)
        request = self.idp.token_requests[-1]
        self.assertTrue(request["authorization"].startswith("Basic "))
        decoded = base64.b64decode(request["authorization"][6:]).decode()
        self.assertEqual(decoded, f"{CLIENT_ID}:{CLIENT_SECRET}")
        self.assertNotIn("client_secret", request["form"])

    async def test_post_auth_sends_secret_only_in_body(self):
        idp = FakeIdp(token_auth_methods=("client_secret_post",))
        client = client_for(idp)
        self.addAsyncCleanup(client.aclose)
        await self.login_tokens(idp, client)
        request = idp.token_requests[-1]
        self.assertIsNone(request["authorization"])
        self.assertEqual(request["form"]["client_secret"], CLIENT_SECRET)

    async def test_exchange_sets_absolute_expiry_and_requires_id_token(self):
        tokens = await self.login_tokens()
        self.assertIsNotNone(tokens.id_token)
        self.assertGreater(tokens.expires_at, time.time() - 1)

    async def test_token_redirect_is_denied(self):
        idp = FakeIdp(token_redirect=True)
        client = client_for(idp)
        self.addAsyncCleanup(client.aclose)
        idp.issue_code("n")
        with self.assertRaises(OidcError) as raised:
            await client.exchange_code(code="code-1-x", redirect_uri="http://localhost/sso/callback", verifier="v")
        self.assertEqual(raised.exception.code, "oidc_redirect_denied")

    async def test_id_token_verification_accepts_a_valid_token(self):
        tokens = await self.login_tokens()
        claims = await self.client.verify_id_token(id_token=tokens.id_token, nonce="n")
        self.assertEqual(claims["sub"], "admin-1")

    async def test_verify_rejects_nonce_iat_and_subject_mismatches(self):
        idp = FakeIdp()
        client = client_for(idp)
        self.addAsyncCleanup(client.aclose)
        await client.build_authorize_url(redirect_uri="http://localhost/sso/callback",
                                         state="s", nonce="n", verifier="v")
        with self.assertRaises(OidcError) as raised:
            await client.verify_id_token(id_token=idp.sign(nonce="other"), nonce="n")
        self.assertEqual(raised.exception.code, "nonce_mismatch")
        with self.assertRaises(OidcError) as raised:
            await client.verify_id_token(id_token=idp.sign(nonce="n"), nonce="n", expected_sub="someone-else")
        self.assertEqual(raised.exception.code, "subject_mismatch")
        future = idp.sign(nonce="n", overrides={"iat": int(time.time()) + 3600})
        with self.assertRaises(OidcError) as raised:
            await client.verify_id_token(id_token=future, nonce="n")
        self.assertEqual(raised.exception.code, "iat_in_future")

    async def test_verify_rejects_audience_and_azp_mismatch(self):
        idp = FakeIdp()
        client = client_for(idp)
        self.addAsyncCleanup(client.aclose)
        await client.build_authorize_url(redirect_uri="http://localhost/sso/callback",
                                         state="s", nonce="n", verifier="v")
        with self.assertRaises(OidcError):
            await client.verify_id_token(id_token=idp.sign(nonce="n", overrides={"aud": "another-client"}),
                                         nonce="n")
        with self.assertRaises(OidcError) as raised:
            await client.verify_id_token(id_token=idp.sign(nonce="n", overrides={"azp": "another-client"}),
                                         nonce="n")
        self.assertEqual(raised.exception.code, "azp_mismatch")
        # Multiple audiences without `azp` are rejected, per the gateway contract.
        idp.id_token_overrides = {"azp": None}
        with self.assertRaises(OidcError) as raised:
            await client.verify_id_token(
                id_token=idp.sign(nonce="n", overrides={"aud": [CLIENT_ID, "another-client"], "azp": None}),
                nonce="n")
        self.assertEqual(raised.exception.code, "azp_missing")

    async def test_verify_rejects_a_non_rs256_signed_token(self):
        idp = FakeIdp()
        client = client_for(idp)
        self.addAsyncCleanup(client.aclose)
        await client.build_authorize_url(redirect_uri="http://localhost/sso/callback",
                                         state="s", nonce="n", verifier="v")
        idp.signing_alg = "HS256"
        with self.assertRaises(OidcError) as raised:
            await client.verify_id_token(id_token=idp.sign(nonce="n"), nonce="n")
        self.assertEqual(raised.exception.code, "id_token_invalid")

    async def test_userinfo_success_and_failure(self):
        tokens = await self.login_tokens()
        info = await self.client.user_info(tokens.access_token)
        self.assertEqual((info.sub, info.role, info.is_admin), ("admin-1", "admin", True))
        offline = FakeIdp(offline_userinfo=True, userinfo_status=503)
        client = client_for(offline)
        self.addAsyncCleanup(client.aclose)
        with self.assertRaises(OidcError) as raised:
            await client.user_info("at-unknown")
        self.assertEqual(raised.exception.code, "userinfo_failed")

    async def test_oversized_json_response_is_rejected(self):
        idp = FakeIdp(pad_discovery_bytes=300 * 1024)
        client = client_for(idp)
        self.addAsyncCleanup(client.aclose)
        with self.assertRaises(OidcError) as raised:
            await client.build_authorize_url(redirect_uri="http://localhost/sso/callback",
                                             state="s", nonce="n", verifier="v")
        self.assertEqual(raised.exception.code, "response_too_large")


class TimeoutTests(unittest.IsolatedAsyncioTestCase):
    async def test_hung_provider_times_out_with_a_fixed_code(self):
        idp = FakeIdp()

        async def slow(request):
            await asyncio.sleep(5)
            return await FakeIdp.handle(idp, request)

        idp.handle = slow
        client = OidcClient(sso_settings(OAUTH_TIMEOUT_MS="100"), transport=idp.transport())
        self.addAsyncCleanup(client.aclose)
        with self.assertRaises(OidcError) as raised:
            await client.build_authorize_url(redirect_uri="http://localhost/sso/callback",
                                             state="s", nonce="n", verifier="v")
        self.assertIn(raised.exception.code, ("discovery_failed", "discovery_timeout"))


if __name__ == "__main__":
    unittest.main()