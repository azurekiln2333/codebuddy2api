"""Offline contract between the fork release packager and the WebUI updater."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hashlib
import tempfile
import unittest
from unittest.mock import patch

import httpx

from app import updates
from app.updates import REPOSITORY_URL, Updater
from scripts.package import build_package
from tests.test_updates import UpdaterFixture, release_files


class AssetSelectionTests(unittest.TestCase):
    def release(self, *names):
        return Updater._release({"tag_name": "v1.1.0", "assets": [
            *({"name": name, "browser_download_url": "https://evil.invalid/archive"} for name in names),
            {"name": "SHA256SUMS"},
        ]})

    def test_legacy_and_dated_assets_match_the_tag_exactly(self):
        for name in ("codebuddy2api-1.1.0.tar.gz", "codebuddy2api-v1.1.0-20261107.tar.gz"):
            with self.subTest(name=name):
                release = self.release(name)
                self.assertTrue(release["installable"])
                self.assertEqual(release["archive"], name)
        for name in ("codebuddy2api-v1.1.1-20261107.tar.gz", "codebuddy2api-v1.1.0-20260230.tar.gz",
                     "codebuddy2api-v1.1.0-2026117.tar.gz", "codebuddy2api-v1.1.0-20261107.tar.gz.sig",
                     "../codebuddy2api-v1.1.0-20261107.tar.gz", "codebuddy2api-v1x1x0-20261107.tar.gz"):
            with self.subTest(name=name):
                release = self.release(name)
                self.assertFalse(release["installable"])
                self.assertIsNone(release["archive"])

    def test_newest_dated_asset_wins_over_legacy_and_older_dates(self):
        names = ("codebuddy2api-v1.1.0-20261107.tar.gz", "codebuddy2api-1.1.0.tar.gz",
                 "codebuddy2api-v1.1.0-20261106.tar.gz")
        self.assertEqual(self.release(*names)["archive"], names[0])
        self.assertEqual(self.release(*reversed(names))["archive"], names[0])


class ForkPackageTests(UpdaterFixture):
    def setUp(self):
        super().setUp()
        source = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name, content in {**release_files("1.1.0"), "Dockerfile": "FROM scratch\n",
                              ".dockerignore": "auth/\n"}.items():
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content.encode())
        output = source / "dist"
        manifest = build_package(source, output, date="20261107", tag="v1.1.0", epoch=1,
                                 environ={"GITHUB_SHA": "a" * 40})
        self.archive_name = manifest["archive"]
        self.archive = (output / self.archive_name).read_bytes()
        self.sums = (output / "SHA256SUMS").read_text(encoding="utf-8")

    def releases(self):
        return [{"tag_name": "v1.1.0", "html_url": "https://evil.invalid/release", "assets": [
            {"name": self.archive_name, "digest": f"sha256:{hashlib.sha256(self.archive).hexdigest()}",
             "browser_download_url": "https://evil.invalid/archive"},
            {"name": "codebuddy2api-1.1.0.tar.gz", "digest": "sha256:" + "0" * 64},
            {"name": "SHA256SUMS", "browser_download_url": "https://evil.invalid/checksums"},
        ]}]

    def handler(self, request):
        url = str(request.url)
        self.requests.append(url)
        if url == updates.RELEASES_API:
            return httpx.Response(200, json=self.releases())
        base = f"{self.prefix}{REPOSITORY_URL}/releases/download/v1.1.0/"
        if url == base + self.archive_name:
            return httpx.Response(200, content=self.archive)
        if url == base + "SHA256SUMS":
            return httpx.Response(200, text=self.sums)
        return httpx.Response(404)

    def test_real_package_installs_with_its_checksum_index_and_version_root(self):
        updater = self.updater()
        self.assertEqual(updater.check()["releases"][0]["archive"], self.archive_name)
        updater.install("v1.1.0")
        job = self.wait(updater)
        self.assertEqual(job["status"], "restarting", job)
        self.assertEqual((self.root / "VERSION").read_text().strip(), "1.1.0")
        self.assertTrue((self.root / "web/dist/index.html").is_file())
        self.assertEqual(self.requests, [updates.RELEASES_API,
                         f"{REPOSITORY_URL}/releases/download/v1.1.0/SHA256SUMS",
                         f"{REPOSITORY_URL}/releases/download/v1.1.0/{self.archive_name}"])

    def test_real_package_uses_the_same_selected_asset_for_mirror_probe_and_install(self):
        self.config["update_mirror"] = self.prefix = "https://mirror.invalid/"
        updater = self.updater()
        [probe] = updater.test_mirrors(self.prefix)
        self.assertTrue(probe["ok"], probe)
        updater.install("v1.1.0")
        job = self.wait(updater)
        self.assertEqual(job["status"], "restarting", job)
        expected = f"{self.prefix}{REPOSITORY_URL}/releases/download/v1.1.0/{self.archive_name}"
        self.assertEqual(self.requests.count(expected), 2)
        self.assertFalse(any("evil.invalid" in url for url in self.requests))

    def test_checksum_for_another_asset_cannot_authorize_the_selected_package(self):
        self.sums = f"{hashlib.sha256(self.archive).hexdigest()}  codebuddy2api-1.1.0.tar.gz\n"
        updater = self.updater()
        updater.check()
        with patch.object(updates, "MIRRORS", ()):
            updater.install("v1.1.0")
            job = self.wait(updater)
        self.assertEqual(job["status"], "failed", job)
        self.assertIn("校验失败", job["message"])
        self.assertEqual((self.root / "VERSION").read_text().strip(), "1.0.0")
        self.assertEqual(updater.backups.list(), [])


if __name__ == "__main__":
    unittest.main()
