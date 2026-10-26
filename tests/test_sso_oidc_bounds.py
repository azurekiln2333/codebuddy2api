"""Real-socket bounds for the OIDC client's outbound I/O.

The original client used a buffered ``client.request`` and only capped the bytes
after the whole response was already in memory, so ``MAX_JSON_BYTES`` was
decorative. These tests use a real TCP listener and assert the observable
consequence: the provider cannot deliver an oversized body because the client
stops reading, and a stalled body is cut off by the deadline.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asyncio
import time
import unittest

from app.sso_oidc import MAX_JSON_BYTES, OidcClient, OidcError
from tests.sso_fixture import sso_settings

REDIRECT_URI = "http://localhost/sso/callback"


class RawJsonServer:
    """Minimal HTTP/1.1 listener that streams an arbitrarily large JSON body."""

    def __init__(self, body_size: int, *, chunk: int = 64 * 1024, stall_after: int | None = None):
        self.body_size = body_size
        self.chunk = chunk
        self.stall_after = stall_after
        self.max_written = 0
        self.completed = False
        self.aborted = False
        self._server: asyncio.AbstractServer | None = None
        self._tasks: set[asyncio.Task] = set()
        self.issuer = ""

    async def start(self) -> "RawJsonServer":
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        port = self._server.sockets[0].getsockname()[1]
        self.issuer = f"http://127.0.0.1:{port}"
        return self

    async def stop(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._server is not None:
            self._server.close()
            try:
                await self._server.wait_closed()
            except Exception:
                pass

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._tasks.add(task)
        try:
            await self._serve(reader, writer)
        finally:
            if task is not None:
                self._tasks.discard(task)

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await reader.readuntil(b"\r\n\r\n")
        except Exception:
            writer.close()
            return
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"content-type: application/json\r\n"
            b"content-length: " + str(self.body_size).encode() + b"\r\n"
            b"\r\n"
        )
        written = 0
        try:
            while written < self.body_size:
                if self.stall_after is not None and written >= self.stall_after:
                    await asyncio.sleep(30)  # never finishes the declared body
                    break
                size = min(self.chunk, self.body_size - written)
                writer.write(b"x" * size)
                await writer.drain()
                written += size
                self.max_written = max(self.max_written, written)
            else:
                self.completed = True
        except (ConnectionResetError, BrokenPipeError, OSError):
            self.aborted = True
        finally:
            self.max_written = max(self.max_written, written)
            try:
                writer.close()
            except Exception:
                pass


class StreamingBoundTests(unittest.IsolatedAsyncioTestCase):
    async def boot(self, *, timeout_ms: str | None = None, **kwargs):
        server = await RawJsonServer(**kwargs).start()
        self.addAsyncCleanup(server.stop)
        env = {"OIDC_ISSUER": server.issuer}
        if timeout_ms is not None:
            env["OAUTH_TIMEOUT_MS"] = timeout_ms
        client = OidcClient(sso_settings(**env))
        self.addAsyncCleanup(client.aclose)
        return server, client

    async def test_an_oversized_body_is_aborted_instead_of_buffered(self):
        body_size = 8 * 1024 * 1024
        server, client = await self.boot(body_size=body_size)
        with self.assertRaises(OidcError) as raised:
            await client.build_authorize_url(redirect_uri=REDIRECT_URI, state="s", nonce="n", verifier="v")
        self.assertEqual(raised.exception.code, "response_too_large")
        # The cap is enforced while reading: the provider never got to deliver the
        # whole body, which is only possible with a streamed response.
        self.assertLess(server.max_written, body_size // 2)
        self.assertFalse(server.completed)
        self.assertLess(server.max_written, 2 * MAX_JSON_BYTES + 1024 * 1024)

    async def test_a_body_just_under_the_cap_is_still_accepted(self):
        server, client = await self.boot(body_size=1024)
        # Valid JSON inside the cap is parsed normally (discovery then fails on
        # schema, which proves the body itself was read and decoded).
        with self.assertRaises(OidcError) as raised:
            await client.build_authorize_url(redirect_uri=REDIRECT_URI, state="s", nonce="n", verifier="v")
        self.assertEqual(raised.exception.code, "discovery_failed")
        self.assertTrue(server.completed)

    async def test_a_stalled_body_is_cut_off_by_the_deadline(self):
        # 300 ms is well below the stall, so the cut-off can only come from the
        # deadline wrapping the body read.
        server, client = await self.boot(body_size=4 * 1024 * 1024, stall_after=1024, timeout_ms="300")
        started = time.monotonic()
        with self.assertRaises(OidcError) as raised:
            await client.build_authorize_url(redirect_uri=REDIRECT_URI, state="s", nonce="n", verifier="v")
        elapsed = time.monotonic() - started
        self.assertIn(raised.exception.code, ("discovery_failed", "discovery_timeout"))
        self.assertLess(elapsed, 3.0, "the deadline must cover the body read, not just connect")
        self.assertFalse(server.completed)


class TimeoutDeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_configured_timeout_bounds_a_slow_stream(self):
        server = await RawJsonServer(body_size=4 * 1024 * 1024, stall_after=0).start()
        self.addAsyncCleanup(server.stop)
        client = OidcClient(sso_settings(OIDC_ISSUER=server.issuer, OAUTH_TIMEOUT_MS="200"))
        self.addAsyncCleanup(client.aclose)
        started = time.monotonic()
        with self.assertRaises(OidcError):
            await client.build_authorize_url(redirect_uri=REDIRECT_URI, state="s", nonce="n", verifier="v")
        self.assertLess(time.monotonic() - started, 3.0)


if __name__ == "__main__":
    unittest.main()