"""Refresh rotation is serialized per session and can never beat a logout."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asyncio
import unittest
from urllib.parse import parse_qs, urlsplit

import httpx

from app.sso_auth import SESSION_COOKIE
from tests.sso_fixture import FakeIdp, build_sso_app, sso_settings

ORIGIN = {"Origin": "http://localhost"}


class RefreshRaceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.idp = FakeIdp(refresh_token="rt-1", expires_in=0, refresh_expires_in=3600)
        settings = sso_settings(OIDC_REFRESH="true")
        self.app, self.service, self.config = build_sso_app(self.idp, settings)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                        base_url="http://localhost")
        self.addAsyncCleanup(self.client.aclose)

    async def login(self):
        response = await self.client.get("/sso/login?return_to=/dashboard/")
        params = {k: v[0] for k, v in parse_qs(urlsplit(response.headers["location"]).query).items()}
        code = self.idp.issue_code(params["nonce"])
        response = await self.client.get(f"/sso/callback?code={code}&state={params['state']}")
        self.assertEqual(response.status_code, 302, response.text)
        sid = self.client.cookies.get(SESSION_COOKIE)
        self.assertIsNotNone(sid)
        return sid

    async def test_concurrent_requests_share_a_single_refresh(self):
        sid = await self.login()
        self.idp.refresh_gate = asyncio.Event()
        self.idp.refresh_started = asyncio.Event()

        first = asyncio.create_task(self.client.get("/sso/session"))
        second = asyncio.create_task(self.client.get("/sso/session"))
        await self.idp.refresh_started.wait()
        self.idp.refresh_gate.set()
        responses = await asyncio.gather(first, second)

        self.assertEqual([r.status_code for r in responses], [200, 200])
        self.assertEqual(self.idp.refresh_calls, 1)
        self.assertTrue(self.service.sessions[sid].access_token_expires_at > 0)

    async def test_logout_during_refresh_wins(self):
        sid = await self.login()
        csrf = self.service.sessions[sid].csrf_token
        self.idp.refresh_gate = asyncio.Event()
        self.idp.refresh_started = asyncio.Event()

        pending = asyncio.create_task(self.client.get("/sso/session"))
        await self.idp.refresh_started.wait()
        logout = await self.client.post("/sso/logout", headers={**ORIGIN, "X-CSRF-Token": csrf})
        self.assertEqual(logout.status_code, 200)
        self.idp.refresh_gate.set()
        response = await pending

        # The in-flight authorization must not resurrect the logged-out session.
        self.assertEqual(response.status_code, 401)
        self.assertNotIn(sid, self.service.sessions)
        again = await self.client.get("/sso/session")
        self.assertEqual(again.status_code, 401)

    async def test_failed_refresh_destroys_the_session(self):
        sid = await self.login()
        self.idp.refresh_token = "different-token"  # provider rejects the rotation
        response = await self.client.get("/sso/session")
        self.assertEqual(response.status_code, 403)
        self.assertNotIn(sid, self.service.sessions)

    async def test_valid_access_token_is_not_refreshed(self):
        self.idp.expires_in = 3600
        self.idp.refresh_expires_in = None
        sid = await self.login()
        self.assertEqual((await self.client.get("/sso/session")).status_code, 200)
        self.assertEqual(self.idp.refresh_calls, 0)
        self.assertTrue(self.service.sessions[sid].refresh_token)


if __name__ == "__main__":
    unittest.main()