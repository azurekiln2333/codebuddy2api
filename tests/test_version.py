"""Validate the authoritative version file and its derived release metadata."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import tempfile
import unittest
from unittest.mock import patch

import converter
from scripts import check_version


def write(path, text):
    Path(path).write_text(text, encoding="utf-8")


class VersionTests(unittest.TestCase):
    def test_application_uses_version_file(self):
        version = check_version.check_version()
        self.assertEqual(converter.APP_VERSION, version)
        self.assertEqual(converter.app.version, version)
        self.assertEqual(converter.app.openapi()["info"]["version"], version)

    def test_derived_release_tag(self):
        version = check_version.check_version()
        self.assertEqual(check_version.release_tag(version), f"v{version}")
        self.assertFalse(check_version.is_prerelease(version))

    def test_matching_tag_and_accepted_refs(self):
        version = check_version.check_version()
        self.assertEqual(check_version.check_version(f"refs/tags/v{version}"), version)
        for ref in ["refs/heads/main", "refs/heads/feature/x", "refs/pull/1/merge", ""]:
            with self.subTest(ref=ref):
                self.assertEqual(check_version.check_version(ref), version)

    def test_mismatched_tag_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "VERSION"
            write(path, "1.0.0\n")
            with patch.object(check_version, "VERSION_FILE", path):
                for ref in ["refs/tags/v1.0.1", "refs/tags/1.0.0", "refs/tags/v1.0.0-rc.1"]:
                    with self.subTest(ref=ref), self.assertRaises(ValueError):
                        check_version.check_version(ref)

    def test_prerelease_version_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "VERSION"
            write(path, "1.4.0-rc.1\n")
            with patch.object(check_version, "VERSION_FILE", path):
                version = check_version.check_version("refs/tags/v1.4.0-rc.1")
                self.assertEqual(version, "1.4.0-rc.1")
                self.assertTrue(check_version.is_prerelease(version))
                self.assertEqual(check_version.release_tag(version), "v1.4.0-rc.1")
                # A stable tag must not silently publish a prerelease version.
                with self.assertRaises(ValueError):
                    check_version.check_version("refs/tags/v1.4.0")

    def test_invalid_version_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "VERSION"
            with patch.object(check_version, "VERSION_FILE", path):
                for value in ["", "v1.0.0", "1.0", "01.0.0", "1.0.0-", "1.0.0-rc..1",
                              "1.0.0+build", "1.0.0\nrelease=true"]:
                    write(path, value)
                    with self.subTest(value=value), self.assertRaises(ValueError):
                        check_version.check_version()

    def test_pyproject_metadata_must_match_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_file = root / "VERSION"
            pyproject = root / "pyproject.toml"
            write(version_file, "1.2.3\n")
            write(pyproject, '[project]\nname = "x"\nversion = "1.2.3"\n')
            with patch.object(check_version, "VERSION_FILE", version_file), \
                    patch.object(check_version, "PYPROJECT_FILE", pyproject):
                self.assertEqual(check_version.check_version(check_pyproject=True), "1.2.3")
                write(pyproject, '[project]\nname = "x"\nversion = "1.2.4"\n')
                with self.assertRaises(ValueError):
                    check_version.check_version(check_pyproject=True)

    def test_compose_default_tag_is_neutral_or_current(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_file = root / "VERSION"
            compose = root / "docker-compose.yml"
            write(version_file, "1.2.3\n")
            allowed = [
                "${CODEBUDDY2API_IMAGE:-codebuddy2api:latest}",
                "codebuddy2api:1.2.3",
                "codebuddy2api:v1.2.3",
                "docker.cnb.cool/org/codebuddy2api:latest",
            ]
            rejected = [
                "${CODEBUDDY2API_IMAGE:-other:1.2.4}",
                "codebuddy2api:local",
                "${CODEBUDDY2API_IMAGE}",
                "codebuddy2api",
            ]
            with patch.object(check_version, "VERSION_FILE", version_file), \
                    patch.object(check_version, "COMPOSE_FILE", compose):
                for image in allowed:
                    write(compose, f"services:\n  codebuddy2api:\n    image: {image}\n")
                    with self.subTest(image=image):
                        self.assertEqual(check_version.check_version(check_compose=True), "1.2.3")
                for image in rejected:
                    write(compose, f"services:\n  codebuddy2api:\n    image: {image}\n")
                    with self.subTest(image=image), self.assertRaises(ValueError):
                        check_version.check_version(check_compose=True)

    def test_repository_version_contract_holds(self):
        version = check_version.check_version(check_pyproject=True, check_compose=True)
        self.assertEqual(version, (Path(__file__).resolve().parents[1] / "VERSION").read_text().strip())


if __name__ == "__main__":
    unittest.main(verbosity=2)