"""Independently verify a release checksum/content and boot its extracted app."""

import asyncio
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import tempfile

import httpx


async def main() -> None:
    product = Path(sys.argv[1]).resolve()
    archive = Path(sys.argv[2]).resolve()
    sys.path.insert(0, str(product))
    from scripts.package import inspect_archive, is_denied, safe_extract, verify_archive
    from tests.native_sso_fixture import NativeBackend, SyntheticIdp

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    expected, name = Path(str(archive) + ".sha256").read_text(encoding="utf-8").strip().split()
    assert digest == expected and name == archive.name, "independent checksum mismatch"
    verified = verify_archive(archive)
    members = inspect_archive(archive)
    names = [str(PurePosixPath(member.name).relative_to(verified["prefix"])) for member in members]
    assert all(not is_denied(name) for name in names if name != "."), "denied archive member"
    required = {
        "converter.py", "app/sso_auth.py", "app/sso_config.py", "app/sso_oidc.py",
        "web/dist/index.html", "web/dist/THIRD_PARTY_NOTICES.txt",
        "web/dist/THIRD_PARTY_LICENSES.txt", "web/dist/LICENSE.upstream.txt",
        "web/pnpm-lock.yaml", "web/package.json", "Dockerfile", ".dockerignore",
        "docker-compose.yml", "docker-compose.build.yaml", ".env.example",
    }
    assert required.issubset(names), f"missing required members: {required.difference(names)}"

    with tempfile.TemporaryDirectory(prefix="cb2a-release-smoke-") as temporary:
        extracted = safe_extract(archive, temporary) / verified["prefix"]
        idp = await SyntheticIdp().start()
        backend = NativeBackend(issuer=idp.issuer, repo_root=extracted)
        try:
            await backend.start()
            async with httpx.AsyncClient(base_url=backend.origin, follow_redirects=False, timeout=20) as client:
                assert (await client.get("/health")).status_code == 200
                assert (await client.get("/admin/settings")).status_code == 401
                login = await client.get("/sso/login?return_to=/dashboard/")
                assert login.status_code == 302
                authorize = await client.get(login.headers["location"])
                assert authorize.status_code == 302
                callback = await client.get(authorize.headers["location"])
                assert callback.status_code == 302
                session = await client.get("/sso/session")
                assert session.status_code == 200
                token = session.json()["csrf_token"]
                assert token and session.json()["authenticated"]
                assert (await client.get("/admin/dashboard?days=1")).status_code == 200
                for page in ("/dashboard/", "/dashboard/storage", "/dashboard/settings"):
                    assert (await client.get(page)).status_code == 200, page
                for name in ("LICENSE.upstream.txt", "THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_LICENSES.txt"):
                    response = await client.get(f"/dashboard/{name}")
                    assert response.status_code == 200 and response.headers["content-type"].startswith("text/plain")
                    assert len(response.content) > 40, name
                settings = (await client.get("/admin/settings")).json()
                change = {"revision": settings["revision"], "values": {"max_images": 16}}
                assert (await client.patch("/admin/settings", headers={"Origin": backend.origin}, json=change)).status_code == 403
                headers = {"Origin": backend.origin, "X-CSRF-Token": token}
                assert (await client.patch("/admin/settings", headers=headers, json=change)).status_code == 200
                assert (await client.post("/sso/logout", headers=headers)).status_code in (200, 204)
                assert (await client.get("/admin/settings")).status_code == 401
        finally:
            backend.stop()
            await idp.stop()
    print(json.dumps({"archive": archive.name, "sha256": digest, "files": len(names),
                      "extracted_native_sso": "pass", "notices": "pass", "csrf": "pass", "logout": "pass"}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
