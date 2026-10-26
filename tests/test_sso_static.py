"""Native static hosting for the replacement UI: pages, licences and notices."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tempfile
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway_management import install_pages

# The replacement UI build emits exactly these documents at the dist root.
BUILD_DOCUMENTS = ("LICENSE.upstream.txt", "THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_LICENSES.txt")
REAL_DIST = Path(__file__).resolve().parents[1] / "web" / "dist"


def build_app(root: Path) -> TestClient:
    app = FastAPI()
    install_pages(app, root)
    return TestClient(app)


class PagesTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (self.root / "assets").mkdir()
        (self.root / "assets" / "app.js").write_text("console.log('ui');")
        (self.root / "licenses").mkdir()
        (self.root / "licenses" / "DM-Sans.txt").write_text("OFL-1.1 text")
        (self.root / "index.html").write_text("<html>ui-shell</html>")
        for name in BUILD_DOCUMENTS:
            (self.root / name).write_text(f"{name} body")
        self.client = self.enterContext(build_app(self.root))

    def test_storage_page_is_part_of_the_shell_whitelist(self):
        for page in ("", "/", "/models", "/credentials", "/logs", "/settings", "/storage", "/login"):
            with self.subTest(page=page):
                response = self.client.get("/dashboard" + page)
                self.assertEqual(response.status_code, 200, page)
                self.assertIn("ui-shell", response.text)
                self.assertEqual(response.headers["cache-control"], "no-store")

    def test_unknown_page_redirects_and_assets_never_fall_back_to_the_shell(self):
        self.assertEqual(self.client.get("/dashboard/nope", follow_redirects=False).status_code, 302)
        for path in ("/dashboard/assets", "/dashboard/assets/", "/dashboard/licenses",
                     "/dashboard/licenses/", "/dashboard/assets/missing.js"):
            with self.subTest(path=path):
                response = self.client.get(path, follow_redirects=False)
                self.assertEqual(response.status_code, 404)
                self.assertNotIn("ui-shell", response.text)

    def test_assets_use_the_immutable_cache(self):
        response = self.client.get("/dashboard/assets/app.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("immutable", response.headers["cache-control"])
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    def test_licence_texts_are_served_for_the_shipped_ui(self):
        response = self.client.get("/dashboard/licenses/DM-Sans.txt")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, "OFL-1.1 text")
        self.assertIn("max-age", response.headers["cache-control"])
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    def test_build_documents_are_served_as_plain_text(self):
        for name in BUILD_DOCUMENTS:
            with self.subTest(name=name):
                response = self.client.get(f"/dashboard/{name}")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.text, f"{name} body")
                self.assertIn("text/plain", response.headers["content-type"])
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")
                self.assertIn("max-age", response.headers["cache-control"])

    def test_legacy_markdown_notices_still_work_but_are_not_required(self):
        # A build that ships the Markdown variant keeps working.
        (self.root / "THIRD_PARTY_NOTICES.md").write_text("# Third-party notices")
        response = self.client.get("/dashboard/THIRD_PARTY_NOTICES.md")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/markdown", response.headers["content-type"])
        # The Markdown variant is optional: dropping it must not break anything else.
        (self.root / "THIRD_PARTY_NOTICES.md").unlink()
        self.assertEqual(self.client.get("/dashboard/THIRD_PARTY_NOTICES.md").status_code, 404)
        self.assertEqual(self.client.get("/dashboard/THIRD_PARTY_NOTICES.txt").status_code, 200)

    def test_api_surfaces_never_redirect_to_the_shell(self):
        for path in ("/sso/missing", "/sso/login/extra", "/admin/missing", "/v1/missing",
                     "/health/missing", "/assets/missing.js"):
            with self.subTest(path=path):
                response = self.client.get(path, follow_redirects=False)
                self.assertEqual(response.status_code, 404, path)
                self.assertNotIn("ui-shell", response.text)

    def test_static_requests_stay_inside_their_directories(self):
        for path in ("/dashboard/licenses/%2e%2e/index.html",
                     "/dashboard/licenses/%2e%2e/assets/app.js",
                     "/dashboard/assets/%2e%2e/licenses/DM-Sans.txt"):
            with self.subTest(path=path):
                response = self.client.get(path, follow_redirects=False)
                self.assertEqual(response.status_code, 404)
                self.assertNotIn("ui-shell", response.text)
                self.assertNotIn("OFL-1.1", response.text)


@unittest.skipUnless((REAL_DIST / "index.html").is_file(), "web/dist has not been built")
class RealBuildTests(unittest.TestCase):
    """Verify the document routes against the artifact the UI actually ships."""

    def setUp(self):
        self.client = self.enterContext(build_app(REAL_DIST))

    def test_every_build_document_the_build_emits_is_reachable(self):
        emitted = [name for name in BUILD_DOCUMENTS if (REAL_DIST / name).is_file()]
        self.assertTrue(emitted, "web/dist is missing the licence documents")
        for name in emitted:
            with self.subTest(name=name):
                response = self.client.get(f"/dashboard/{name}")
                self.assertEqual(response.status_code, 200, name)
                self.assertGreater(len(response.content), 0)
                self.assertIn("text/plain", response.headers["content-type"])

    def test_the_shell_and_assets_from_the_real_build_are_served(self):
        shell = self.client.get("/dashboard/storage")
        self.assertEqual(shell.status_code, 200)
        index = (REAL_DIST / "index.html").read_text(encoding="utf-8")
        self.assertEqual(shell.text, index)
        self.assertEqual(self.client.get("/dashboard/nope", follow_redirects=False).status_code, 302)


if __name__ == "__main__":
    unittest.main()