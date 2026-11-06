"""Contract tests for the release archive: allowlist, denylist, hashes, safety."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import hashlib
import io
import json
import tarfile
import tempfile
import unittest

from scripts import package

DATE = "20260101"
EPOCH = 0


def write(path, text=""):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def build_fixture(root, version="1.2.3"):
    """Create a minimal but realistic repository tree, plus decoy secrets."""
    root = Path(root)
    # Required runtime payload.
    write(root / "VERSION", f"{version}\n")
    write(root / "converter.py", "APP_VERSION = 'x'\n")
    write(root / "requirements.txt", "fastapi==1.0\n")
    write(root / "Dockerfile", "FROM python:3.12\n")
    write(root / ".dockerignore", "**\n")
    write(root / "app/__init__.py")
    write(root / "app/gateway_management.py")
    # Derived metadata and deployment templates.
    write(root / "pyproject.toml", f'[project]\nname = "x"\nversion = "{version}"\n')
    write(root / "requirements.in", "fastapi>=1.0\n")
    write(root / "uv.lock", "version = 1\n")
    write(root / "LICENSE", "MIT\n")
    write(root / "README.md", "# x\n")
    write(root / "docker-compose.yml",
          "services:\n  codebuddy2api:\n    image: codebuddy2api:latest\n")
    write(root / "docker-compose.build.yaml", "services: {}\n")
    write(root / ".env.example", "CODEBUDDY2API_KEY=\n")
    # Console build output plus rebuildable sources and lockfile.
    write(root / "web/dist/index.html", "<html></html>\n")
    write(root / "web/dist/assets/app.js", "console.log(1)\n")
    write(root / "web/src/main.tsx", "export {};\n")
    write(root / "web/package.json", '{"name": "x", "private": true}\n')
    write(root / "web/pnpm-lock.yaml", "lockfileVersion: 9\n")
    write(root / "web/index.html", "<html></html>\n")
    write(root / "web/vite.config.ts", "export default {}\n")
    # Shared scripts and documentation.
    write(root / "scripts/check_version.py", "")
    write(root / "scripts/package.py", "")
    write(root / "docs/deployment.md", "# deploy\n")
    # Decoys that must never ship.
    write(root / ".env", "SECRET=1\n")
    write(root / "auth/creds.info", "token\n")
    write(root / "logs.sqlite3", "db\n")
    write(root / "logs.sqlite3-wal", "wal\n")
    write(root / "converter.log", "log\n")
    write(root / ".trellis/tasks/task.json", "{}\n")
    write(root / ".agents/skill.md", "agent\n")
    write(root / "AGENTS.md", "agent\n")
    write(root / "tests/test_version.py", "# test\n")
    write(root / "local.zip", "zip\n")
    write(root / "examples/demo.py", "x\n")
    write(root / "docs/plans/plan.md", "plan\n")
    write(root / "web/node_modules/pkg/index.js", "x\n")
    write(root / "web/.env", "SECRET\n")
    write(root / "web/test-results/report.json", "{}\n")
    # Local scaffolding: untracked scratch helpers and tool output that a
    # developer can drop anywhere under the allowlisted `web/` tree. These must
    # be pruned by the denylist, not by luck of the current checkout.
    write(root / "web/.tmp-reference.mjs", "import './src/main.tsx';\n")
    write(root / "web/.tmp/visual.mjs", "export {};\n")
    write(root / "web/.tmp-shots/home.png", "png\n")
    write(root / "web/.venv-ci/bin/python", "x\n")
    write(root / "web/playwright-report/index.html", "<html></html>\n")
    write(root / "web/blob-report/report.json", "{}\n")
    write(root / "web/coverage/index.html", "<html></html>\n")
    write(root / "web/e2e/login.spec.ts", "export {};\n")
    write(root / "web/e2e/-tmp-state/state.json", "{}\n")
    write(root / "web/.eslintcache", "{}\n")
    write(root / "scripts/herdr-auto-yes.ps1", "x\n")
    return root


def build(root, output, **kwargs):
    options = {"date": DATE, "epoch": EPOCH, "environ": {}}
    options.update(kwargs)
    return package.build_package(root, output, **options)


def craft(archive, *, name, data=b"payload", symlink=None):
    with tarfile.open(archive, "w:gz") as tar:
        info = tarfile.TarInfo(name)
        if symlink is not None:
            info.type = tarfile.SYMTYPE
            info.linkname = symlink
            info.size = 0
            tar.addfile(info)
        else:
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


class ReleasePackageTests(unittest.TestCase):
    def test_archive_name_manifest_and_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            output = Path(directory) / "dist"
            manifest = build(root, output)

            self.assertEqual(manifest["archive"], "codebuddy2api-v1.2.3-20260101.tar.gz")
            self.assertEqual(manifest["prefix"], "codebuddy2api-1.2.3")
            self.assertEqual(manifest["tag"], "v1.2.3")
            self.assertFalse(manifest["prerelease"])

            archive = output / manifest["archive"]
            self.assertTrue(archive.is_file())
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            self.assertEqual(digest, manifest["sha256"])
            recorded = (output / f"{manifest['archive']}.sha256").read_text().split()[0]
            self.assertEqual(recorded, digest)
            self.assertEqual((output / "SHA256SUMS").read_text(),
                             f"{digest}  {manifest['archive']}\n")
            self.assertTrue((output / "build-manifest.json").is_file())
            self.assertIn("codebuddy2api v1.2.3", (output / "release-notes.md").read_text())
            self.assertEqual(json.loads((output / "build-manifest.json").read_text())["sha256"], digest)

    def test_allowlist_includes_backend_console_and_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            output = Path(directory) / "dist"
            manifest = build(root, output)
            names = set(package.verify_archive(output / manifest["archive"])["files"])
            for required in (
                "VERSION", "converter.py", "requirements.txt", "Dockerfile", ".dockerignore",
                "app/__init__.py", "app/gateway_management.py", "build-info.json",
                "web/dist/index.html", "web/dist/assets/app.js",
                "web/src/main.tsx", "web/package.json", "web/pnpm-lock.yaml",
                "web/vite.config.ts", "docker-compose.yml", "docker-compose.build.yaml",
                "pyproject.toml", "README.md", "LICENSE", ".env.example",
            ):
                with self.subTest(required=required):
                    self.assertIn(required, names)

    def test_denylist_excludes_secrets_data_and_agent_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            output = Path(directory) / "dist"
            manifest = build(root, output)
            names = set(package.verify_archive(output / manifest["archive"])["files"])
            for denied in (
                ".env", "auth/creds.info", "logs.sqlite3", "logs.sqlite3-wal",
                "converter.log", ".trellis/tasks/task.json", ".agents/skill.md",
                "AGENTS.md", "local.zip", "examples/demo.py", "docs/plans/plan.md",
                "web/node_modules/pkg/index.js", "web/.env",
                "web/test-results/report.json", "scripts/herdr-auto-yes.ps1",
                "web/.tmp-reference.mjs", "web/.tmp/visual.mjs", "web/.tmp-shots/home.png",
                "web/.venv-ci/bin/python", "web/playwright-report/index.html",
                "web/blob-report/report.json", "web/coverage/index.html",
                "web/e2e/-tmp-state/state.json", "web/.eslintcache",
            ):
                with self.subTest(denied=denied):
                    self.assertNotIn(denied, names)
            self.assertFalse(any(name.startswith("tests/") for name in names))

    def test_collect_files_skips_local_scaffolding_inside_web(self):
        # `web` is allowlisted as a whole tree, so scratch helpers and test
        # reports must be pruned per path part -- otherwise a local visual
        # harness would ship in the next source package.
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            files = package.collect_files(root)
            self.assertEqual(files, sorted(set(files)))
            for scratch in (
                "web/.tmp-reference.mjs",
                "web/.tmp/visual.mjs",
                "web/.tmp-shots/home.png",
                "web/.venv-ci/bin/python",
                "web/playwright-report/index.html",
                "web/blob-report/report.json",
                "web/coverage/index.html",
                "web/e2e/-tmp-state/state.json",
                "web/.eslintcache",
            ):
                with self.subTest(scratch=scratch):
                    self.assertNotIn(scratch, files)
            # Neighbouring real payload must survive the prefix rules.
            for kept in (
                "web/src/main.tsx",
                "web/dist/index.html",
                "web/package.json",
                "web/pnpm-lock.yaml",
                "web/e2e/login.spec.ts",
            ):
                with self.subTest(kept=kept):
                    self.assertIn(kept, files)

    def test_is_denied_predicate(self):
        for path in (".env", ".env.local", "auth/x", "db.sqlite3", "x.info", "x.log",
                     ".trellis/x", "web/node_modules/x", "output.zip", "a.ps1",
                     "web/.tmp-reference.mjs", "web/.tmp/x", "web/.tmp-shots/a.png",
                     "web/.venv-ci/bin/python", "web/playwright-report/index.html",
                     "web/blob-report/report.json", "web/e2e/-tmp-state/state.json",
                     "web/.eslintcache"):
            with self.subTest(path=path):
                self.assertTrue(package.is_denied(path))
        # Names that merely *contain* a scratch token stay in the package.
        for path in (".env.example", "web/dist/index.html", "app/main.py", "VERSION",
                     "docs/deployment.md", "web/src/tmp-helpers.ts",
                     "web/src/report-card.tsx", "web/src/coverage-notes.md",
                     "web/src/main.tsx"):
            with self.subTest(path=path):
                self.assertFalse(package.is_denied(path))

    def test_rebuild_is_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            first = build(root, Path(directory) / "dist-a")
            second = build(root, Path(directory) / "dist-b")
            self.assertEqual(first["archive"], second["archive"])
            self.assertEqual(first["sha256"], second["sha256"])

    def test_missing_console_bundle_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            (root / "web/dist/index.html").unlink()
            with self.assertRaises(package.PackageError):
                build(root, Path(directory) / "dist")

    def test_tag_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            with self.assertRaises(ValueError):
                build(root, Path(directory) / "dist", tag="v9.9.9")
            manifest = build(root, Path(directory) / "dist", tag="v1.2.3")
            self.assertEqual(manifest["tag"], "v1.2.3")

    def test_prerelease_manifest_and_options(self):
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo", version="1.4.0-rc.1")
            output = Path(directory) / "dist"
            manifest = build(root, output)
            self.assertTrue(manifest["prerelease"])
            options = package.write_publish_options(output)
            self.assertTrue(options["overlying"])
            self.assertTrue(options["preRelease"])
            self.assertFalse(options["latest"])
            self.assertEqual(options["descriptionFromFile"], "dist/release-notes.md")

    def test_stable_publish_options_mark_latest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            output = Path(directory) / "dist"
            build(root, output)
            options = package.write_publish_options(output)
            self.assertTrue(options["overlying"])
            self.assertFalse(options["preRelease"])
            self.assertTrue(options["latest"])

    def test_publish_options_use_only_verified_git_release_keys(self):
        # `git:release` has no `draft` (or any other) option beyond these five,
        # so nothing is invented to paper over the create-then-upload window.
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            output = Path(directory) / "dist"
            build(root, output)
            package.write_publish_options(output)
            options = json.loads((output / "cnb-release-options.json").read_text())
            self.assertEqual(
                set(options),
                {"overlying", "title", "descriptionFromFile", "preRelease", "latest"},
            )
            self.assertNotIn("draft", options)
            self.assertTrue(options["overlying"])
            self.assertEqual(options["descriptionFromFile"], "dist/release-notes.md")

    def test_safe_extraction_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            output = Path(directory) / "dist"
            manifest = build(root, output)
            destination = Path(directory) / "extracted"
            package.safe_extract(output / manifest["archive"], destination)
            prefix = destination / manifest["prefix"]
            self.assertTrue((prefix / "VERSION").is_file())
            self.assertTrue((prefix / "app/gateway_management.py").is_file())
            self.assertTrue((prefix / "web/dist/index.html").is_file())
            self.assertFalse((prefix / ".env").exists())
            # Everything stayed inside the destination directory.
            for path in destination.rglob("*"):
                self.assertTrue(path.resolve().is_relative_to(destination.resolve()))

    def test_traversal_member_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "evil.tar.gz"
            craft(archive, name="codebuddy2api-1.2.3/../../evil.txt")
            with self.assertRaises(package.UnsafeArchiveError):
                package.inspect_archive(archive)
            with self.assertRaises(package.UnsafeArchiveError):
                package.safe_extract(archive, Path(directory) / "out")

    def test_absolute_member_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ("/etc/passwd", "C:/Windows/win.ini"):
                archive = Path(directory) / "abs.tar.gz"
                craft(archive, name=name)
                with self.subTest(name=name), self.assertRaises(package.UnsafeArchiveError):
                    package.inspect_archive(archive)

    def test_link_member_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "link.tar.gz"
            craft(archive, name="codebuddy2api-1.2.3/link", symlink="/etc/passwd")
            with self.assertRaises(package.UnsafeArchiveError):
                package.safe_extract(archive, Path(directory) / "out")

    def test_checksum_mismatch_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            output = Path(directory) / "dist"
            manifest = build(root, output)
            checksum = output / f"{manifest['archive']}.sha256"
            checksum.write_text("0" * 64 + f"  {manifest['archive']}\n", encoding="utf-8")
            with self.assertRaises(package.PackageError):
                package.verify_archive(output / manifest["archive"])

    def test_verify_rejects_a_scratch_member_smuggled_into_the_archive(self):
        # The verifier re-applies the denylist, so a hand-built archive that
        # still carries a local scratch helper is rejected, not accepted.
        with tempfile.TemporaryDirectory() as directory:
            root = build_fixture(Path(directory) / "repo")
            output = Path(directory) / "dist"
            manifest = build(root, output)
            tampered = Path(directory) / "tampered.tar.gz"
            with tarfile.open(output / manifest["archive"]) as source, \
                    tarfile.open(tampered, "w:gz") as target:
                for member in source.getmembers():
                    target.addfile(member, source.extractfile(member))
                payload = b"import './src/main.tsx';\n"
                info = tarfile.TarInfo(f"{manifest['prefix']}/web/.tmp-reference.mjs")
                info.size = len(payload)
                target.addfile(info, io.BytesIO(payload))
            with self.assertRaises(package.PackageError) as caught:
                package.verify_archive(tampered)
            self.assertIn("denied", str(caught.exception))

    def test_corrupt_archive_is_rejected_cleanly(self):
        with tempfile.TemporaryDirectory() as directory:
            broken = Path(directory) / "broken.tar.gz"
            broken.write_bytes(b"not a gzip stream")
            with self.assertRaises(package.PackageError):
                package.inspect_archive(broken)
            with self.assertRaises(package.PackageError):
                package.safe_extract(broken, Path(directory) / "out")
            self.assertEqual(package.main(["--verify", str(broken)]), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
